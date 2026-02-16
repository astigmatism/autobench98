// services/orchestrator/src/devices/ps2-mouse/PS2MouseService.ts

import { SerialPort } from 'serialport'
import type {
  PS2MouseConfig,
  PS2MouseEvent,
  MouseOperationKind,
  MousePowerState,
  MouseOperation,
  MouseOperationResult,
  MouseOperationButton,
  MouseOperationWheel,
  MouseOperationConfig,
  MouseButton,
  MouseMoveMode,
  ClientMouseCommand,
  ClientMouseConfig,
  MouseAbsoluteGridConfig,
  MouseAccelConfig,
} from './types.js'
import { clamp01, clampInt, safeNow } from './utils.js'

/* -------------------------------------------------------------------------- */
/*  Local deps types (do NOT import what ./types does not export)             */
/* -------------------------------------------------------------------------- */

export type PS2MouseEventSink = {
  publish: (evt: PS2MouseEvent) => void
}

export type MouseOperationHandle = {
  id: string
  kind: MouseOperationKind
  createdAt: number
  done: Promise<MouseOperationResult>
}

type MouseDevicePhase = 'disconnected' | 'connecting' | 'identifying' | 'ready' | 'error'
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
/*  Internal operation model                                                  */
/* -------------------------------------------------------------------------- */

type QueuedOp = {
  op: MouseOperation
  execute: () => Promise<void>
  resolve: (res: MouseOperationResult) => void
  reject: (res: MouseOperationResult) => void
}

function makeOpId(prefix: string): string {
  const t = safeNow().toString(36)
  const r = Math.floor(Math.random() * 1e9).toString(36)
  return `${prefix}-${t}-${r}`
}

function normalizeRequestedBy(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  return s.length ? s : 'unknown'
}

function buttonToWire(btn: MouseButton): number {
  if (btn === 'left') return 0
  if (btn === 'right') return 1
  return 2
}

function sleep(ms: number): Promise<void> {
  const n = Math.max(0, Math.trunc(ms))
  return new Promise((resolve) => setTimeout(resolve, n))
}

/* -------------------------------------------------------------------------- */
/*  Movement model (spec v0.3 §8)                                             */
/* -------------------------------------------------------------------------- */

type Grid = { w: number; h: number }

type MovementState = {
  // EFFECTIVE mode: driven by last received movement input (absolute vs relative),
  // while still using configured tuning (gain/accel) for relative.
  mode: MouseMoveMode

  // resolved grid used for mapping and clamping
  gridResolved: Grid | null

  // absolute targets (grid coords)
  absTarget: { x: number; y: number } | null

  // relative accumulators (grid delta units)
  relAcc: { dx: number; dy: number }

  // last time we observed a relative move event (used for velocity)
  lastRelAt: number | null

  // virtual cursor position in grid coords (absolute) / unbounded (relative)
  cursor: { x: number; y: number }

  // warning gating for "auto grid unresolved"
  warnedUnknownGrid: boolean

  // movement event throttling (avoid flooding logs)
  lastMoveTickEvtAt: number | null
}

/* -------------------------------------------------------------------------- */
/*  Service                                                                   */
/* -------------------------------------------------------------------------- */

export class PS2MouseService {
  private readonly cfg: PS2MouseConfig
  private readonly events: PS2MouseEventSink

  private deviceId: string | null = null
  private devicePath: string | null = null

  private port: SerialPort | null = null
  private phase: MouseDevicePhase = 'disconnected'
  private identified = false

  /**
   * Host PC power state (from front panel).
   * Spec v0.3 §6.2:
   * - 'unknown' => fail-open (do not block)
   * - 'off'     => cancel queued/active discrete ops, clear movement state,
   *               stop sending movement/wheel while power is off
   */
  private hostPower: MousePowerState = 'unknown'

  // Discrete op queue (spec v0.3: buttons/config are queued; movement is NOT queued)
  private queue: QueuedOp[] = []
  private active: QueuedOp | null = null

  private stopping = false
  private openInFlight: Promise<void> | null = null
  private closingPort: SerialPort | null = null

  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null

  private activeCancel: { opId: string; reason: string } | null = null

  private readBuffer = ''

  // Best-effort button state to avoid stuck firmware state.
  // Reset on reconnect (spec v0.3 §13.1).
  private buttonsDown = new Set<MouseButton>()

  // Runtime movement config (set by cfg defaults; can be updated via queued config op)
  private moveMode: MouseMoveMode
  private gain: number
  private accel: { enabled: boolean; baseGain: number; maxGain: number; velocityPxPerSecForMax: number }
  private absoluteGrid: MouseAbsoluteGridConfig

  // Movement aggregation / tick flush state (spec v0.3 §8)
  private movement: MovementState

  /**
   * Movement tick loop (IMPORTANT):
   * - Must NOT overlap (async re-entrancy creates out-of-order MOVE commands).
   * - We therefore run a self-scheduling async loop (setTimeout after await).
   */
  private moveTimer: NodeJS.Timeout | null = null
  private moveLoopActive = false

  /**
   * Identify safety fix:
   * Do NOT attach a temporary port.on('data') listener that can drop lines.
   * We route all inbound lines through handleData(), and (until identified)
   * we also feed them into a FIFO that identify() consumes deterministically.
   */
  private pendingLines: string[] = []
  private pendingLineWaiters: Array<{
    resolve: (line: string) => void
    reject: (err: Error) => void
    timer: NodeJS.Timeout
  }> = []
  private static readonly MAX_PENDING_LINES = 256

  /**
   * Serial write serialization:
   * Movement ticks and queued ops both write to the same port.
   * Without serialization, bytes can interleave and corrupt firmware commands.
   */
  private writeSeq: Promise<void> = Promise.resolve()

  constructor(cfg: PS2MouseConfig, deps: { events: PS2MouseEventSink }) {
    this.cfg = cfg
    this.events = deps.events

    this.moveMode = cfg.movement.defaultMode
    this.gain = Math.max(1, Math.trunc(cfg.movement.relativeGain.gain))
    this.accel = {
      enabled: !!cfg.movement.accel.enabled,
      baseGain: Math.max(1, Math.trunc(cfg.movement.accel.baseGain)),
      maxGain: Math.max(Math.trunc(cfg.movement.accel.baseGain), Math.trunc(cfg.movement.accel.maxGain)),
      velocityPxPerSecForMax: Math.max(1, Math.trunc(cfg.movement.accel.velocityPxPerSecForMax)),
    }
    this.absoluteGrid = cfg.movement.absoluteGrid

    const gridResolved = this.resolveGridFromConfig(this.absoluteGrid)

    // Initialize cursor in the middle of the resolved grid if available; else safe fallback.
    const initGrid: Grid = gridResolved ?? { w: 1024, h: 768 }
    this.movement = {
      mode: this.moveMode,
      gridResolved,
      absTarget: null,
      relAcc: { dx: 0, dy: 0 },
      lastRelAt: null,
      cursor: { x: Math.floor((initGrid.w - 1) / 2), y: Math.floor((initGrid.h - 1) / 2) },
      warnedUnknownGrid: false,
      lastMoveTickEvtAt: null,
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Host power integration                                                 */
  /* ---------------------------------------------------------------------- */

  public setHostPower(power: MousePowerState, why: string = 'front-panel'): void {
    if (power === this.hostPower) return
    const prev = this.hostPower
    this.hostPower = power

    this.events.publish({
      kind: 'mouse-host-power-changed',
      power,
      prev,
      why,
    })

    // Spec v0.3 §6.2: On power off, cancel queued + best-effort cancel active,
    // clear movement accumulators/targets, and stop sending movement/wheel while off.
    if (power === 'off' && prev !== 'off') {
      this.clearMovementState('host-power-off')
      this.cancelQueuedOps('host-power-off')
      if (this.active) this.requestCancelActiveOp('host-power-off')
    }
  }

  public getHostPower(): MousePowerState {
    return this.hostPower
  }

  /* ---------------------------------------------------------------------- */
  /*  Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  public async start(): Promise<void> {
    this.stopping = false
    this.ensureMoveTickRunning()

    // Optional direct path mode
    if (this.cfg.serial.path) {
      this.deviceId = this.deviceId ?? 'ps2-mouse'
      this.devicePath = this.cfg.serial.path
      await this.openPort(this.cfg.serial.baudRate)
    }
  }

  public async stop(): Promise<void> {
    this.stopping = true
    this.clearReconnectTimer()
    this.stopMoveTick()

    this.cancelAll('service-stopping')

    try {
      await this.openInFlight
    } catch {
      /* ignore */
    }

    await this.closePort('explicit-close')

    this.queue.length = 0
    this.active = null
    this.phase = 'disconnected'
    this.identified = false
    this.hostPower = 'unknown'
    this.readBuffer = ''
    this.activeCancel = null
    this.buttonsDown.clear()
    this.reconnectAttempts = 0

    this.clearMovementState('service-stopping')

    // Fail any identify waiters promptly.
    this.failAllPendingLineWaiters(new Error('service stopping'))
    this.pendingLines = []
  }

  /* ---------------------------------------------------------------------- */
  /*  Discovery-driven lifecycle                                             */
  /* ---------------------------------------------------------------------- */

  public async onDeviceIdentified(args: { id: string; path: string; baudRate?: number }): Promise<void> {
    this.deviceId = args.id
    this.devicePath = args.path

    if (this.stopping) return
    if (this.port && this.port.isOpen && this.identified) return

    const baudRate =
      typeof args.baudRate === 'number' && Number.isFinite(args.baudRate)
        ? args.baudRate
        : this.cfg.serial.baudRate

    await this.openPort(baudRate)
  }

  public async onDeviceLost(args: { id: string }): Promise<void> {
    if (this.deviceId !== args.id) return

    this.clearReconnectTimer()
    await this.closePort('device-lost')

    this.deviceId = null
    this.devicePath = null

    this.events.publish({ kind: 'mouse-device-lost', id: args.id })
  }

  /* ---------------------------------------------------------------------- */
  /*  Public ingress API                                                     */
  /* ---------------------------------------------------------------------- */

  public handleClientCommand(cmd: ClientMouseCommand): MouseOperationHandle | null {
    switch (cmd.kind) {
      case 'mouse.move.absolute':
        this.handleMoveAbsolute(cmd.xNorm, cmd.yNorm, cmd.requestedBy)
        return null
      case 'mouse.move.relative':
        this.handleMoveRelative(cmd.dx, cmd.dy, cmd.requestedBy)
        return null

      case 'mouse.button.down':
        return this.enqueueButton(cmd.button, 'down', cmd.requestedBy)
      case 'mouse.button.up':
        return this.enqueueButton(cmd.button, 'up', cmd.requestedBy)
      case 'mouse.button.click':
        return this.enqueueButton(cmd.button, 'click', cmd.requestedBy, cmd.holdMs)

      case 'mouse.wheel':
        return this.enqueueWheel(cmd.dy, cmd.requestedBy)

      case 'mouse.config':
        // NOTE: ClientMouseConfig does NOT include requestedBy (per spec §7.4).
        return this.enqueueConfig(cmd)

      case 'mouse.cancelAll':
        this.cancelAll(cmd.reason ?? 'cancelled')
        return null

      default: {
        const _x: never = cmd
        return _x
      }
    }
  }

  public cancelAll(reason = 'cancelled'): void {
    const queued = this.queue.splice(0, this.queue.length)
    for (const q of queued) {
      this.events.publish({ kind: 'mouse-operation-cancelled', opId: q.op.id, reason })
      q.resolve({
        id: q.op.id,
        kind: q.op.kind,
        ok: false,
        startedAt: undefined,
        finishedAt: safeNow(),
        error: new Error(`cancelled: ${reason}`),
      })
    }

    if (this.active) {
      this.requestCancelActiveOp(reason)
    }

    // CRITICAL: also clear movement state so a fast fling can't keep moving after cancel.
    this.clearMovementState(`cancelAll:${reason}`)

    this.emitQueueDepth()
  }

  /* ---------------------------------------------------------------------- */
  /*  Movement ingress (NOT queued)                                          */
  /* ---------------------------------------------------------------------- */

  private effectiveRelativeMode(): MouseMoveMode {
    // If the configured mode is already relative, keep it.
    if (this.moveMode === 'relative-gain' || this.moveMode === 'relative-accel') return this.moveMode

    // Otherwise, infer a safe relative mode so relative move commands can still produce motion.
    // (We do NOT mutate this.moveMode here; we only set movement.mode per-input.)
    return this.accel.enabled ? 'relative-accel' : 'relative-gain'
  }

  private handleMoveAbsolute(xNorm: number, yNorm: number, _requestedBy?: string): void {
    const x01 = this.cfg.movement.clampAbsoluteToUnit ? clamp01(xNorm) : Number.isFinite(xNorm) ? xNorm : 0
    const y01 = this.cfg.movement.clampAbsoluteToUnit ? clamp01(yNorm) : Number.isFinite(yNorm) ? yNorm : 0

    // Effective mode is driven by input type.
    this.movement.mode = 'absolute'

    // Absolute input supersedes any accumulated relative motion.
    this.movement.relAcc.dx = 0
    this.movement.relAcc.dy = 0
    this.movement.lastRelAt = null

    const grid = this.getGridForAbsoluteMapping()
    const tx = clampInt(Math.round(x01 * (grid.w - 1)), 0, grid.w - 1)
    const ty = clampInt(Math.round(y01 * (grid.h - 1)), 0, grid.h - 1)

    this.movement.absTarget = { x: tx, y: ty }
  }

  private handleMoveRelative(dx: number, dy: number, _requestedBy?: string): void {
    const ddx = Number.isFinite(dx) ? dx : 0
    const ddy = Number.isFinite(dy) ? dy : 0
    const now = safeNow()

    // Relative input supersedes any outstanding absolute target.
    this.movement.absTarget = null

    const mode = this.effectiveRelativeMode()
    this.movement.mode = mode

    if (mode === 'relative-accel') {
      const g = this.computeAccelGain(now, ddx, ddy)
      this.movement.relAcc.dx += ddx * g
      this.movement.relAcc.dy += ddy * g
      this.movement.lastRelAt = now
      return
    }

    // Default: relative-gain
    const g = Math.max(1, Math.trunc(this.gain))
    this.movement.relAcc.dx += ddx * g
    this.movement.relAcc.dy += ddy * g
    this.movement.lastRelAt = now
  }

  private computeAccelGain(now: number, dx: number, dy: number): number {
    if (!this.accel.enabled) return Math.max(1, Math.trunc(this.gain))

    const prevAt = this.movement.lastRelAt
    const dtMs = prevAt == null ? 16 : Math.max(1, now - prevAt)
    const dtSec = dtMs / 1000

    const dist = Math.sqrt(dx * dx + dy * dy)
    const vel = dist / dtSec // px/sec in client delta units

    const ratio = clamp01(vel / Math.max(1, this.accel.velocityPxPerSecForMax))
    const g = Math.round(this.accel.baseGain + (this.accel.maxGain - this.accel.baseGain) * ratio)
    return Math.max(1, g)
  }

  /* ---------------------------------------------------------------------- */
  /*  Discrete ops: wheel/buttons/config (queued, cancellable)               */
  /* ---------------------------------------------------------------------- */

  private enqueueWheel(dy: number, requestedBy?: string): MouseOperationHandle {
    const id = makeOpId('ms')
    const createdAt = safeNow()
    const req = normalizeRequestedBy(requestedBy)

    const op: MouseOperationWheel = {
      id,
      kind: 'wheel',
      requestedBy: req,
      queuedAt: createdAt,
      dy: clampInt(dy, -255, 255),
    }

    return this.enqueueOp(op, createdAt, async () => {
      await this.ensureReady()
      this.assertOpsAllowed()

      if (op.dy === 0) return
      await this.writeLine(`WHEEL ${op.dy}`)
      this.events.publish({ kind: 'mouse-wheel', dy: op.dy })
    })
  }

  private enqueueButton(
    button: MouseButton,
    action: 'down' | 'up' | 'click',
    requestedBy?: string,
    holdMs?: number
  ): MouseOperationHandle {
    const id = makeOpId('ms')
    const createdAt = safeNow()
    const req = normalizeRequestedBy(requestedBy)

    const op: MouseOperationButton = {
      id,
      kind: 'button',
      requestedBy: req,
      queuedAt: createdAt,
      button,
      action,
      holdMs: typeof holdMs === 'number' && Number.isFinite(holdMs) ? Math.max(0, Math.trunc(holdMs)) : undefined,
    }

    return this.enqueueOp(op, createdAt, async () => {
      await this.ensureReady()
      this.assertOpsAllowed()

      if (op.action === 'down') {
        if (this.buttonsDown.has(op.button)) {
          this.events.publish({
            kind: 'mouse-button',
            button: op.button,
            action: 'down',
            noOp: true,
            noOpReason: 'already-down',
          })
          return
        }
        await this.writeLine(`CLICK ${buttonToWire(op.button)}`)
        this.buttonsDown.add(op.button)
        this.events.publish({ kind: 'mouse-button', button: op.button, action: 'down' })
        return
      }

      if (op.action === 'up') {
        if (!this.buttonsDown.has(op.button)) {
          this.events.publish({
            kind: 'mouse-button',
            button: op.button,
            action: 'up',
            noOp: true,
            noOpReason: 'already-up',
          })
          return
        }
        await this.writeLine(`RELEASE ${buttonToWire(op.button)}`)
        this.buttonsDown.delete(op.button)
        this.events.publish({ kind: 'mouse-button', button: op.button, action: 'up' })
        return
      }

      if (this.buttonsDown.has(op.button)) {
        this.events.publish({
          kind: 'mouse-button',
          button: op.button,
          action: 'click',
          noOp: true,
          noOpReason: 'already-down',
        })
        return
      }

      await this.writeLine(`CLICK ${buttonToWire(op.button)}`)
      this.buttonsDown.add(op.button)

      const hold = op.holdMs ?? 40
      if (hold > 0) await this.sleepCancellable(hold)

      await this.writeLine(`RELEASE ${buttonToWire(op.button)}`)
      this.buttonsDown.delete(op.button)

      this.events.publish({ kind: 'mouse-button', button: op.button, action: 'click' })
    })
  }

  private enqueueConfig(cmd: ClientMouseConfig): MouseOperationHandle {
    const id = makeOpId('ms')
    const createdAt = safeNow()

    const op: MouseOperationConfig = {
      id,
      kind: 'config',
      requestedBy: 'unknown', // ClientMouseConfig has no requestedBy (spec §7.4)
      queuedAt: createdAt,
      patch: {
        mode: cmd.mode,
        gain: cmd.gain,
        accel: cmd.accel,
        absoluteGrid: cmd.absoluteGrid,
      },
    }

    return this.enqueueOp(op, createdAt, async () => {
      await this.ensureReady()
      this.assertOpsAllowed()

      const applied = this.applyConfigPatch(op.patch)
      this.events.publish({ kind: 'mouse-config-applied', patch: applied })
    })
  }

  private applyConfigPatch(patch: {
    mode?: MouseMoveMode
    gain?: number
    accel?: MouseAccelConfig
    absoluteGrid?: MouseAbsoluteGridConfig
  }): {
    mode?: MouseMoveMode
    gain?: number
    accel?: MouseAccelConfig
    absoluteGrid?: MouseAbsoluteGridConfig
  } {
    const applied: {
      mode?: MouseMoveMode
      gain?: number
      accel?: MouseAccelConfig
      absoluteGrid?: MouseAbsoluteGridConfig
    } = {}

    if (patch.mode) {
      this.moveMode = patch.mode
      this.movement.mode = patch.mode
      applied.mode = patch.mode
      this.clearMovementState('config-mode-change')
    }

    if (typeof patch.gain === 'number' && Number.isFinite(patch.gain)) {
      const g = Math.max(1, Math.trunc(patch.gain))
      this.gain = g
      applied.gain = g
    }

    if (patch.accel) {
      const enabled = !!patch.accel.enabled
      const baseGain =
        typeof patch.accel.baseGain === 'number' && Number.isFinite(patch.accel.baseGain)
          ? Math.max(1, Math.trunc(patch.accel.baseGain))
          : this.accel.baseGain
      const maxGain =
        typeof patch.accel.maxGain === 'number' && Number.isFinite(patch.accel.maxGain)
          ? Math.max(baseGain, Math.trunc(patch.accel.maxGain))
          : this.accel.maxGain
      const vel =
        typeof patch.accel.velocityPxPerSecForMax === 'number' &&
        Number.isFinite(patch.accel.velocityPxPerSecForMax)
          ? Math.max(1, Math.trunc(patch.accel.velocityPxPerSecForMax))
          : this.accel.velocityPxPerSecForMax

      this.accel = { enabled, baseGain, maxGain, velocityPxPerSecForMax: vel }
      applied.accel = { enabled, baseGain, maxGain, velocityPxPerSecForMax: vel }
    }

    if (patch.absoluteGrid) {
      this.absoluteGrid = patch.absoluteGrid
      const resolved = this.resolveGridFromConfig(patch.absoluteGrid)
      this.movement.gridResolved = resolved
      applied.absoluteGrid = patch.absoluteGrid
      this.clearMovementState('config-absolute-grid-change')
    }

    return applied
  }

  /* ---------------------------------------------------------------------- */
  /*  Enqueue core                                                           */
  /* ---------------------------------------------------------------------- */

  private enqueueOp(op: MouseOperation, createdAt: number, execute: () => Promise<void>): MouseOperationHandle {
    let resolve!: (res: MouseOperationResult) => void
    let reject!: (res: MouseOperationResult) => void

    const done = new Promise<MouseOperationResult>((res, rej) => {
      resolve = res
      reject = rej
    })

    if (this.hostPower === 'off') {
      this.events.publish({ kind: 'mouse-operation-queued', op })
      this.events.publish({ kind: 'mouse-operation-cancelled', opId: op.id, reason: 'host-power-off' })

      resolve({
        id: op.id,
        kind: op.kind,
        ok: false,
        startedAt: undefined,
        finishedAt: safeNow(),
        error: new Error('cancelled: host-power-off'),
      })

      return { id: op.id, kind: op.kind, createdAt, done }
    }

    this.queue.push({ op, execute, resolve, reject })
    this.events.publish({ kind: 'mouse-operation-queued', op })
    this.emitQueueDepth()
    void this.processQueue()

    return { id: op.id, kind: op.kind, createdAt, done }
  }

  private async processQueue(): Promise<void> {
    if (this.active || this.queue.length === 0) return

    const next = this.queue.shift()!
    this.active = next
    this.emitQueueDepth()

    if (this.hostPower === 'off') {
      this.events.publish({ kind: 'mouse-operation-cancelled', opId: next.op.id, reason: 'host-power-off' })
      next.resolve({
        id: next.op.id,
        kind: next.op.kind,
        ok: false,
        startedAt: undefined,
        finishedAt: safeNow(),
        error: new Error('cancelled: host-power-off'),
      })
      this.active = null
      this.emitQueueDepth()
      void this.processQueue()
      return
    }

    this.events.publish({ kind: 'mouse-operation-started', op: next.op })
    const startedAt = safeNow()

    try {
      await next.execute()

      const res: MouseOperationResult = {
        id: next.op.id,
        kind: next.op.kind,
        ok: true,
        startedAt,
        finishedAt: safeNow(),
      }

      next.resolve(res)
      this.events.publish({ kind: 'mouse-operation-completed', result: res })
    } catch (err) {
      if (err instanceof CancelledError) {
        this.events.publish({ kind: 'mouse-operation-cancelled', opId: next.op.id, reason: err.reason })
        next.resolve({
          id: next.op.id,
          kind: next.op.kind,
          ok: false,
          startedAt,
          finishedAt: safeNow(),
          error: new Error(`cancelled: ${err.reason}`),
        })
      } else {
        const e = err instanceof Error ? err : new Error('unknown error')
        const res: MouseOperationResult = {
          id: next.op.id,
          kind: next.op.kind,
          ok: false,
          startedAt,
          finishedAt: safeNow(),
          error: e,
        }

        next.reject(res)
        this.events.publish({ kind: 'mouse-operation-failed', result: res })
        this.events.publish({ kind: 'recoverable-error', error: e })
      }
    } finally {
      if (this.activeCancel?.opId === next.op.id) this.activeCancel = null
      this.active = null
      this.emitQueueDepth()
      void this.processQueue()
    }
  }

  private emitQueueDepth(): void {
    this.events.publish({ kind: 'mouse-queue-depth', depth: this.queue.length })
  }

  /* ---------------------------------------------------------------------- */
  /*  Serial lifecycle                                                       */
  /* ---------------------------------------------------------------------- */

  private async openPort(baudRate: number): Promise<void> {
    const path = this.devicePath
    const id = this.deviceId
    if (!path || !id) return
    if (this.stopping) return

    if (this.openInFlight) return this.openInFlight
    this.clearReconnectTimer()

    this.openInFlight = (async () => {
      if (this.port?.isOpen) {
        await this.closePort('unknown')
      }

      this.phase = 'connecting'
      this.identified = false

      // Reset identify FIFO for the new connection.
      this.failAllPendingLineWaiters(new Error('superseded by new connection'))
      this.pendingLines = []

      const port = new SerialPort({
        path,
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
          error: err instanceof Error ? err : new Error('open failed'),
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
      this.readBuffer = ''
      this.buttonsDown.clear()
      this.reconnectAttempts = 0

      this.clearMovementState('reconnect')
      this.cancelAll('reconnect')

      this.events.publish({ kind: 'mouse-device-connected', id, path, baudRate })

      port.on('data', (buf: Buffer) => this.handleData(buf.toString('utf8')))
      port.on('error', (e: Error) => this.handlePortError(port, e))
      port.on('close', () => this.handlePortClose(port))

      try {
        await this.identify(id, path, baudRate)
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
    const id = this.deviceId
    const path = this.devicePath

    // Fail any identify waiters promptly so identify() can't hang.
    this.failAllPendingLineWaiters(new Error(`port closed: ${reason}`))
    this.pendingLines = []

    this.requestCancelActiveOp(`device-disconnected:${reason}`)
    this.cancelAll(`device-disconnected:${reason}`)
    this.clearMovementState(`device-disconnected:${reason}`)
    this.buttonsDown.clear()

    this.port = null
    this.identified = false
    this.phase = 'disconnected'
    this.readBuffer = ''

    if (port && port.isOpen) {
      this.closingPort = port
      await new Promise<void>((resolve) => port.close(() => resolve()))
      this.closingPort = null
    }

    if (id && path) {
      this.events.publish({ kind: 'mouse-device-disconnected', id, path, reason })
    }
  }

  private async identify(id: string, path: string, baudRate: number): Promise<void> {
    if (!this.port) return

    this.phase = 'identifying'
    this.events.publish({ kind: 'mouse-identify-start', path })

    // Match Arduino sketch:
    // - request: "identify" => device prints "MS"
    // - completion: "identify_complete" => device marks identified
    const req = (this.cfg.identify as any)?.request ?? 'identify'
    const completion = (this.cfg.identify as any)?.completion ?? 'identify_complete'
    const expected = String((this.cfg.identify as any)?.expectedToken ?? '').trim()
    const timeoutMsRaw = (this.cfg.identify as any)?.timeoutMs
    const timeoutMs =
      typeof timeoutMsRaw === 'number' && Number.isFinite(timeoutMsRaw)
        ? Math.max(1, Math.trunc(timeoutMsRaw))
        : 5000

    if (!expected) throw new Error('missing identify.expectedToken')

    try {
      await this.writeLine(req)

      const deadline = safeNow() + timeoutMs
      let lastNonNoise: string | null = null
      let token: string | null = null

      while (token == null) {
        const remaining = deadline - safeNow()
        if (remaining <= 0) break

        const line = await this.takeNextLine(remaining)
        const t = line.trim()
        if (!t) continue

        // Arduino emits "debug:" lines (including power status) that can appear before the ID token.
        if (t.startsWith('debug:') || t.startsWith('done:')) {
          continue
        }

        lastNonNoise = t

        if (t === expected) {
          token = t
          break
        }
      }

      if (!token) {
        throw new Error(`unexpected identify token: ${lastNonNoise ?? '(timeout/noise)'}`)
      }

      await this.writeLine(completion)

      this.identified = true
      this.phase = 'ready'

      this.events.publish({ kind: 'mouse-identify-success', token })
      this.events.publish({ kind: 'mouse-device-identified', id, path, baudRate, token })
    } catch (err) {
      this.identified = false
      this.phase = 'error'
      this.events.publish({
        kind: 'mouse-identify-failed',
        error: err instanceof Error ? err : new Error('identify failed'),
      })
      throw err
    }
  }

  /**
   * Serialize all writes to the port to prevent interleaving bytes between
   * movement ticks and discrete operations.
   */
  private queueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeSeq.then(fn, fn)
    this.writeSeq = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async writeLine(line: string): Promise<void> {
    // Cancellation is per-active-op; movement tick has no active op and is allowed.
    this.assertActiveOpNotCancelled()

    return this.queueWrite(async () => {
      // Re-check on execution; port could have closed while waiting in the write queue.
      this.assertActiveOpNotCancelled()
      if (!this.port || !this.port.isOpen) throw new Error('port not open')

      const eol = ((this.cfg.identify as any)?.writeLineEnding ?? '\n') as string

      await new Promise<void>((resolve, reject) => {
        this.port!.write(`${line}${eol}`, (err) => {
          if (err) return reject(err)
          this.port!.drain((e) => (e ? reject(e) : resolve()))
        })
      })
    })
  }

  private takeNextLine(timeoutMs: number): Promise<string> {
    const immediate = this.pendingLines.shift()
    if (immediate != null) return Promise.resolve(immediate)

    const t = Math.max(0, Math.trunc(timeoutMs))

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
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
    if (this.pendingLines.length > PS2MouseService.MAX_PENDING_LINES) {
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

    const parts = this.readBuffer.split(/\r\n|\n|\r/)
    this.readBuffer = parts.pop() ?? ''

    for (const raw of parts) {
      const line = raw.trim()
      if (!line) continue

      if (!this.identified) {
        this.enqueuePendingLine(line)
      }

      this.events.publish({ kind: 'mouse-debug-line', line } as any)
    }

    // Safety valve: flush runaway tail (partial line spam protection).
    const MAX_TAIL = 256
    if (this.readBuffer.length > MAX_TAIL) {
      const tail = this.readBuffer.trim()
      if (tail) this.events.publish({ kind: 'mouse-debug-line', line: tail } as any)
      this.readBuffer = ''
    }
  }

  private handlePortError(port: SerialPort, err: Error): void {
    if (port !== this.port) return
    if (this.closingPort === port) return

    void (async () => {
      this.events.publish({ kind: 'recoverable-error', error: err })
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
    if (!this.devicePath || !this.deviceId) return

    this.clearReconnectTimer()

    const maxAttempts = 10
    if (this.reconnectAttempts >= maxAttempts) {
      this.events.publish({ kind: 'fatal-error', error: new Error('reconnect attempts exhausted') })
      return
    }

    this.reconnectAttempts++
    const delay = Math.min(250 * 2 ** (this.reconnectAttempts - 1), 5000)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopping) return
      void this.openPort(this.cfg.serial.baudRate)
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Movement tick flush (spec v0.3 §8)                                     */
  /* ---------------------------------------------------------------------- */

  private ensureMoveTickRunning(): void {
    if (this.moveLoopActive) return

    this.moveLoopActive = true

    const hz = Math.max(1, Math.trunc(this.cfg.movement.tickHz))
    const intervalMs = Math.max(1, Math.floor(1000 / hz))

    const tick = async () => {
      if (!this.moveLoopActive) return
      await this.flushMovementTick()
      if (!this.moveLoopActive) return

      // schedule AFTER await => no overlap
      this.moveTimer = setTimeout(() => void tick(), intervalMs)
    }

    // start the loop
    this.moveTimer = setTimeout(() => void tick(), intervalMs)
  }

  private stopMoveTick(): void {
    this.moveLoopActive = false
    if (this.moveTimer) {
      clearTimeout(this.moveTimer)
      this.moveTimer = null
    }
  }

private async flushMovementTick(): Promise<void> {
  if (this.stopping) return
  if (this.hostPower === 'off') return
  if (!this.port || !this.port.isOpen || !this.identified) return

  const max = clampInt(this.cfg.movement.perTickMaxDelta, 1, 255)
  const mode = this.movement.mode

  // IMPORTANT:
  // Firmware clamps *deltas* to ±255 => MOVE must be sent as dx,dy (deltas).
  // Absolute mode uses an internal grid only to compute per-tick deltas.
  if (mode === 'absolute') {
    const target = this.movement.absTarget
    if (!target) return

    const grid = this.getGridForClamping()

    // Keep cursor in-bounds for absolute stepping (grid coords).
    this.movement.cursor.x = clampInt(this.movement.cursor.x, 0, grid.w - 1)
    this.movement.cursor.y = clampInt(this.movement.cursor.y, 0, grid.h - 1)

    const cur = this.movement.cursor

    let stepDx = clampInt(target.x - cur.x, -max, max)
    let stepDy = clampInt(target.y - cur.y, -max, max)
    if (stepDx === 0 && stepDy === 0) return

    const nextX = clampInt(cur.x + stepDx, 0, grid.w - 1)
    const nextY = clampInt(cur.y + stepDy, 0, grid.h - 1)

    // If clamping collapses movement, do not send.
    if (nextX === cur.x && nextY === cur.y) return

    // Recompute deltas after clamping (ensures wire deltas match committed cursor change).
    stepDx = nextX - cur.x
    stepDy = nextY - cur.y
    if (stepDx === 0 && stepDy === 0) return

    try {
      await this.writeLine(`MOVE ${stepDx},${stepDy}`)

      this.movement.cursor.x = nextX
      this.movement.cursor.y = nextY

      const now = safeNow()
      const last = this.movement.lastMoveTickEvtAt
      const shouldEmit = last == null || now - last >= 250
      if (shouldEmit) {
        this.movement.lastMoveTickEvtAt = now
        this.events.publish({
          kind: 'mouse-move-tick',
          x: nextX,
          y: nextY,
          dx: stepDx,
          dy: stepDy,
          mode,
        })
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error('movement tick failed')
      this.events.publish({ kind: 'recoverable-error', error: e })
    }

    return
  }

  // Relative modes:
  // - Always send dx,dy deltas (bounded per tick).
  // - DO NOT clamp to any grid (prevents artificial "edges").
  const acc = this.movement.relAcc
  const consume = (v: number): number => {
    if (!Number.isFinite(v) || v === 0) return 0
    const mag = Math.min(Math.abs(v), max)
    return v < 0 ? -mag : mag
  }

  const stepDx = Math.trunc(consume(acc.dx))
  const stepDy = Math.trunc(consume(acc.dy))
  if (stepDx === 0 && stepDy === 0) return

  try {
    await this.writeLine(`MOVE ${stepDx},${stepDy}`)

    // Commit only after success.
    acc.dx -= stepDx
    acc.dy -= stepDy

    // Cursor is "virtual" in relative mode (unbounded); used only for logs/telemetry.
    const nextX = this.movement.cursor.x + stepDx
    const nextY = this.movement.cursor.y + stepDy
    this.movement.cursor.x = nextX
    this.movement.cursor.y = nextY

    const now = safeNow()
    const last = this.movement.lastMoveTickEvtAt
    const shouldEmit = last == null || now - last >= 250
    if (shouldEmit) {
      this.movement.lastMoveTickEvtAt = now
      this.events.publish({
        kind: 'mouse-move-tick',
        x: nextX,
        y: nextY,
        dx: stepDx,
        dy: stepDy,
        mode,
      })
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error('movement tick failed')
    this.events.publish({ kind: 'recoverable-error', error: e })
  }
}


  /* ---------------------------------------------------------------------- */
  /*  Grid resolution helpers (spec v0.3 §9)                                 */
  /* ---------------------------------------------------------------------- */

  private resolveGridFromConfig(cfg: MouseAbsoluteGridConfig): Grid | null {
    if (cfg.mode === 'fixed') {
      // Safety: validate at runtime as well (protects against malformed WS patches)
      const w = (cfg as any)?.fixed?.w
      const h = (cfg as any)?.fixed?.h
      if (typeof w === 'number' && typeof h === 'number' && Number.isFinite(w) && Number.isFinite(h)) {
        const iw = Math.max(1, Math.trunc(w))
        const ih = Math.max(1, Math.trunc(h))
        return { w: iw, h: ih }
      }
      return null
    }
    return null
  }

  private getGridForClamping(): Grid {
    return this.movement.gridResolved ?? { w: 1024, h: 768 }
  }

  private getGridForAbsoluteMapping(): Grid {
    const resolved = this.movement.gridResolved
    if (resolved) return resolved

    if (!this.movement.warnedUnknownGrid) {
      this.movement.warnedUnknownGrid = true
      this.events.publish({
        kind: 'recoverable-error',
        error: new Error(
          'ps2-mouse absolute mapping: unknown resolution in auto grid mode; using fallback 1024x768'
        ),
      })
    }

    return { w: 1024, h: 768 }
  }

  private clearMovementState(_why: string): void {
    this.movement.absTarget = null
    this.movement.relAcc.dx = 0
    this.movement.relAcc.dy = 0
    this.movement.lastRelAt = null
  }

  /* ---------------------------------------------------------------------- */
  /*  Guards + host-power policy                                             */
  /* ---------------------------------------------------------------------- */

  private async ensureReady(): Promise<void> {
    if (!this.port || !this.port.isOpen) throw new Error('port not open')
    if (!this.identified) throw new Error('device not identified')
    this.assertActiveOpNotCancelled()
  }

  private assertOpsAllowed(): void {
    if (this.hostPower === 'off') throw new CancelledError('host-power-off')
  }

  /* ---------------------------------------------------------------------- */
  /*  Cancellation helpers                                                   */
  /* ---------------------------------------------------------------------- */

  private requestCancelActiveOp(reason: string): void {
    if (!this.active) return
    this.activeCancel = { opId: this.active.op.id, reason }
  }

  private assertActiveOpNotCancelled(): void {
    if (!this.active || !this.activeCancel) return
    if (this.activeCancel.opId !== this.active.op.id) return
    throw new CancelledError(this.activeCancel.reason)
  }

  private cancelQueuedOps(reason: string): void {
    if (this.queue.length === 0) return

    const queued = this.queue.splice(0, this.queue.length)
    for (const q of queued) {
      this.events.publish({ kind: 'mouse-operation-cancelled', opId: q.op.id, reason })
      q.resolve({
        id: q.op.id,
        kind: q.op.kind,
        ok: false,
        startedAt: undefined,
        finishedAt: safeNow(),
        error: new Error(`cancelled: ${reason}`),
      })
    }

    this.emitQueueDepth()
  }

  private async sleepCancellable(ms: number): Promise<void> {
    const total = Math.max(0, Math.trunc(ms))
    const start = safeNow()
    while (safeNow() - start < total) {
      this.assertActiveOpNotCancelled()
      await sleep(Math.min(25, total - (safeNow() - start)))
    }
    this.assertActiveOpNotCancelled()
  }
}
