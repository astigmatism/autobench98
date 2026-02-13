// services/orchestrator/src/devices/ps2-keyboard/PS2KeyboardService.ts

/* -------------------------------------------------------------------------- */
/*  PS2KeyboardService                                                        */
/*                                                                            */
/*  Responsibilities:                                                         */
/*  - Own the serial port for the PS/2 keyboard Arduino                        */
/*  - Manage identification + reconnect lifecycle                              */
/*  - Provide a rich, interruptible operation queue                            */
/*  - Translate high-level keyboard intents into Arduino commands              */
/*  - Emit domain events for logging + AppState adapters                       */
/*                                                                            */
/*  Non-responsibilities:                                                     */
/*  - No AppState mutation                                                     */
/*  - No WebSocket handling                                                    */
/*  - No pane knowledge                                                        */
/* -------------------------------------------------------------------------- */

import { SerialPort } from 'serialport'
import type {
  PS2KeyboardConfig,
  PS2KeyboardEventSink,
  KeyboardDevicePhase,
  KeyboardPowerState,
  KeyboardError,
  KeyboardAction,
  KeyboardOperationKind,
  KeyboardOperationHandle,
  KeyboardOperationResult,
  KeyboardInvokeTuning,
  KeyboardOperationSummary,
  PS2ScanCode,
  ClientKeyboardEvent,
  KeyIdentity,
} from './types'
import { lookupScanCode } from './scancodes'
import { sleep, now, makeOpId, formatWireScanCode } from './utils'

/* -------------------------------------------------------------------------- */
/*  Internal operation model                                                  */
/* -------------------------------------------------------------------------- */

interface QueuedOp {
  id: string
  kind: KeyboardOperationKind
  createdAt: number
  startedAt?: number
  requestedBy?: string
  label?: string
  tuning?: Partial<KeyboardInvokeTuning>

  execute: () => Promise<void>

  resolve: (res: KeyboardOperationResult) => void
  reject: (res: KeyboardOperationResult) => void
}

type DisconnectReason = 'io-error' | 'explicit-close' | 'unknown' | 'device-lost'

/* -------------------------------------------------------------------------- */
/*  Cancellation                                                              */
/* -------------------------------------------------------------------------- */

class CancelledError extends Error {
  public readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.name = 'CancelledError'
    this.reason = reason
  }
}

/* -------------------------------------------------------------------------- */

export class PS2KeyboardService {
  private readonly cfg: PS2KeyboardConfig
  private readonly events: PS2KeyboardEventSink

  private deviceId: string | null = null
  private devicePath: string | null = null

  private port: SerialPort | null = null
  private phase: KeyboardDevicePhase = 'disconnected'

  /**
   * "power" here represents keyboard-side power control (Arduino command),
   * NOT the host PC power sense. Host power is tracked separately via hostPower.
   *
   * IMPORTANT: keyboard-side power is now driven ONLY by hostPower (AppState/frontPanel).
   * Any external attempt to toggle keyboard-side power is deprecated (see powerOn/powerOff).
   */
  private power: KeyboardPowerState = 'unknown'

  /**
   * Host PC power state (sourced from frontPanel powerSense by the plugin).
   *
   * Decisions you made:
   * - hostPower='unknown' => fail-open for key ops
   * - hostPower='off' => drop (cancel) queued key ops
   *
   * Additionally:
   * - hostPower='on'/'off' => drive keyboard-side "power_on/power_off" pin state (when ready)
   */
  private hostPower: KeyboardPowerState = 'unknown'

  private identified = false

  private queue: QueuedOp[] = []
  private activeOp: QueuedOp | null = null

  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null

  // Used for parsing inbound serial into lines (debug/telemetry) safely.
  private readBuffer = ''

  /**
   * Identify safety fix:
   * Avoid races between a temporary readLine() data listener and the permanent handleData listener.
   * We route *all* inbound lines through handleData, and (until identified) we also feed them
   * into a small FIFO that identify() can consume deterministically.
   */
  private pendingLines: string[] = []
  private pendingLineWaiters: Array<{
    resolve: (line: string) => void
    reject: (err: Error) => void
    timer: NodeJS.Timeout
  }> = []
  private static readonly MAX_PENDING_LINES = 256

  // Only track modifier keys as "held" for logging semantics.
  private heldModifiers = new Set<string>()

  // --- Strict lifecycle guards (prevents lock races / unhandled rejections) ---
  private stopping = false
  private openInFlight: Promise<void> | null = null

  /**
   * When we close a port intentionally, serialport will still emit 'close'.
   * Ignore that close event so we don't double-close or double-reconnect.
   */
  private closingPort: SerialPort | null = null
  // --------------------------------------------------------------------------

  /**
   * Active-op cancellation is modeled as a precise (opId, reason) pair
   * so we do not accidentally cancel future operations.
   */
  private activeCancel: { opId: string; reason: string } | null = null

  // Modifier identification is intentionally explicit and conservative.
  private static readonly MODIFIER_CODES = new Set<string>([
    'ShiftLeft',
    'ShiftRight',
    'ControlLeft',
    'ControlRight',
    'AltLeft',
    'AltRight',
    'MetaLeft',
    'MetaRight',
  ])

  constructor(cfg: PS2KeyboardConfig, deps: { events: PS2KeyboardEventSink }) {
    this.cfg = cfg
    this.events = deps.events
  }

  /* ---------------------------------------------------------------------- */
  /*  Host power integration (called by plugin)                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Update host power state as observed by the front panel service.
   *
   * Semantics:
   * - 'unknown' => do not then block key ops (fail-open)
   * - 'off' => cancel queued key operations; active key op is cancelled best-effort
   *
   * ALSO:
   * - When the device is ready, hostPower('on'/'off') is mirrored to keyboard-side
   *   "power_on"/"power_off" so the Arduino can raise/lower its power pin (e.g. pin 5)
   *   to inform downstream PS/2 devices (mouse) about host power state.
   */
  public setHostPower(power: KeyboardPowerState): void {
    if (power === this.hostPower) return

    const prev = this.hostPower
    this.hostPower = power

    // On transition into a known OFF state: drop queued key ops.
    if (power === 'off' && prev !== 'off') {
      this.cancelQueuedKeyOps('host-power-off')
      // If a key op is currently active, request cancellation.
      if (this.activeOp && this.isKeyOpKind(this.activeOp.kind)) {
        this.requestCancelActiveOp('host-power-off')
      }
    }

    // Mirror host power to keyboard-side power (when ready).
    // This is intentionally fire-and-forget (queued), since setHostPower is synchronous.
    this.maybeSyncKeyboardSidePowerFromHostPower('app-state')
  }

  public getHostPower(): KeyboardPowerState {
    return this.hostPower
  }

  /* ---------------------------------------------------------------------- */
  /*  Lifecycle (called by Fastify plugin)                                   */
  /* ---------------------------------------------------------------------- */

  public async start(): Promise<void> {
    // No-op; lifecycle is discovery-driven
    this.stopping = false
  }

  public async stop(): Promise<void> {
    this.stopping = true
    this.clearReconnectTimer()

    // Cancel everything (key or non-key) to avoid hanging "done" promises.
    this.cancelAll('service-stopping')

    // If an open attempt is in flight, wait for it to settle before closing.
    try {
      await this.openInFlight
    } catch {
      /* ignore */
    }

    await this.closePort('explicit-close')

    this.queue.length = 0
    this.activeOp = null
    this.phase = 'disconnected'
    this.identified = false
    this.power = 'unknown'
    this.hostPower = 'unknown'
    this.heldModifiers.clear()
    this.readBuffer = ''
    this.activeCancel = null

    this.failAllPendingLineWaiters(new Error('service stopping'))
    this.pendingLines = []
  }

  /* ---------------------------------------------------------------------- */
  /*  Discovery-driven lifecycle                                             */
  /* ---------------------------------------------------------------------- */

  public async onDeviceIdentified(args: {
    id: string
    path: string
    baudRate?: number
  }): Promise<void> {
    this.deviceId = args.id
    this.devicePath = args.path

    this.events.publish({
      kind: 'keyboard-device-identified',
      at: now(),
      id: args.id,
      path: args.path,
      baudRate: args.baudRate ?? this.cfg.baudRate,
    })

    if (this.stopping) return

    // If already open and identified, nothing to do.
    if (this.port && this.port.isOpen && this.identified) return

    await this.openPort(args.baudRate ?? this.cfg.baudRate)
  }

  public async onDeviceLost(args: { id: string }): Promise<void> {
    if (this.deviceId !== args.id) return

    this.clearReconnectTimer()
    await this.closePort('device-lost')

    // Prevent reconnect from firing until discovery re-identifies.
    this.deviceId = null
    this.devicePath = null

    this.events.publish({
      kind: 'keyboard-device-lost',
      at: now(),
      id: args.id,
    })
  }

  /* ---------------------------------------------------------------------- */
  /*  Public API (used by WS plugin)                                         */
  /* ---------------------------------------------------------------------- */

  public enqueueKeyEvent(evt: ClientKeyboardEvent): KeyboardOperationHandle {
    const scan = this.resolveScanCode(evt)
    if (!scan) {
      // Surface as a recoverable error for observability (and UI error history).
      this.events.publish({
        kind: 'recoverable-error',
        at: now(),
        error: {
          at: now(),
          scope: 'protocol',
          message: `Unsupported key: ${evt.code ?? evt.key ?? 'unknown'}`,
          retryable: false,
        },
      })

      return this.failFastHandle(
        'press',
        `Unsupported key: ${evt.code ?? evt.key ?? 'unknown'}`
      )
    }

    const kind: KeyboardOperationKind =
      evt.action === 'press'
        ? 'press'
        : evt.action === 'hold'
        ? 'hold'
        : 'release'

    return this.enqueueOperation(kind, {
      requestedBy: evt.requestedBy,
      tuning: evt.overrides,
      label: `${evt.action} ${evt.code ?? evt.key ?? ''}`,
      execute: async () => {
        await this.ensureReady()
        // Enforce host-power policy at the lowest level that sends key bytes.
        this.assertKeyOpsAllowed()
        await this.sendAction(evt.action, scan, {
          code: evt.code,
          key: evt.key,
          requestedBy: evt.requestedBy,
        })
      },
    })
  }

  /**
   * @deprecated Keyboard-side power is now derived exclusively from hostPower
   * (front panel powerSense -> AppState -> plugin -> setHostPower()).
   *
   * This method is intentionally non-operative to prevent divergence between
   * authoritative host power and keyboard-side power pin state.
   */
  public powerOn(requestedBy?: string): KeyboardOperationHandle {
    this.publishDeprecatedPowerUse('powerOn', requestedBy)
    return this.immediateCancelledHandle('powerOn', 'deprecated')
  }

  /**
   * @deprecated Keyboard-side power is now derived exclusively from hostPower
   * (front panel powerSense -> AppState -> plugin -> setHostPower()).
   *
   * This method is intentionally non-operative to prevent divergence between
   * authoritative host power and keyboard-side power pin state.
   */
  public powerOff(requestedBy?: string): KeyboardOperationHandle {
    this.publishDeprecatedPowerUse('powerOff', requestedBy)
    return this.immediateCancelledHandle('powerOff', 'deprecated')
  }

  /**
   * Cancel all queued + active operations (any kind), settling their promises.
   * This is used for explicit user cancels and service shutdown.
   */
  public cancelAll(reason = 'cancelled'): void {
    // Cancel queued ops and settle their promises immediately.
    const queued = this.queue.splice(0, this.queue.length)
    for (const op of queued) {
      this.publishCancelled(op, reason)
      op.resolve(this.makeCancellationResult(op, reason))
    }

    // Request cancellation for the active op (best-effort).
    // (Do not publish here; processQueue will publish exactly once when the op aborts.)
    if (this.activeOp) {
      this.requestCancelActiveOp(reason)
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Queue handling                                                         */
  /* ---------------------------------------------------------------------- */

  private enqueueOperation(
    kind: KeyboardOperationKind,
    opts: {
      execute: () => Promise<void>
      requestedBy?: string
      label?: string
      tuning?: Partial<KeyboardInvokeTuning>
    }
  ): KeyboardOperationHandle {
    const id = makeOpId('kb')
    const createdAt = now()

    let resolve!: (res: KeyboardOperationResult) => void
    let reject!: (res: KeyboardOperationResult) => void

    const done = new Promise<KeyboardOperationResult>((res, rej) => {
      resolve = res
      reject = rej
    })

    const op: QueuedOp = {
      id,
      kind,
      createdAt,
      requestedBy: opts.requestedBy,
      label: opts.label,
      tuning: opts.tuning,
      execute: opts.execute,
      resolve,
      reject,
    }

    // If host is *known* off, cancel key ops immediately (fail-open for 'unknown').
    if (this.isKeyOpKind(kind) && this.hostPower === 'off') {
      this.events.publish({
        kind: 'keyboard-operation-queued',
        at: createdAt,
        op: this.summarize(op, 'queued'),
      })
      this.publishCancelled(op, 'host-power-off')
      resolve(this.makeCancellationResult(op, 'host-power-off'))
      return { id, kind, createdAt, done }
    }

    this.queue.push(op)

    this.events.publish({
      kind: 'keyboard-operation-queued',
      at: createdAt,
      op: this.summarize(op, 'queued'),
    })

    this.processQueue().catch(() => {
      /* errors emitted elsewhere */
    })

    return { id, kind, createdAt, done }
  }

  private async processQueue(): Promise<void> {
    if (this.activeOp || this.queue.length === 0) return

    const op = this.queue.shift()!
    this.activeOp = op

    // If host is *known* off at start time, cancel key ops without executing.
    if (this.isKeyOpKind(op.kind) && this.hostPower === 'off') {
      this.publishCancelled(op, 'host-power-off')
      op.resolve(this.makeCancellationResult(op, 'host-power-off'))
      this.activeOp = null
      void this.processQueue()
      return
    }

    op.startedAt = now()

    this.events.publish({
      kind: 'keyboard-operation-started',
      at: op.startedAt,
      opId: op.id,
    })

    try {
      await op.execute()

      const result: KeyboardOperationResult = {
        id: op.id,
        kind: op.kind,
        status: 'completed',
        startedAt: op.startedAt,
        endedAt: now(),
      }

      op.resolve(result)

      this.events.publish({
        kind: 'keyboard-operation-completed',
        at: now(),
        result,
      })
    } catch (err) {
      // Treat explicit cancellations as cancellations (not failures).
      if (err instanceof CancelledError) {
        this.publishCancelled(op, err.reason)
        op.resolve(this.makeCancellationResult(op, err.reason))
      } else {
        const error = this.toErrorWithScope('unknown', err)

        const result: KeyboardOperationResult = {
          id: op.id,
          kind: op.kind,
          status: 'failed',
          startedAt: op.startedAt,
          endedAt: now(),
          error,
        }

        op.reject(result)

        this.events.publish({
          kind: 'keyboard-operation-failed',
          at: now(),
          result,
        })
      }
    } finally {
      // Clear cancellation request once the active op is done.
      if (this.activeCancel?.opId === op.id) {
        this.activeCancel = null
      }

      this.activeOp = null
      await sleep(this.cfg.tuning.interCommandDelayMs)
      void this.processQueue()
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Serial handling                                                        */
  /* ---------------------------------------------------------------------- */

  private async openPort(baudRate: number): Promise<void> {
    const devicePath = this.devicePath
    if (!devicePath) return
    if (this.stopping) return

    // Ensure only one open attempt runs at a time.
    if (this.openInFlight) return this.openInFlight

    // Any explicit open attempt should cancel pending reconnect timers.
    this.clearReconnectTimer()

    this.openInFlight = (async () => {
      // If we still have a port object around, close it first to avoid lock races.
      if (this.port?.isOpen) {
        await this.closePort('unknown')
      }

      this.phase = 'connecting'
      this.identified = false

      // New connection => keyboard-side power state is not known until we re-assert.
      this.power = 'unknown'

      // Reset identify line FIFO for the new connection.
      this.failAllPendingLineWaiters(new Error('superseded by new connection'))
      this.pendingLines = []

      const port = new SerialPort({
        path: devicePath,
        baudRate,
        autoOpen: false,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
      })

      try {
        await new Promise<void>((resolve, reject) => {
          port.once('open', resolve)
          port.once('error', reject)
          port.open()
        })
      } catch (err) {
        this.phase = 'error'
        this.events.publish({
          kind: 'recoverable-error',
          at: now(),
          error: this.toErrorWithScope('open', err, true),
        })
        this.scheduleReconnect()
        return
      }

      if (this.stopping) {
        this.closingPort = port
        await new Promise<void>((resolve) => port.close(() => resolve()))
        this.closingPort = null
        return
      }

      this.port = port
      this.reconnectAttempts = 0
      this.readBuffer = ''
      this.heldModifiers.clear()

      this.events.publish({
        kind: 'keyboard-device-connected',
        at: now(),
        path: devicePath,
        baudRate,
      })

      port.on('data', (buf) => this.handleData(buf.toString('utf8')))
      port.on('error', (err) => this.handlePortError(port, err))
      port.on('close', () => this.handlePortClose(port))

      try {
        await this.identify()
      } catch {
        await this.closePort('unknown')
        this.scheduleReconnect()
      }
    })().finally(() => {
      this.openInFlight = null
    })

    return this.openInFlight
  }

  private async closePort(reason: DisconnectReason): Promise<void> {
    const port = this.port
    const path = this.devicePath ?? 'unknown'

    // Fail any identify waiters promptly so identify() can't hang until timeout.
    this.failAllPendingLineWaiters(new Error(`port closed: ${reason}`))
    this.pendingLines = []

    this.port = null
    this.identified = false
    this.phase = 'disconnected'
    this.heldModifiers.clear()
    this.readBuffer = ''

    // Port is gone => we can no longer claim keyboard-side pin state.
    this.power = 'unknown'

    if (port && port.isOpen) {
      this.closingPort = port
      await new Promise<void>((resolve) => port.close(() => resolve()))
      this.closingPort = null
    }

    if (this.devicePath || port) {
      this.events.publish({
        kind: 'keyboard-device-disconnected',
        at: now(),
        path,
        reason,
      })
    }
  }

  private async identify(): Promise<void> {
    if (!this.port) return

    this.phase = 'identifying'
    this.events.publish({
      kind: 'keyboard-identify-start',
      at: now(),
      path: this.devicePath ?? 'unknown',
    })

    const request = this.cfg.identify.request
    const completion = this.cfg.identify.completion
    const expected = this.cfg.expectedIdToken
    const timeoutMs = this.cfg.identify.timeoutMs

    // Conservative retry: some Arduino boards reset on serial open; first request can be missed.
    // Use a small number of attempts but within the same overall timeout.
    const attempts = 2
    const overallDeadline = now() + timeoutMs
    let lastErr: unknown = null

    try {
      let token: string | null = null

      for (let attempt = 1; attempt <= attempts; attempt++) {
        const remainingOverall = overallDeadline - now()
        if (remainingOverall <= 0) break

        // Write identify request (may be ignored if device is still booting).
        await this.writeLine(request)

        // Budget per-attempt wait; last attempt gets all remaining time.
        const perAttemptMs =
          attempt === attempts
            ? remainingOverall
            : Math.min(
                750,
                Math.max(150, Math.floor(remainingOverall / (attempts - attempt + 1)))
              )

        try {
          token = await this.readForExpectedToken(expected, perAttemptMs)
          break
        } catch (err) {
          lastErr = err
          // Continue to next attempt if time remains.
        }
      }

      if (!token) {
        throw (lastErr ?? new Error('identify timeout')) as any
      }

      await this.writeLine(completion)
      this.identified = true
      this.phase = 'ready'

      this.events.publish({
        kind: 'keyboard-identify-success',
        at: now(),
        token,
      })

      // Device is now ready: mirror host power to keyboard-side pin state if host power is known.
      this.maybeSyncKeyboardSidePowerFromHostPower('app-state')
    } catch (err) {
      this.identified = false
      this.phase = 'error'

      this.events.publish({
        kind: 'keyboard-identify-failed',
        at: now(),
        error: this.toErrorWithScope('identify', err, true),
      })

      throw err
    }
  }

  private async writeLine(line: string): Promise<void> {
    // Best-effort: if the active op has been cancelled, abort before writing.
    this.assertActiveOpNotCancelled()

    if (!this.port || !this.port.isOpen) {
      throw new Error('port not open')
    }

    await new Promise<void>((resolve, reject) => {
      this.port!.write(`${line}${this.cfg.identify.writeLineEnding}`, (err) =>
        err ? reject(err) : resolve()
      )
    })
  }

  /**
   * Read lines from the FIFO until the expected token appears or timeout elapses.
   * Ignores debug/noise lines conservatively (same semantics as prior readLine()).
   */
  private async readForExpectedToken(expected: string, timeoutMs: number): Promise<string> {
    const deadline = now() + Math.max(0, Math.trunc(timeoutMs))
    let lastNonNoise: string | null = null

    while (true) {
      const remaining = deadline - now()
      if (remaining <= 0) {
        const suffix = lastNonNoise ? ` (last=${lastNonNoise})` : ''
        throw new Error(`identify timeout${suffix}`)
      }

      const raw = await this.takeNextLine(remaining)
      const line = raw.trim()
      if (!line) continue

      // Keep identify resilient: ignore firmware chatter that is not the token.
      if (line.startsWith('debug:')) continue
      if (line.startsWith('done:')) continue

      lastNonNoise = line

      if (line === expected) return line

      // Not expected; keep scanning within the same deadline.
    }
  }

  /**
   * Take the next parsed line from the FIFO, waiting up to timeoutMs.
   * This avoids a race where identify responses arrive before a temporary on('data') listener is attached.
   */
  private takeNextLine(timeoutMs: number): Promise<string> {
    const immediate = this.pendingLines.shift()
    if (immediate != null) return Promise.resolve(immediate)

    const t = Math.max(0, Math.trunc(timeoutMs))

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this waiter if still present.
        const idx = this.pendingLineWaiters.findIndex((w) => w.resolve === resolve)
        if (idx >= 0) this.pendingLineWaiters.splice(idx, 1)
        reject(new Error('identify timeout'))
      }, t)

      this.pendingLineWaiters.push({ resolve, reject, timer })
    })
  }

  private enqueuePendingLine(line: string): void {
    const waiter = this.pendingLineWaiters.shift()
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resolve(line)
      return
    }

    this.pendingLines.push(line)
    if (this.pendingLines.length > PS2KeyboardService.MAX_PENDING_LINES) {
      // Drop oldest to bound memory; identify will still succeed if token arrives.
      this.pendingLines.shift()
    }
  }

  private failAllPendingLineWaiters(err: Error): void {
    const waiters = this.pendingLineWaiters.splice(0, this.pendingLineWaiters.length)
    for (const w of waiters) {
      clearTimeout(w.timer)
      try {
        w.reject(err)
      } catch {
        /* ignore */
      }
    }
  }

  private handleData(chunk: string): void {
    this.readBuffer += chunk
    const lines = this.readBuffer.split(/\r?\n/)
    this.readBuffer = lines.pop() ?? ''

    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue

      // Feed identify FIFO until identified, so identify() cannot miss an early token response.
      if (!this.identified) {
        this.enqueuePendingLine(line)
      }

      this.events.publish({
        kind: 'keyboard-debug-line',
        at: now(),
        line,
      })
    }
  }

  private handlePortError(port: SerialPort, err: Error): void {
    if (port !== this.port) return
    if (this.closingPort === port) return

    void (async () => {
      this.events.publish({
        kind: 'recoverable-error',
        at: now(),
        error: this.toErrorWithScope('read', err, true),
      })
      await this.closePort('io-error')
      this.scheduleReconnect()
    })()
  }

  private handlePortClose(port: SerialPort): void {
    if (this.closingPort === port) return
    if (port !== this.port) return

    void (async () => {
      await this.closePort('io-error')
      this.scheduleReconnect()
    })()
  }

  private scheduleReconnect(): void {
    if (this.stopping) return
    if (!this.cfg.reconnect.enabled) return
    if (!this.devicePath) return

    this.clearReconnectTimer()

    if (
      this.cfg.reconnect.maxAttempts > 0 &&
      this.reconnectAttempts >= this.cfg.reconnect.maxAttempts
    ) {
      this.events.publish({
        kind: 'fatal-error',
        at: now(),
        error: this.toErrorWithScope('open', 'reconnect attempts exhausted', false),
      })
      return
    }

    this.reconnectAttempts++
    const delay = Math.min(
      this.cfg.reconnect.baseDelayMs * 2 ** (this.reconnectAttempts - 1),
      this.cfg.reconnect.maxDelayMs
    )

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopping) return
      if (!this.devicePath) return
      void this.openPort(this.cfg.baudRate)
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  private async ensureReady(): Promise<void> {
    if (!this.port || !this.port.isOpen) throw new Error('port not open')
    if (!this.identified) throw new Error('device not identified')
    this.assertActiveOpNotCancelled()
  }

  private resolveScanCode(evt: ClientKeyboardEvent): PS2ScanCode | null {
    if (evt.code) return lookupScanCode(evt.code)
    return null
  }

  private isModifier(identity: KeyIdentity): boolean {
    return !!identity.code && PS2KeyboardService.MODIFIER_CODES.has(identity.code)
  }

  private tokenFor(identity: KeyIdentity, scan: PS2ScanCode): string {
    if (identity.code) return identity.code
    const prefix = scan.prefix ?? 0x00
    return `${prefix.toString(16).padStart(2, '0')}:${scan.code
      .toString(16)
      .padStart(2, '0')}`
  }

  private modsSnapshot(): string[] {
    return Array.from(this.heldModifiers).sort()
  }

  private async sendAction(
    action: KeyboardAction,
    scan: PS2ScanCode,
    meta?: { code?: string; key?: string; requestedBy?: string }
  ): Promise<void> {
    this.assertActiveOpNotCancelled()

    const wire = `${action} ${formatWireScanCode(scan.prefix, scan.code)}`
    await this.writeLine(wire)

    const identity: KeyIdentity = { code: meta?.code, key: meta?.key }
    const token = this.tokenFor(identity, scan)
    const isMod = this.isModifier(identity)

    if (isMod) {
      if (action === 'hold') this.heldModifiers.add(token)
      if (action === 'release') this.heldModifiers.delete(token)

      this.events.publish({
        kind: 'keyboard-key-action',
        at: now(),
        action,
        identity,
        scan,
        wire,
        opId: this.activeOp?.id,
        requestedBy: meta?.requestedBy ?? this.activeOp?.requestedBy,
      })
      return
    }

    if (action === 'release') return

    const logicalAction: KeyboardAction = action === 'hold' ? 'press' : action

    this.events.publish({
      kind: 'keyboard-key-action',
      at: now(),
      action: logicalAction,
      identity,
      scan,
      wire,
      mods: this.modsSnapshot(),
      opId: this.activeOp?.id,
      requestedBy: meta?.requestedBy ?? this.activeOp?.requestedBy,
    })
  }

  private summarize(
    op: QueuedOp,
    status: KeyboardOperationSummary['status']
  ): KeyboardOperationSummary {
    return {
      id: op.id,
      kind: op.kind,
      status,
      createdAt: op.createdAt,
      requestedBy: op.requestedBy,
      label: op.label,
    }
  }

  private failFastHandle(
    kind: KeyboardOperationKind,
    message: string
  ): KeyboardOperationHandle {
    const id = makeOpId('kb')
    const createdAt = now()
    const error: KeyboardError = {
      at: now(),
      scope: 'protocol',
      message,
      retryable: false,
    }

    const done = Promise.resolve({
      id,
      kind,
      status: 'failed' as const,
      createdAt,
      endedAt: now(),
      error,
    } as unknown as KeyboardOperationResult)

    return { id, kind, createdAt, done }
  }

  private toErrorWithScope(
    scope: KeyboardError['scope'],
    err: unknown,
    retryable?: boolean
  ): KeyboardError {
    if (typeof err === 'string') return { at: now(), scope, message: err, retryable }
    if (err instanceof Error) return { at: now(), scope, message: err.message, retryable }
    return { at: now(), scope, message: 'unknown error', retryable }
  }

  /* ---------------------------------------------------------------------- */
  /*  Host-power policy helpers                                              */
  /* ---------------------------------------------------------------------- */

  private isKeyOpKind(kind: KeyboardOperationKind): boolean {
    return kind === 'press' || kind === 'hold' || kind === 'release'
  }

  private isPowerOpKind(kind: KeyboardOperationKind): boolean {
    return kind === 'powerOn' || kind === 'powerOff'
  }

  private assertKeyOpsAllowed(): void {
    // Fail-open for 'unknown' is implemented by only blocking on exact 'off'.
    if (this.hostPower === 'off') throw new CancelledError('host-power-off')
  }

  /**
   * Mirror hostPower -> keyboard-side "power_on"/"power_off" (pin state) when possible.
   * If device is not ready yet, we do nothing; identify() will call this once ready.
   */
  private maybeSyncKeyboardSidePowerFromHostPower(requestedBy: string): void {
    const desired = this.hostPower
    if (desired !== 'on' && desired !== 'off') return

    // Only attempt when device is actually ready; otherwise we'd just fail ops noisily.
    if (!this.port || !this.port.isOpen || !this.identified) return

    if (this.power === desired) return

    // Coalesce queued power ops so last-known host state wins.
    this.cancelQueuedPowerOps('host-power-change')
    if (this.activeOp && this.isPowerOpKind(this.activeOp.kind)) {
      this.requestCancelActiveOp('host-power-change')
    }

    this.enqueueKeyboardSidePower(desired, requestedBy)
  }

  private enqueueKeyboardSidePower(desired: 'on' | 'off', requestedBy: string): void {
    const kind: KeyboardOperationKind = desired === 'on' ? 'powerOn' : 'powerOff'
    const wire = desired === 'on' ? 'power_on' : 'power_off'

    this.enqueueOperation(kind, {
      requestedBy,
      label: `hostPower -> keyboard ${wire}`,
      execute: async () => {
        await this.ensureReady()
        await this.writeLine(wire)
        this.power = desired
        this.events.publish({
          kind: 'keyboard-power-changed',
          at: now(),
          power: desired,
          requestedBy,
        })
      },
    })
  }

  private cancelQueuedPowerOps(reason: string): void {
    if (this.queue.length === 0) return

    const keep: QueuedOp[] = []
    for (const op of this.queue) {
      if (this.isPowerOpKind(op.kind)) {
        this.publishCancelled(op, reason)
        op.resolve(this.makeCancellationResult(op, reason))
      } else {
        keep.push(op)
      }
    }
    this.queue = keep
  }

  /* ---------------------------------------------------------------------- */
  /*  Deprecated power entrypoints                                           */
  /* ---------------------------------------------------------------------- */

  private publishDeprecatedPowerUse(
    method: 'powerOn' | 'powerOff',
    requestedBy?: string
  ): void {
    this.events.publish({
      kind: 'recoverable-error',
      at: now(),
      error: {
        at: now(),
        scope: 'protocol',
        retryable: false,
        message:
          `Deprecated: PS2KeyboardService.${method}() was called` +
          ` (requestedBy=${requestedBy ?? 'unknown'}). ` +
          `Keyboard-side power is now driven by hostPower (front panel powerSense -> AppState -> setHostPower).`,
      },
    })
  }

  private immediateCancelledHandle(
    kind: KeyboardOperationKind,
    reason: string
  ): KeyboardOperationHandle {
    const id = makeOpId('kb')
    const createdAt = now()
    const result: KeyboardOperationResult = {
      id,
      kind,
      status: 'cancelled',
      startedAt: createdAt,
      endedAt: now(),
      reason,
    }
    return { id, kind, createdAt, done: Promise.resolve(result) }
  }

  /* ---------------------------------------------------------------------- */
  /*  Cancellation helpers                                                   */
  /* ---------------------------------------------------------------------- */

  private requestCancelActiveOp(reason: string): void {
    if (!this.activeOp) return
    this.activeCancel = { opId: this.activeOp.id, reason }
  }

  private assertActiveOpNotCancelled(): void {
    const active = this.activeOp
    const cancel = this.activeCancel
    if (!active || !cancel) return
    if (cancel.opId !== active.id) return
    throw new CancelledError(cancel.reason)
  }

  private cancelQueuedKeyOps(reason: string): void {
    if (this.queue.length === 0) return

    const keep: QueuedOp[] = []
    for (const op of this.queue) {
      if (this.isKeyOpKind(op.kind)) {
        this.publishCancelled(op, reason)
        op.resolve(this.makeCancellationResult(op, reason))
      } else {
        keep.push(op)
      }
    }
    this.queue = keep
  }

  private publishCancelled(op: QueuedOp, reason: string): void {
    this.events.publish({
      kind: 'keyboard-operation-cancelled',
      at: now(),
      opId: op.id,
      reason,
    })
  }

  private makeCancellationResult(op: QueuedOp, reason: string): KeyboardOperationResult {
    return {
      id: op.id,
      kind: op.kind,
      status: 'cancelled',
      startedAt: op.startedAt,
      endedAt: now(),
      reason,
    }
  }
}
