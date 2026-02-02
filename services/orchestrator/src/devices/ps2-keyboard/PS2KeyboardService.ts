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

// Message bus (orchestrator-internal)
// NOTE: This import assumes the bus lives at services/orchestrator/src/core/events.
// If your repo uses a different root, adjust this relative path.
import type { Bus, Subscription, BusEvent } from '../../core/events'

/* -------------------------------------------------------------------------- */
/*  Internal operation model                                                   */
/* -------------------------------------------------------------------------- */

interface QueuedOp {
  id: string
  kind: KeyboardOperationKind
  createdAt: number
  requestedBy?: string
  label?: string
  tuning?: Partial<KeyboardInvokeTuning>

  execute: () => Promise<void>

  resolve: (res: KeyboardOperationResult) => void
  reject: (res: KeyboardOperationResult) => void
}

type DisconnectReason = 'io-error' | 'explicit-close' | 'unknown' | 'device-lost'

/* -------------------------------------------------------------------------- */
/*  Front panel -> bus contract (coordination only)                            */
/* -------------------------------------------------------------------------- */

type FrontPanelPowerState = 'on' | 'off' | 'unknown'

interface FrontPanelPowerPayload {
  state: FrontPanelPowerState
  reason?: string
}

function parseFrontPanelPowerPayload(payload: unknown): FrontPanelPowerPayload | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const state = p.state
  if (state !== 'on' && state !== 'off' && state !== 'unknown') return null
  const reason = typeof p.reason === 'string' ? p.reason : undefined
  return { state, reason }
}

function toKeyboardPowerState(s: FrontPanelPowerState): KeyboardPowerState {
  // Safety: unknown is treated conservatively as off-equivalent for gating.
  if (s === 'on') return 'on'
  if (s === 'off') return 'off'
  return 'unknown'
}

/* -------------------------------------------------------------------------- */

export class PS2KeyboardService {
  private readonly cfg: PS2KeyboardConfig
  private readonly events: PS2KeyboardEventSink
  private readonly bus?: Bus

  private deviceId: string | null = null
  private devicePath: string | null = null

  private port: SerialPort | null = null
  private phase: KeyboardDevicePhase = 'disconnected'
  private power: KeyboardPowerState = 'unknown'
  private identified = false

  private queue: QueuedOp[] = []
  private activeOp: QueuedOp | null = null
  private cancelled = false

  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null

  // Used for parsing inbound serial into lines (debug/telemetry) safely.
  private readBuffer = ''

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

  // Message bus subscription + pending power state (bus is stateless; this is local coordination only)
  private powerSub: Subscription | null = null
  private pendingPowerFromFrontPanel: FrontPanelPowerState | null = null

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

  constructor(cfg: PS2KeyboardConfig, deps: { events: PS2KeyboardEventSink; bus?: Bus }) {
    this.cfg = cfg
    this.events = deps.events
    this.bus = deps.bus
  }

  /* ---------------------------------------------------------------------- */
  /*  Lifecycle (called by Fastify plugin)                                   */
  /* ---------------------------------------------------------------------- */

  public async start(): Promise<void> {
    this.stopping = false
    this.attachFrontPanelPowerSubscription()
  }

  public async stop(): Promise<void> {
    this.stopping = true
    this.clearReconnectTimer()

    // Unsubscribe bus first (stop reacting during teardown)
    this.detachFrontPanelPowerSubscription()

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
    this.pendingPowerFromFrontPanel = null
    this.heldModifiers.clear()
    this.readBuffer = ''
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
    // Gate key events on power state (safety: do not emit when off/unknown)
    if (this.power !== 'on') {
      const kind: KeyboardOperationKind =
        evt.action === 'press'
          ? 'press'
          : evt.action === 'hold'
          ? 'hold'
          : 'release'

      return this.failFastHandle(
        kind,
        `PC power state is ${this.power}; refusing key event`
      )
    }

    const scan = this.resolveScanCode(evt)
    if (!scan) {
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
        await this.ensureConnected()
        await this.ensurePoweredOn()
        await this.sendAction(evt.action, scan, {
          code: evt.code,
          key: evt.key,
          requestedBy: evt.requestedBy,
        })
      },
    })
  }

  public powerOn(requestedBy?: string): KeyboardOperationHandle {
    return this.enqueueOperation('powerOn', {
      requestedBy,
      label: 'power on',
      execute: async () => {
        await this.ensureConnected()
        await this.writeLine('power_on')
        this.power = 'on'
        this.events.publish({
          kind: 'keyboard-power-changed',
          at: now(),
          power: 'on',
          requestedBy,
        })
      },
    })
  }

  public powerOff(requestedBy?: string): KeyboardOperationHandle {
    return this.enqueueOperation('powerOff', {
      requestedBy,
      label: 'power off',
      execute: async () => {
        await this.ensureConnected()
        await this.writeLine('power_off')
        this.power = 'off'
        this.events.publish({
          kind: 'keyboard-power-changed',
          at: now(),
          power: 'off',
          requestedBy,
        })
      },
    })
  }

  public cancelAll(reason = 'cancelled'): void {
    this.cancelled = true

    if (this.activeOp) {
      this.events.publish({
        kind: 'keyboard-operation-cancelled',
        at: now(),
        opId: this.activeOp.id,
        reason,
      })
    }

    this.queue.length = 0
    this.activeOp = null
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

    this.events.publish({
      kind: 'keyboard-operation-started',
      at: now(),
      opId: op.id,
    })

    try {
      await op.execute()

      const result: KeyboardOperationResult = {
        id: op.id,
        kind: op.kind,
        status: 'completed',
        startedAt: op.createdAt,
        endedAt: now(),
      }

      op.resolve(result)

      this.events.publish({
        kind: 'keyboard-operation-completed',
        at: now(),
        result,
      })
    } catch (err) {
      const error = this.toErrorWithScope('unknown', err)

      const result: KeyboardOperationResult = {
        id: op.id,
        kind: op.kind,
        status: 'failed',
        startedAt: op.createdAt,
        endedAt: now(),
        error,
      }

      op.reject(result)

      this.events.publish({
        kind: 'keyboard-operation-failed',
        at: now(),
        result,
      })
    } finally {
      this.activeOp = null
      this.cancelled = false
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

    if (this.openInFlight) return this.openInFlight

    this.clearReconnectTimer()

    this.openInFlight = (async () => {
      if (this.port?.isOpen) {
        await this.closePort('unknown')
      }

      this.phase = 'connecting'
      this.identified = false

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

        // After identify success, apply any pending frontpanel power state.
        this.applyPendingFrontPanelPower()
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

    this.port = null
    this.identified = false
    this.phase = 'disconnected'
    this.heldModifiers.clear()
    this.readBuffer = ''

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

    try {
      await this.writeLine(this.cfg.identify.request)

      const token = await this.readLine(this.cfg.identify.timeoutMs)
      if (token !== this.cfg.expectedIdToken) {
        throw new Error(`unexpected identify token: ${token}`)
      }

      await this.writeLine(this.cfg.identify.completion)
      this.identified = true
      this.phase = 'ready'

      this.events.publish({
        kind: 'keyboard-identify-success',
        at: now(),
        token,
      })
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
    if (this.cancelled) {
      throw new Error('operation cancelled')
    }
    if (!this.port || !this.port.isOpen) {
      throw new Error('port not open')
    }

    await new Promise<void>((resolve, reject) => {
      this.port!.write(`${line}${this.cfg.identify.writeLineEnding}`, (err) =>
        err ? reject(err) : resolve()
      )
    })
  }

  private async readLine(timeoutMs: number): Promise<string> {
    const start = now()
    let buf = ''

    return new Promise<string>((resolve, reject) => {
      if (!this.port) {
        reject(new Error('port not open'))
        return
      }

      const port = this.port
      let finished = false

      const onData = (data: Buffer) => {
        if (finished) return
        buf += data.toString('utf8')
        const lines = buf.split(/\r?\n/)
        buf = lines.pop() ?? ''
        for (const l of lines) {
          const line = l.trim()
          if (!line) continue
          if (line.startsWith('debug:')) continue
          cleanup()
          finished = true
          resolve(line)
          return
        }
      }

      const cleanup = () => {
        port.off('data', onData)
      }

      port.on('data', onData)

      const tick = () => {
        if (finished) return
        if (now() - start >= timeoutMs) {
          cleanup()
          finished = true
          reject(new Error('identify timeout'))
        } else {
          setTimeout(tick, 25)
        }
      }
      tick()
    })
  }

  private handleData(chunk: string): void {
    this.readBuffer += chunk
    const lines = this.readBuffer.split(/\r?\n/)
    this.readBuffer = lines.pop() ?? ''

    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue

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
        error: this.toErrorWithScope(
          'open',
          'reconnect attempts exhausted',
          false
        ),
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

      const devicePath = this.devicePath
      if (!devicePath) return

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
  /*  Message bus integration                                                 */
  /* ---------------------------------------------------------------------- */

  private attachFrontPanelPowerSubscription(): void {
    if (!this.bus) return
    if (this.powerSub) return

    this.powerSub = this.bus.subscribe<FrontPanelPowerPayload>(
      { topic: 'frontpanel.power.changed' },
      async (evt: BusEvent<FrontPanelPowerPayload>) => {
        const parsed = parseFrontPanelPowerPayload(evt.payload)
        if (!parsed) {
          this.events.publish({
            kind: 'recoverable-error',
            at: now(),
            error: {
              at: now(),
              scope: 'protocol',
              message: `invalid frontpanel power payload`,
              retryable: false,
            },
          })
          // Fail closed: treat as unknown/off for safety.
          this.onFrontPanelPowerChanged({ state: 'unknown', reason: 'invalid-payload' }, evt)
          return
        }

        this.onFrontPanelPowerChanged(parsed, evt)
      },
      {
        name: 'ps2keyboard-frontpanel-power',
        onDisabled: () => {
          // Fail closed on backpressure disable: stop emitting keyboard output
          this.pendingPowerFromFrontPanel = 'unknown'
          this.power = 'unknown'
          this.cancelAll('bus-subscriber-disabled')
          this.heldModifiers.clear()
        },
        onError: () => {
          // No-op here; errors are already logged/telemetry’d by the bus.
        },
      }
    )
  }

  private detachFrontPanelPowerSubscription(): void {
    if (!this.powerSub) return
    this.powerSub.unsubscribe()
    this.powerSub = null
  }

  private onFrontPanelPowerChanged(payload: FrontPanelPowerPayload, evt: BusEvent<FrontPanelPowerPayload>): void {
    // Store latest seen power state from frontpanel (bus is stateless; this is local coordination)
    this.pendingPowerFromFrontPanel = payload.state

    const requestedBy = `frontpanel${payload.reason ? `:${payload.reason}` : ''}`

    if (payload.state === 'on') {
      // If device not yet ready, defer until after identify
      if (!this.port || !this.port.isOpen || !this.identified) return
      void this.powerOn(requestedBy).done.catch(() => {})
      return
    }

    // OFF or UNKNOWN: fail closed immediately
    this.power = toKeyboardPowerState(payload.state)
    this.cancelAll('power-gated')
    this.heldModifiers.clear()

    // If device is ready, explicitly command firmware power-off
    if (this.port && this.port.isOpen && this.identified) {
      void this.powerOff(requestedBy).done.catch(() => {})
    }
  }

  private applyPendingFrontPanelPower(): void {
    if (!this.pendingPowerFromFrontPanel) return
    // Only apply if ready
    if (!this.port || !this.port.isOpen || !this.identified) return

    const state = this.pendingPowerFromFrontPanel
    const requestedBy = 'frontpanel:pending'

    if (state === 'on') {
      void this.powerOn(requestedBy).done.catch(() => {})
    } else {
      // unknown/off => fail closed
      this.power = toKeyboardPowerState(state)
      this.cancelAll('power-gated')
      this.heldModifiers.clear()
      void this.powerOff(requestedBy).done.catch(() => {})
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  private async ensureConnected(): Promise<void> {
    if (!this.port || !this.port.isOpen) throw new Error('port not open')
    if (!this.identified) throw new Error('device not identified')
  }

  private async ensurePoweredOn(): Promise<void> {
    // Safety: refuse keyboard output unless explicitly powered on.
    if (this.power !== 'on') throw new Error(`pc power is ${this.power}`)
  }

  private resolveScanCode(evt: ClientKeyboardEvent): PS2ScanCode | null {
    if (evt.code) {
      return lookupScanCode(evt.code)
    }
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

    if (action === 'release') {
      return
    }

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
    })

    return { id, kind, createdAt, done }
  }

  private toErrorWithScope(
    scope: KeyboardError['scope'],
    err: unknown,
    retryable?: boolean
  ): KeyboardError {
    if (typeof err === 'string') {
      return { at: now(), scope, message: err, retryable }
    }
    if (err instanceof Error) {
      return { at: now(), scope, message: err.message, retryable }
    }
    return { at: now(), scope, message: 'unknown error', retryable }
  }
}
