// services/orchestrator/src/devices/ps2-keyboard/PS2KeyboardService.ts

/* -------------------------------------------------------------------------- */
/*  PS2KeyboardService                                                         */
/*                                                                            */
/*  Responsibilities:                                                         */
/*  - Own the serial port for the PS/2 keyboard Arduino                        */
/*  - Manage identification + reconnect lifecycle                              */
/*  - Provide a rich, interruptible operation queue                            */
/*  - Translate high-level keyboard intents into Arduino commands              */
/*  - Emit domain events for logging + AppState adapters                        */
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
import {
  sleep,
  now,
  makeOpId,
  formatWireScanCode,
} from './utils'

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

  // Modifier identification is intentionally explicit and conservative.
  // If you need more modifier-like keys (e.g., CapsLock), add them here deliberately.
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

  constructor(
    cfg: PS2KeyboardConfig,
    deps: { events: PS2KeyboardEventSink }
  ) {
    this.cfg = cfg
    this.events = deps.events
  }

  /* ---------------------------------------------------------------------- */
  /*  Lifecycle (called by Fastify plugin)                                   */
  /* ---------------------------------------------------------------------- */

  public async start(): Promise<void> {
    // No-op; lifecycle is discovery-driven
  }

  public async stop(): Promise<void> {
    this.clearReconnectTimer()
    await this.closePort('explicit-close')
    this.queue.length = 0
    this.activeOp = null
    this.phase = 'disconnected'
    this.identified = false
    this.power = 'unknown'
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

    // If already open and identified, nothing to do
    if (this.port && this.port.isOpen && this.identified) return

    await this.openPort(args.baudRate ?? this.cfg.baudRate)
  }

  public async onDeviceLost(args: { id: string }): Promise<void> {
    if (this.deviceId !== args.id) return

    this.clearReconnectTimer()
    await this.closePort('device-lost')

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
        await this.ensureReady()
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
        await this.ensureReady()
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
      // pace before next op
      await sleep(this.cfg.tuning.interCommandDelayMs)
      void this.processQueue()
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Serial handling                                                        */
  /* ---------------------------------------------------------------------- */

  private async openPort(baudRate: number): Promise<void> {
    if (!this.devicePath) return

    this.phase = 'connecting'
    this.identified = false

    const port = new SerialPort({
      path: this.devicePath,
      baudRate,
      autoOpen: false,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
    })

    await new Promise<void>((resolve, reject) => {
      port.once('open', resolve)
      port.once('error', reject)
      port.open()
    })

    this.port = port
    this.reconnectAttempts = 0
    this.readBuffer = ''
    this.heldModifiers.clear()

    this.events.publish({
      kind: 'keyboard-device-connected',
      at: now(),
      path: this.devicePath,
      baudRate,
    })

    port.on('data', (buf) => this.handleData(buf.toString('utf8')))
    port.on('error', (err) => this.handlePortError(err))
    port.on('close', () => this.handlePortClose())

    // Ensure identify failures are surfaced as events (and do not crash callers).
    try {
      await this.identify()
    } catch {
      await this.closePort('unknown')
      this.scheduleReconnect()
    }
  }

  private async closePort(reason: 'io-error' | 'explicit-close' | 'unknown' | 'device-lost'): Promise<void> {
    const port = this.port
    this.port = null
    this.identified = false
    this.heldModifiers.clear()
    this.readBuffer = ''

    if (port && port.isOpen) {
      await new Promise<void>((resolve) => port.close(() => resolve()))
    }

    this.events.publish({
      kind: 'keyboard-device-disconnected',
      at: now(),
      path: this.devicePath ?? 'unknown',
      reason,
    })
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

      // Expect token line (ignore debug lines)
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
    if (!this.port || !this.port.isOpen) {
      throw new Error('port not open')
    }

    await new Promise<void>((resolve, reject) => {
      this.port!.write(
        `${line}${this.cfg.identify.writeLineEnding}`,
        (err) => (err ? reject(err) : resolve())
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

      const onData = (data: Buffer) => {
        buf += data.toString('utf8')
        const lines = buf.split(/\r?\n/)
        buf = lines.pop() ?? ''
        for (const l of lines) {
          const line = l.trim()
          if (!line) continue
          if (line.startsWith('debug:')) continue
          cleanup()
          resolve(line)
          return
        }
      }

      const cleanup = () => {
        port.off('data', onData)
      }

      port.on('data', onData)

      const tick = () => {
        if (now() - start >= timeoutMs) {
          cleanup()
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

      // Arduino contract: `success:` is ack; `debug:` is telemetry.
      // Keep telemetry + unknown lines; suppress `success:` by default to reduce noise.
      if (line.startsWith('success:')) continue

      if (line.startsWith('debug:') || !line.startsWith('debug:')) {
        // Publish debug telemetry lines and unknown/unclassified lines.
        // Plugin logging can choose to ignore these events.
        this.events.publish({
          kind: 'keyboard-debug-line',
          at: now(),
          line,
        })
      }
    }
  }

  private async handlePortError(_err: Error): Promise<void> {
    await this.closePort('io-error')
    this.scheduleReconnect()
  }

  private async handlePortClose(): Promise<void> {
    await this.closePort('io-error')
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (!this.cfg.reconnect.enabled) return

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
      if (this.devicePath) {
        void this.openPort(this.cfg.baudRate)
      }
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
    return `${prefix.toString(16).padStart(2, '0')}:${scan.code.toString(16).padStart(2, '0')}`
  }

  private modsSnapshot(): string[] {
    // Stable ordering makes log diffing easier.
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

    // Logging semantics:
    // - Modifiers: log hold/release as mod down/up.
    // - Non-modifiers: treat a keydown (`hold`) as a logical `press` for logs,
    //   and suppress the corresponding non-modifier release logs.
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
        // For modifiers, mods is optional; leave it undefined to avoid noise.
        opId: this.activeOp?.id,
        requestedBy: meta?.requestedBy ?? this.activeOp?.requestedBy,
      })
      return
    }

    if (action === 'release') {
      // Suppress non-modifier keyup noise.
      return
    }

    const logicalAction: KeyboardAction =
      action === 'hold' ? 'press' : action

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

  private summarize(op: QueuedOp, status: KeyboardOperationSummary['status']): KeyboardOperationSummary {
    return {
      id: op.id,
      kind: op.kind,
      status,
      createdAt: op.createdAt,
      requestedBy: op.requestedBy,
      label: op.label,
    }
  }

  private failFastHandle(kind: KeyboardOperationKind, message: string): KeyboardOperationHandle {
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
