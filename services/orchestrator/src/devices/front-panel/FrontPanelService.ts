// services/orchestrator/src/devices/front-panel/FrontPanelService.ts

import { SerialPort } from 'serialport'
import type {
  FrontPanelConfig,
  FrontPanelEventSink,
  FrontPanelDevicePhase,
  FrontPanelPowerSense,
  FrontPanelError,
  FrontPanelOperationKind,
  FrontPanelOperationHandle,
  FrontPanelOperationResult,
  FrontPanelInvokeTuning,
  FrontPanelOperationSummary,
} from './types'
import { sleep, now, makeOpId } from './utils'

// Message bus (orchestrator-internal)
import type { Bus } from '../../core/events/index.js'

/* -------------------------------------------------------------------------- */
/*  Message bus contract (frontpanel -> others)                               */
/* -------------------------------------------------------------------------- */

type FrontPanelPowerPayload = {
  state: FrontPanelPowerSense // 'on' | 'off' | 'unknown'
  reason?: string
}

interface QueuedOp {
  id: string
  kind: FrontPanelOperationKind
  createdAt: number
  requestedBy?: string
  label?: string
  tuning?: Partial<FrontPanelInvokeTuning>

  execute: () => Promise<void>

  resolve: (res: FrontPanelOperationResult) => void
  reject: (res: FrontPanelOperationResult) => void
}

type DisconnectReason = 'io-error' | 'explicit-close' | 'unknown' | 'device-lost'

export class FrontPanelService {
  private readonly cfg: FrontPanelConfig
  private readonly events: FrontPanelEventSink
  private readonly bus?: Bus

  private deviceId: string | null = null
  private devicePath: string | null = null

  private port: SerialPort | null = null
  private phase: FrontPanelDevicePhase = 'disconnected'
  private identified = false

  private powerSense: FrontPanelPowerSense = 'unknown'
  private hddActive = false
  private powerButtonHeld = false

  private queue: QueuedOp[] = []
  private activeOp: QueuedOp | null = null
  private cancelled = false

  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null

  private readBuffer = ''

  private stopping = false
  private openInFlight: Promise<void> | null = null
  private closingPort: SerialPort | null = null

  constructor(cfg: FrontPanelConfig, deps: { events: FrontPanelEventSink; bus?: Bus }) {
    this.cfg = cfg
    this.events = deps.events
    this.bus = deps.bus
  }

  /* ---------------------------------------------------------------------- */
  /*  Lifecycle (called by Fastify plugin)                                   */
  /* ---------------------------------------------------------------------- */

  public async start(): Promise<void> {
    this.stopping = false
  }

  public async stop(): Promise<void> {
    this.stopping = true
    this.clearReconnectTimer()

    this.cancelAll('service-stopping')

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

    this.powerSense = 'unknown'
    this.hddActive = false
    this.powerButtonHeld = false

    this.readBuffer = ''
    this.deviceId = null
    this.devicePath = null
  }

  /* ---------------------------------------------------------------------- */
  /*  Discovery-driven lifecycle                                             */
  /* ---------------------------------------------------------------------- */

  public async onDeviceIdentified(args: { id: string; path: string; baudRate?: number }): Promise<void> {
    this.deviceId = args.id
    this.devicePath = args.path

    this.events.publish({
      kind: 'frontpanel-device-identified',
      at: now(),
      id: args.id,
      path: args.path,
      baudRate: args.baudRate ?? this.cfg.baudRate,
    })

    if (this.stopping) return
    if (this.port && this.port.isOpen && this.identified) return

    await this.openPort(args.baudRate ?? this.cfg.baudRate)
  }

  public async onDeviceLost(args: { id: string }): Promise<void> {
    if (this.deviceId !== args.id) return

    this.clearReconnectTimer()
    await this.closePort('device-lost')

    this.deviceId = null
    this.devicePath = null

    this.events.publish({
      kind: 'frontpanel-device-lost',
      at: now(),
      id: args.id,
    })
  }

  /* ---------------------------------------------------------------------- */
  /*  Public API                                                             */
  /* ---------------------------------------------------------------------- */

  public powerHold(requestedBy?: string): FrontPanelOperationHandle {
    return this.enqueueOperation('powerHold', {
      requestedBy,
      label: 'power hold',
      execute: async () => {
        await this.ensureConnected()
        await this.writeLine('POWER_HOLD')
        this.setPowerButtonHeld(true, requestedBy)
      },
    })
  }

  public powerRelease(requestedBy?: string): FrontPanelOperationHandle {
    return this.enqueueOperation('powerRelease', {
      requestedBy,
      label: 'power release',
      execute: async () => {
        await this.ensureConnected()
        await this.writeLine('POWER_RELEASE')
        this.setPowerButtonHeld(false, requestedBy)
      },
    })
  }

  public powerPress(durationMs?: number, requestedBy?: string): FrontPanelOperationHandle {
    return this.enqueueOperation('powerPress', {
      requestedBy,
      label: 'power press',
      tuning: { powerPressHoldMs: durationMs },
      execute: async () => {
        await this.ensureConnected()

        const holdMsRaw =
          typeof durationMs === 'number' && Number.isFinite(durationMs)
            ? Math.floor(durationMs)
            : this.cfg.tuning.powerPressHoldMs
        const holdMs = Math.max(50, Math.min(10_000, holdMsRaw))

        await this.writeLine('POWER_HOLD')
        this.setPowerButtonHeld(true, requestedBy)

        await sleep(holdMs)

        await this.writeLine('POWER_RELEASE')
        this.setPowerButtonHeld(false, requestedBy)
      },
    })
  }

  public resetPress(requestedBy?: string): FrontPanelOperationHandle {
    return this.enqueueOperation('resetPress', {
      requestedBy,
      label: 'reset press',
      execute: async () => {
        await this.ensureConnected()
        await this.writeLine('RESET_HOLD')
      },
    })
  }

  public cancelAll(reason = 'cancelled'): void {
    this.cancelled = true

    if (this.activeOp) {
      this.events.publish({
        kind: 'frontpanel-operation-cancelled',
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
    kind: FrontPanelOperationKind,
    opts: {
      execute: () => Promise<void>
      requestedBy?: string
      label?: string
      tuning?: Partial<FrontPanelInvokeTuning>
    }
  ): FrontPanelOperationHandle {
    if (this.queue.length >= this.cfg.queue.maxDepth) {
      return this.failFastHandle(kind, `queue full (maxDepth=${this.cfg.queue.maxDepth})`)
    }

    const id = makeOpId('fp')
    const createdAt = now()

    let resolve!: (res: FrontPanelOperationResult) => void
    let reject!: (res: FrontPanelOperationResult) => void

    const done = new Promise<FrontPanelOperationResult>((res, rej) => {
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
      kind: 'frontpanel-operation-queued',
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
      kind: 'frontpanel-operation-started',
      at: now(),
      opId: op.id,
    })

    try {
      await op.execute()

      const result: FrontPanelOperationResult = {
        id: op.id,
        kind: op.kind,
        status: 'completed',
        startedAt: op.createdAt,
        endedAt: now(),
      }

      op.resolve(result)

      this.events.publish({
        kind: 'frontpanel-operation-completed',
        at: now(),
        result,
      })
    } catch (err) {
      const error = this.toErrorWithScope('unknown', err)

      const result: FrontPanelOperationResult = {
        id: op.id,
        kind: op.kind,
        status: 'failed',
        startedAt: op.createdAt,
        endedAt: now(),
        error,
      }

      op.reject(result)

      this.events.publish({
        kind: 'frontpanel-operation-failed',
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

      this.events.publish({
        kind: 'frontpanel-device-connected',
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

    this.port = null
    this.identified = false
    this.phase = 'disconnected'
    this.readBuffer = ''

    // Fail-closed visibility: on disconnect, treat telemetry as unknown/off.
    this.powerSense = 'unknown'
    this.hddActive = false
    this.powerButtonHeld = false

    // 🔴 Fail-closed coordination: tell the bus "unknown" whenever we lose the device.
    this.publishPowerSenseToBus('unknown', `disconnect:${reason}`)

    if (port && port.isOpen) {
      this.closingPort = port
      await new Promise<void>((resolve) => port.close(() => resolve()))
      this.closingPort = null
    }

    if (this.devicePath || port) {
      this.events.publish({
        kind: 'frontpanel-device-disconnected',
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
      kind: 'frontpanel-identify-start',
      at: now(),
      path: this.devicePath ?? 'unknown',
    })

    const expected = this.cfg.expectedIdToken

    try {
      let token: string | null = null
      let lastErr: unknown = null

      for (let attempt = 1; attempt <= this.cfg.identify.retries; attempt++) {
        try {
          await this.writeLine(this.cfg.identify.request)
          const t = await this.readLine(this.cfg.identify.timeoutMs)
          token = t
          break
        } catch (err) {
          lastErr = err
        }
      }

      if (!token) {
        throw lastErr ?? new Error('identify failed')
      }

      if (token !== expected) {
        throw new Error(`unexpected identify token: ${token}`)
      }

      await this.writeLine(this.cfg.identify.completion)
      this.identified = true
      this.phase = 'ready'

      this.events.publish({
        kind: 'frontpanel-identify-success',
        at: now(),
        token,
      })
    } catch (err) {
      this.identified = false
      this.phase = 'error'

      this.events.publish({
        kind: 'frontpanel-identify-failed',
        at: now(),
        error: this.toErrorWithScope('identify', err, true),
      })

      throw err
    }
  }

  private async writeLine(line: string): Promise<void> {
    if (this.cancelled) throw new Error('operation cancelled')
    if (!this.port || !this.port.isOpen) throw new Error('port not open')

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

      // Avoid log noise: during identify, token line can arrive and would otherwise show as debug.
      if (!this.identified && line === this.cfg.expectedIdToken) {
        continue
      }

      if (line === 'POWER_LED_ON') {
        this.setPowerSense('on')
        continue
      }
      if (line === 'POWER_LED_OFF') {
        this.setPowerSense('off')
        continue
      }
      if (line === 'HDD_ACTIVE_ON') {
        this.setHddActive(true)
        continue
      }
      if (line === 'HDD_ACTIVE_OFF') {
        this.setHddActive(false)
        continue
      }

      this.events.publish({
        kind: 'frontpanel-debug-line',
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

  private async ensureConnected(): Promise<void> {
    if (!this.port || !this.port.isOpen) throw new Error('port not open')
    if (!this.identified) throw new Error('device not identified')
  }

  private setPowerSense(next: FrontPanelPowerSense): void {
    if (this.powerSense === next) return
    this.powerSense = next

    this.events.publish({
      kind: 'frontpanel-power-sense-changed',
      at: now(),
      powerSense: next,
      source: 'firmware',
    })

    // ✅ Publish to message bus for coordination (keyboard, etc.)
    this.publishPowerSenseToBus(next, 'firmware')
  }

  private publishPowerSenseToBus(state: FrontPanelPowerSense, reason: string): void {
    if (!this.bus) return
    try {
      this.bus.publish<FrontPanelPowerPayload>({
        topic: 'frontpanel.power.changed',
        source: 'frontpanel',
        schemaVersion: 1,
        payload: { state, reason },
        attributes: { state },
      })
    } catch (err) {
      // Never let bus issues crash the frontpanel service; log via normal event sink.
      this.events.publish({
        kind: 'recoverable-error',
        at: now(),
        error: this.toErrorWithScope(
          'unknown',
          `bus publish failed: ${(err as Error)?.message ?? String(err)}`,
          true
        ),
      })
    }
  }

  private setHddActive(active: boolean): void {
    if (this.hddActive === active) return
    this.hddActive = active
    this.events.publish({
      kind: 'frontpanel-hdd-activity-changed',
      at: now(),
      active,
      source: 'firmware',
    })
  }

  private setPowerButtonHeld(held: boolean, requestedBy?: string): void {
    if (this.powerButtonHeld === held) return
    this.powerButtonHeld = held
    this.events.publish({
      kind: 'frontpanel-power-button-held-changed',
      at: now(),
      held,
      requestedBy,
    })
  }

  private summarize(op: QueuedOp, status: FrontPanelOperationSummary['status']): FrontPanelOperationSummary {
    return {
      id: op.id,
      kind: op.kind,
      status,
      createdAt: op.createdAt,
      requestedBy: op.requestedBy,
      label: op.label,
    }
  }

  private failFastHandle(kind: FrontPanelOperationKind, message: string): FrontPanelOperationHandle {
    const id = makeOpId('fp')
    const createdAt = now()
    const error: FrontPanelError = {
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
    scope: FrontPanelError['scope'],
    err: unknown,
    retryable?: boolean
  ): FrontPanelError {
    if (typeof err === 'string') return { at: now(), scope, message: err, retryable }
    if (err instanceof Error) return { at: now(), scope, message: err.message, retryable }
    return { at: now(), scope, message: 'unknown error', retryable }
  }
}
