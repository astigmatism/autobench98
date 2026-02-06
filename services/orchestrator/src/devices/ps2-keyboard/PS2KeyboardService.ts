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

// AppState (server-owned) — read-only subscription for frontpanel power sense
import { getSnapshot, stateEvents, type AppState } from '../../core/state.js'

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
/*  Front panel power (from AppState)                                          */
/* -------------------------------------------------------------------------- */

type FrontPanelPowerSense = 'on' | 'off' | 'unknown'

function normalizeFrontPanelPowerSense(v: unknown): FrontPanelPowerSense {
  return v === 'on' || v === 'off' || v === 'unknown' ? v : 'unknown'
}

function toKeyboardPowerState(s: FrontPanelPowerSense): KeyboardPowerState {
  if (s === 'on') return 'on'
  if (s === 'off') return 'off'
  return 'unknown'
}

function readFrontPanelPowerFromSnapshot(snap: AppState): {
  powerSense: FrontPanelPowerSense
  updatedAt: number | null
} {
  const raw = (snap as any)?.frontPanel?.powerSense
  const updatedAt =
    typeof (snap as any)?.frontPanel?.updatedAt === 'number'
      ? ((snap as any).frontPanel.updatedAt as number)
      : null

  return {
    powerSense: normalizeFrontPanelPowerSense(raw),
    updatedAt,
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

  // AppState subscription + last-seen frontpanel power sense
  private appStateAttached = false
  private lastFrontPanelPowerSense: FrontPanelPowerSense | null = null
  private lastFrontPanelUpdatedAt: number | null = null

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
  /*  Lifecycle (called by Fastify plugin)                                   */
  /* ---------------------------------------------------------------------- */

  public async start(): Promise<void> {
    this.stopping = false
    this.ensureFrontPanelPowerWatcherAttached('start')
  }

  public async stop(): Promise<void> {
    this.stopping = true
    this.clearReconnectTimer()

    // Stop reacting to AppState during teardown
    this.detachFrontPanelPowerWatcher()

    // If an open attempt is in flight, wait for it to settle before closing.
    try {
      await this.openInFlight
    } catch {
      /* ignore */
    }

    await this.closePort('explicit-close')

    this.queue.length = 0
    this.activeOp = null
    this.cancelled = false
    this.phase = 'disconnected'
    this.identified = false
    this.power = 'unknown'
    this.lastFrontPanelPowerSense = null
    this.lastFrontPanelUpdatedAt = null
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
    // CRITICAL: do not rely on plugin lifecycle calling start().
    // Attach AppState watcher here as well, idempotently.
    this.ensureFrontPanelPowerWatcherAttached('onDeviceIdentified')

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
    // Gate key events on power state (do not emit when off/unknown)
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
    const hadActive = !!this.activeOp

    // Only set the cancel flag if there is an operation to actually cancel.
    // If there is no active op, "cancelled=true" can poison lifecycle actions
    // (like identify) and future ops by making writeLine() fail immediately.
    if (hadActive) {
      this.cancelled = true

      this.events.publish({
        kind: 'keyboard-operation-cancelled',
        at: now(),
        opId: this.activeOp!.id,
        reason,
      })
    }

    // Drop queued work immediately.
    this.queue.length = 0

    // IMPORTANT:
    // Do not null out activeOp here. Let the running op unwind; processQueue()
    // will clear activeOp and reset cancelled=false in its finally{} block.
    if (!hadActive) {
      this.cancelled = false
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
        // Defensive: don't let a "no-active-op" cancellation state break identify.
        if (!this.activeOp) {
          this.cancelled = false
        }

        await this.identify()

        // After identify, resync from AppState once (covers start-order issues).
        this.syncFrontPanelPowerFromSnapshot(getSnapshot(), 'appstate:after-identify')

        // Apply power command to firmware if required by current AppState.
        this.applyFrontPanelPowerToFirmware('after-identify')
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
  /*  AppState integration (frontPanel.powerSense -> internal power gating)  */
  /* ---------------------------------------------------------------------- */

  private onAppStateSnapshot = (snap: AppState): void => {
    this.syncFrontPanelPowerFromSnapshot(snap, 'appstate:snapshot')
    this.applyFrontPanelPowerToFirmware('snapshot')
  }

  private onAppStatePatch = (): void => {
    // Patch is emitted before snapshot in core/state.ts, but we always read
    // the latest snapshot to avoid patch parsing.
    try {
      const snap = getSnapshot()
      this.syncFrontPanelPowerFromSnapshot(snap, 'appstate:patch')
      this.applyFrontPanelPowerToFirmware('patch')
    } catch {
      // fail-closed: keep existing state
    }
  }

  private ensureFrontPanelPowerWatcherAttached(caller: string): void {
    if (this.appStateAttached) return
    this.attachFrontPanelPowerWatcher(caller)
  }

  private attachFrontPanelPowerWatcher(caller: string): void {
    this.appStateAttached = true

    // Prove in logs that keyboard is actually watching AppState.
    let snap: AppState | null = null
    try {
      snap = getSnapshot()
    } catch {
      snap = null
    }

    const metaStartedAt = snap ? (snap as any)?.meta?.startedAt : 'unavailable'
    const version = snap ? (snap as any)?.version : 'unavailable'
    const { powerSense, updatedAt } = snap
      ? readFrontPanelPowerFromSnapshot(snap)
      : { powerSense: 'unknown' as const, updatedAt: null }

    this.events.publish({
      kind: 'keyboard-debug-line',
      at: now(),
      line:
        `debug: appstate watcher attached caller=${caller} ` +
        `state.version=${String(version)} meta.startedAt=${String(metaStartedAt)} ` +
        `frontPanel.powerSense=${powerSense}` +
        (updatedAt != null ? ` frontPanel.updatedAt=${updatedAt}` : ''),
    })

    // Sync immediately at attach time (this updates this.power).
    if (snap) {
      this.syncFrontPanelPowerFromSnapshot(snap, `appstate:attach:${caller}`)
    }

    // Attach listeners.
    stateEvents.on('snapshot', this.onAppStateSnapshot)
    stateEvents.on('patch', this.onAppStatePatch)
  }

  private detachFrontPanelPowerWatcher(): void {
    if (!this.appStateAttached) return
    this.appStateAttached = false
    stateEvents.off('snapshot', this.onAppStateSnapshot)
    stateEvents.off('patch', this.onAppStatePatch)
  }

  private syncFrontPanelPowerFromSnapshot(snap: AppState, reason: string): void {
    const { powerSense, updatedAt } = readFrontPanelPowerFromSnapshot(snap)
    this.syncFrontPanelPowerChanged(powerSense, updatedAt, reason)
  }

  private syncFrontPanelPowerChanged(
    next: FrontPanelPowerSense,
    updatedAt: number | null,
    reason: string
  ): void {
    const prev = this.lastFrontPanelPowerSense

    // Only act/log when the value actually changes.
    if (prev === next) return

    this.lastFrontPanelPowerSense = next
    this.lastFrontPanelUpdatedAt = updatedAt

    // Update internal gating immediately from AppState.
    this.power = toKeyboardPowerState(next)

    this.events.publish({
      kind: 'keyboard-debug-line',
      at: now(),
      line:
        `debug: appstate frontPanel.powerSense changed prev=${prev ?? 'null'} next=${next}` +
        (updatedAt != null ? ` frontPanel.updatedAt=${updatedAt}` : '') +
        ` reason=${reason} => keyboard.power=${this.power}`,
    })

    // Cancel queued work when power is not definitively on.
    if (next !== 'on') {
      this.cancelAll('power-gated')
      this.heldModifiers.clear()
    }
  }

  private applyFrontPanelPowerToFirmware(source: string): void {
    const s = this.lastFrontPanelPowerSense
    if (!s) return

    // Only send firmware commands when device is ready.
    if (!this.port || !this.port.isOpen || !this.identified) return

    const requestedBy = `frontpanel:${source}`

    if (s === 'on') {
      void this.powerOn(requestedBy).done.catch(() => {})
      return
    }

    if (s === 'off') {
      void this.powerOff(requestedBy).done.catch(() => {})
      return
    }

    // unknown => do not force firmware off (we simply don't know)
  }

  /* ---------------------------------------------------------------------- */
  /*  Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  private async ensureConnected(): Promise<void> {
    if (!this.port || !this.port.isOpen) throw new Error('port not open')
    if (!this.identified) throw new Error('device not identified')
  }

  private async ensurePoweredOn(): Promise<void> {
    // Refuse keyboard output unless AppState says power is on.
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
