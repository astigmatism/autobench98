// services/orchestrator/src/adapters/ps2Mouse.adapter.ts

import type {
  PS2MouseEvent,
  PS2MouseStateSlice,
  PS2MousePhase,
  MousePowerState,
  MouseOperation,
  MouseOperationKind,
  MouseOperationResult,
  MouseErrorSnapshot,
  MouseOperationSnapshot,
  MouseOperationHistoryItem,
  MouseButton,
  MouseReportingState,
  MouseProtocolMode,
  MouseMoveMode,
  MouseAccelConfig,
  MouseAbsoluteGridConfig,
  MouseMappingStatus,
} from '../devices/ps2-mouse/types.js'

/* -------------------------------------------------------------------------- */
/*  Adapter contract                                                          */
/* -------------------------------------------------------------------------- */

export type PS2MouseEventSink = {
  publish: (evt: PS2MouseEvent) => void
}

export type PS2MouseAdapter = {
  /** Event sink to hand to PS2MouseService */
  sink: PS2MouseEventSink
  /** Current device slice snapshot */
  getSnapshot: () => PS2MouseStateSlice
}

/**
 * Integration point:
 * - If you have a global AppState store, pass `onSlice` to apply the snapshot.
 * - Otherwise you can just read `getSnapshot()` for debugging / tests.
 */
export function createPS2MouseAdapter(opts: {
  onSlice?: (next: PS2MouseStateSlice, prev: PS2MouseStateSlice, meta: { evt: PS2MouseEvent }) => void
  now?: () => number
  maxErrorHistory?: number
  maxOperationHistory?: number
  initial?: Partial<PS2MouseStateSlice>
}): PS2MouseAdapter {
  const now = opts.now ?? (() => Date.now())
  const maxErrorHistory = clampInt(opts.maxErrorHistory ?? 25, 0, 500)
  const maxOperationHistory = clampInt(opts.maxOperationHistory ?? 100, 0, 2000)

  let slice: PS2MouseStateSlice = applyInitial(createInitialSlice(now()), opts.initial)

  const publish = (evt: PS2MouseEvent) => {
    const prev = slice
    const next = reduce(prev, evt, {
      now,
      maxErrorHistory,
      maxOperationHistory,
    })

    slice = next

    if (opts.onSlice && next !== prev) {
      try {
        opts.onSlice(next, prev, { evt })
      } catch {
        // adapter must never throw; device control must remain stable
      }
    }
  }

  return {
    sink: { publish },
    getSnapshot: () => slice,
  }
}

/* -------------------------------------------------------------------------- */
/*  Reducer                                                                   */
/* -------------------------------------------------------------------------- */

type ReduceCtx = {
  now: () => number
  maxErrorHistory: number
  maxOperationHistory: number
}

function reduce(prev: PS2MouseStateSlice, evt: PS2MouseEvent, ctx: ReduceCtx): PS2MouseStateSlice {
  const t = ctx.now()

  // Only allocate when something actually changes (prevents patch spam).
  const set = (patch: Partial<PS2MouseStateSlice>): PS2MouseStateSlice => {
    let changed = false
    for (const k of Object.keys(patch) as (keyof PS2MouseStateSlice)[]) {
      if (!Object.is(prev[k], patch[k])) {
        changed = true
        break
      }
    }
    if (!changed) return prev
    return { ...prev, ...patch, updatedAt: t }
  }

  const kind = (evt as any).kind as string

  switch (kind) {
    /* ------------------------- Lifecycle / identity ---------------------- */

    case 'mouse-device-connected': {
      const e = evt as any
      return set({
        phase: 'connecting',
        deviceId: typeof e.id === 'string' ? e.id : prev.deviceId,
        devicePath: typeof e.path === 'string' ? e.path : prev.devicePath,
        baudRate: isFiniteNumber(e.baudRate) ? e.baudRate : prev.baudRate,
        identified: false,

        busy: false,
        queueDepth: 0,
        currentOp: null,

        // reconnect semantics: fresh session; clear transient protocol + buttons
        buttonsDown: { left: false, right: false, middle: false },
        reporting: 'unknown',
        protocolMode: 'unknown',
        lastHostCommand: null,
        lastDeviceId: null,
      })
    }

    case 'mouse-device-identified': {
      const e = evt as any
      return set({
        phase: 'ready',
        deviceId: typeof e.id === 'string' ? e.id : prev.deviceId,
        devicePath: typeof e.path === 'string' ? e.path : prev.devicePath,
        baudRate: isFiniteNumber(e.baudRate) ? e.baudRate : prev.baudRate,
        identified: true,
      })
    }

    case 'mouse-identify-start': {
      // If the slice supports 'identifying', use it; otherwise stay on 'connecting'.
      const nextPhase: PS2MousePhase =
        isPhaseIdentifyingSupported(prev.phase) ? 'identifying' : 'connecting'
      return set({ phase: nextPhase })
    }

    case 'mouse-identify-success': {
      return set({ phase: 'ready', identified: true })
    }

    case 'mouse-identify-failed': {
      const e = evt as any
      const msg = errorToString(e.error) ?? 'identify failed'
      return applyError(set({ phase: 'error', identified: false }), ctx, t, msg)
    }

    case 'mouse-device-disconnected': {
      const e = evt as any
      return set({
        phase: 'disconnected',
        identified: false,
        deviceId: typeof e.id === 'string' ? e.id : prev.deviceId,
        devicePath: typeof e.path === 'string' ? e.path : prev.devicePath,
        baudRate: prev.baudRate,

        busy: false,
        queueDepth: 0,
        currentOp: null,

        buttonsDown: { left: false, right: false, middle: false },
        reporting: 'unknown',
        protocolMode: 'unknown',
        lastHostCommand: null,
        lastDeviceId: null,
      })
    }

    case 'mouse-device-lost': {
      const e = evt as any
      return set({
        phase: 'disconnected',
        identified: false,
        deviceId: typeof e.id === 'string' ? e.id : prev.deviceId,
        devicePath: null,
        baudRate: null,

        busy: false,
        queueDepth: 0,
        currentOp: null,

        buttonsDown: { left: false, right: false, middle: false },
        reporting: 'unknown',
        protocolMode: 'unknown',
        lastHostCommand: null,
        lastDeviceId: null,
      })
    }

    /* ------------------------- Host power coordination ------------------- */

    case 'mouse-host-power-changed': {
      const e = evt as any
      const power: MousePowerState =
        e.power === 'on' || e.power === 'off' || e.power === 'unknown' ? e.power : 'unknown'
      return set({ hostPower: power })
    }

    /* ------------------------- Desktop / mapping (optional/back-compat) -- */

    case 'mouse-absolute-grid': {
      // optional event: service may emit when grid mode/fixed/resolved changes
      const e = evt as any
      const next = { ...prev.absoluteGrid }

      if (e.mode === 'auto' || e.mode === 'fixed') next.mode = e.mode

      if (e.fixed && isFiniteNumber(e.fixed.w) && isFiniteNumber(e.fixed.h)) {
        next.fixed = { w: e.fixed.w, h: e.fixed.h }
      }

      if (e.resolved && isFiniteNumber(e.resolved.w) && isFiniteNumber(e.resolved.h)) {
        next.resolved = { w: e.resolved.w, h: e.resolved.h }
      }

      return set({ absoluteGrid: next })
    }

    case 'mouse-mapping-status': {
      const e = evt as any
      const status: MouseMappingStatus =
        e.mappingStatus === 'ok' || e.mappingStatus === 'unknown-resolution'
          ? e.mappingStatus
          : prev.mappingStatus
      return set({ mappingStatus: status })
    }

    case 'mouse-desktop-profile': {
      // Back-compat / convenience event: treat it as “resolved absolute grid”.
      const e = evt as any
      if (!isFiniteNumber(e.width) || !isFiniteNumber(e.height)) return prev

      return set({
        absoluteGrid: {
          ...prev.absoluteGrid,
          resolved: { w: e.width, h: e.height },
        },
        mappingStatus: 'ok',
      })
    }

    /* ------------------------- Input signal (timestamps + buttons) ------- */

    case 'mouse-move': {
      // back-compat alias
      return set({ lastMoveAt: t })
    }

    case 'mouse-move-tick': {
      return set({ lastMoveAt: t })
    }

    case 'mouse-wheel': {
      return set({ lastWheelAt: t })
    }

    case 'mouse-button': {
      const e = evt as any
      const btn: MouseButton | null =
        e.button === 'left' || e.button === 'right' || e.button === 'middle' ? e.button : null

      // Current spec: 'down' | 'up' | 'click'
      // Back-compat: 'press' | 'release'
      const actionRaw = e.action
      const action:
        | 'down'
        | 'up'
        | 'click'
        | 'press'
        | 'release'
        | null =
        actionRaw === 'down' || actionRaw === 'up' || actionRaw === 'click' || actionRaw === 'press' || actionRaw === 'release'
          ? actionRaw
          : null

      if (!btn || !action) return prev

      const prevButtons = prev.buttonsDown
      const nextButtons = { ...prevButtons }

      // noOp => do not mutate buttonsDown, but still update lastButtonAt
      const noOp = !!e.noOp

      if (!noOp) {
        const isDown = action === 'down' || action === 'press'
        const isUp = action === 'up' || action === 'release'
        const isClick = action === 'click'

        if (btn === 'left') {
          if (isDown) nextButtons.left = true
          if (isUp || isClick) nextButtons.left = false
        } else if (btn === 'right') {
          if (isDown) nextButtons.right = true
          if (isUp || isClick) nextButtons.right = false
        } else {
          if (isDown) nextButtons.middle = true
          if (isUp || isClick) nextButtons.middle = false
        }
      }

      const same =
        nextButtons.left === prevButtons.left &&
        nextButtons.right === prevButtons.right &&
        nextButtons.middle === prevButtons.middle

      if (same) return set({ lastButtonAt: t })
      return set({ buttonsDown: nextButtons, lastButtonAt: t })
    }

    case 'mouse-debug-line': {
      return prev
    }

    /* ------------------------- Config applied (spec v0.3 §7.4) ----------- */

    case 'mouse-config-applied': {
      const e = evt as any
      const patch = e.patch as
        | {
            mode?: MouseMoveMode
            gain?: number
            accel?: MouseAccelConfig
            absoluteGrid?: MouseAbsoluteGridConfig
          }
        | undefined

      if (!patch) return prev

      let next: PS2MouseStateSlice = prev

      if (patch.mode) {
        next = next === prev ? set({ mode: patch.mode }) : { ...next, mode: patch.mode, updatedAt: t }
      }

      if (isFiniteNumber(patch.gain)) {
        const g = Math.max(1, Math.trunc(patch.gain))
        if (g !== next.gain) {
          next = next === prev ? set({ gain: g }) : { ...next, gain: g, updatedAt: t }
        }
      }

      if (patch.accel) {
        const enabled = !!patch.accel.enabled
        const baseGain = isFiniteNumber(patch.accel.baseGain) ? Math.max(1, Math.trunc(patch.accel.baseGain)) : next.accel.baseGain
        const maxGain = isFiniteNumber(patch.accel.maxGain) ? Math.max(baseGain, Math.trunc(patch.accel.maxGain)) : next.accel.maxGain
        const vel = isFiniteNumber(patch.accel.velocityPxPerSecForMax)
          ? Math.max(1, Math.trunc(patch.accel.velocityPxPerSecForMax))
          : next.accel.velocityPxPerSecForMax

        const accelNext = { enabled, baseGain, maxGain, velocityPxPerSecForMax: vel }
        const accelSame =
          next.accel.enabled === accelNext.enabled &&
          next.accel.baseGain === accelNext.baseGain &&
          next.accel.maxGain === accelNext.maxGain &&
          next.accel.velocityPxPerSecForMax === accelNext.velocityPxPerSecForMax

        if (!accelSame) {
          next = next === prev ? set({ accel: accelNext }) : { ...next, accel: accelNext, updatedAt: t }
        }
      }

      if (patch.absoluteGrid) {
        const abs = patch.absoluteGrid
        const resolved = abs.mode === 'fixed' ? { w: abs.fixed.w, h: abs.fixed.h } : undefined
        const absoluteGrid = abs.mode === 'fixed'
          ? { mode: 'fixed' as const, fixed: abs.fixed, resolved }
          : { mode: 'auto' as const, resolved: undefined }

        const mappingStatus: MouseMappingStatus = abs.mode === 'fixed' ? 'ok' : 'unknown-resolution'

        const sameMode = next.absoluteGrid.mode === absoluteGrid.mode
        const sameFixed =
          (next.absoluteGrid.fixed?.w ?? null) === (absoluteGrid.fixed?.w ?? null) &&
          (next.absoluteGrid.fixed?.h ?? null) === (absoluteGrid.fixed?.h ?? null)
        const sameResolved =
          (next.absoluteGrid.resolved?.w ?? null) === (absoluteGrid.resolved?.w ?? null) &&
          (next.absoluteGrid.resolved?.h ?? null) === (absoluteGrid.resolved?.h ?? null)
        const sameMapping = next.mappingStatus === mappingStatus

        if (!sameMode || !sameFixed || !sameResolved || !sameMapping) {
          next =
            next === prev
              ? set({ absoluteGrid, mappingStatus })
              : { ...next, absoluteGrid, mappingStatus, updatedAt: t }
        }
      }

      return next
    }

    /* ------------------------- Protocol observability -------------------- */

    case 'mouse-reporting-changed': {
      // back-compat alias
      const e = evt as any
      const reporting: MouseReportingState =
        e.reporting === 'enabled' || e.reporting === 'disabled' || e.reporting === 'unknown'
          ? e.reporting
          : prev.reporting
      return set({ reporting })
    }

    case 'mouse-protocol-mode-changed': {
      // back-compat alias
      const e = evt as any
      const protocolMode: MouseProtocolMode =
        e.protocolMode === 'standard' || e.protocolMode === 'intellimouse' || e.protocolMode === 'unknown'
          ? e.protocolMode
          : prev.protocolMode
      return set({ protocolMode })
    }

    case 'mouse-protocol-reporting': {
      const e = evt as any
      const reporting: MouseReportingState =
        e.reporting === 'enabled' || e.reporting === 'disabled' || e.reporting === 'unknown'
          ? e.reporting
          : prev.reporting
      return set({ reporting })
    }

    case 'mouse-protocol-mode': {
      const e = evt as any
      const protocolMode: MouseProtocolMode =
        e.protocolMode === 'standard' || e.protocolMode === 'intellimouse' || e.protocolMode === 'unknown'
          ? e.protocolMode
          : prev.protocolMode
      return set({ protocolMode })
    }

    case 'mouse-host-command': {
      const e = evt as any
      if (!isFiniteNumber(e.byte)) return prev
      return set({
        lastHostCommand: {
          at: isFiniteNumber(e.at) ? e.at : t,
          byte: clampInt(e.byte, 0, 255),
          name: typeof e.name === 'string' ? e.name : undefined,
        },
      })
    }

    case 'mouse-device-id': {
      const e = evt as any
      if (!isFiniteNumber(e.id)) return prev
      return set({
        lastDeviceId: {
          at: isFiniteNumber(e.at) ? e.at : t,
          id: clampInt(e.id, 0, 255),
        },
      })
    }

    /* ------------------------- Queue / operations ------------------------ */

    case 'mouse-queue-depth': {
      const e = evt as any
      const depth = clampInt(e.depth, 0, 1_000_000)
      const busy = depth > 0 || prev.currentOp !== null
      return set({ queueDepth: depth, busy })
    }

    case 'mouse-operation-queued': {
      return prev
    }

    case 'mouse-operation-started': {
      const e = evt as any
      const op = e.op as MouseOperation | undefined
      if (!op) return prev
      const nextCurrent = opToSnapshot(op, t)
      return set({ currentOp: nextCurrent, busy: true })
    }

    case 'mouse-operation-completed': {
      const e = evt as any
      const result = e.result as MouseOperationResult | undefined
      if (!result) return prev
      return applyResult(prev, ctx, t, result)
    }

    case 'mouse-operation-failed': {
      const e = evt as any
      if (e.result) return applyResult(prev, ctx, t, e.result as MouseOperationResult)

      if (!prev.currentOp) return prev
      const item: MouseOperationHistoryItem = {
        id: prev.currentOp.id,
        kind: prev.currentOp.kind,
        requestedBy: prev.currentOp.requestedBy,
        queuedAt: prev.currentOp.queuedAt,
        startedAt: prev.currentOp.startedAt,
        finishedAt: t,
        ok: false,
        error: 'operation failed',
      }
      const next = pushHistory(set({ currentOp: null, busy: prev.queueDepth > 0 }), ctx, item)
      return applyError(next, ctx, t, item.error ?? 'operation failed')
    }

    case 'mouse-operation-cancelled': {
      const e = evt as any
      const opId = typeof e.opId === 'string' ? e.opId : ''
      const reason = typeof e.reason === 'string' && e.reason.trim() ? e.reason.trim() : 'cancelled'

      const cur = prev.currentOp
      const item: MouseOperationHistoryItem =
        cur && cur.id === opId
          ? {
              id: cur.id,
              kind: cur.kind,
              requestedBy: cur.requestedBy,
              queuedAt: cur.queuedAt,
              startedAt: cur.startedAt,
              finishedAt: t,
              ok: false,
              error: reason,
            }
          : {
              id: opId || `unknown-${t}`,
              kind: guessKindForUnknownCancelled(),
              requestedBy: 'unknown',
              queuedAt: t,
              finishedAt: t,
              ok: false,
              error: reason,
            }

      const cleared = cur && cur.id === opId ? null : prev.currentOp
      return pushHistory(set({ currentOp: cleared, busy: prev.queueDepth > 0 || cleared !== null }), ctx, item)
    }

    /* ------------------------- Errors ------------------------------------ */

    case 'recoverable-error': {
      const e = evt as any
      const msg = errorToString(e.error) ?? 'recoverable error'
      return applyError(prev, ctx, t, msg)
    }

    case 'fatal-error': {
      const e = evt as any
      const msg = errorToString(e.error) ?? 'fatal error'
      const next = set({ phase: 'error' })
      return applyError(next, ctx, t, msg)
    }

    default: {
      return prev
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Result / history helpers                                                  */
/* -------------------------------------------------------------------------- */

function applyResult(prev: PS2MouseStateSlice, ctx: ReduceCtx, t: number, result: MouseOperationResult): PS2MouseStateSlice {
  const cur = prev.currentOp

  const item: MouseOperationHistoryItem =
    cur && cur.id === result.id
      ? {
          id: cur.id,
          kind: cur.kind,
          requestedBy: cur.requestedBy,
          queuedAt: cur.queuedAt,
          startedAt: cur.startedAt,
          finishedAt: result.finishedAt ?? t,
          ok: !!result.ok,
          error: result.ok ? undefined : errorToString(result.error) ?? 'operation failed',
        }
      : {
          id: result.id,
          kind: result.kind,
          requestedBy: 'unknown',
          queuedAt: t,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt ?? t,
          ok: !!result.ok,
          error: result.ok ? undefined : errorToString(result.error) ?? 'operation failed',
        }

  const cleared = cur && cur.id === result.id ? null : prev.currentOp
  const nextBase: PS2MouseStateSlice = {
    ...prev,
    currentOp: cleared,
    busy: prev.queueDepth > 0 || cleared !== null,
    updatedAt: t,
  }

  const next = pushHistory(nextBase, ctx, item)

  if (!item.ok && item.error) {
    return applyError(next, ctx, t, item.error)
  }

  // Clear lastError on success (keeps UI from “sticking” show error)
  return next.lastError ? { ...next, lastError: null, updatedAt: t } : next
}

function pushHistory(prev: PS2MouseStateSlice, ctx: ReduceCtx, item: MouseOperationHistoryItem): PS2MouseStateSlice {
  if (ctx.maxOperationHistory <= 0) return prev

  const history = prev.operationHistory.slice()
  history.push(item)
  if (history.length > ctx.maxOperationHistory) {
    history.splice(0, history.length - ctx.maxOperationHistory)
  }

  return { ...prev, operationHistory: history }
}

function applyError(prev: PS2MouseStateSlice, ctx: ReduceCtx, t: number, message: string): PS2MouseStateSlice {
  const next: PS2MouseStateSlice = {
    ...prev,
    lastError: message,
    updatedAt: t,
  }

  if (ctx.maxErrorHistory <= 0) return next

  const history = next.errorHistory.slice()
  const entry: MouseErrorSnapshot = { at: t, message }
  history.push(entry)

  if (history.length > ctx.maxErrorHistory) {
    history.splice(0, history.length - ctx.maxErrorHistory)
  }

  return { ...next, errorHistory: history }
}

/* -------------------------------------------------------------------------- */
/*  Operation mapping                                                         */
/* -------------------------------------------------------------------------- */

function opToSnapshot(op: MouseOperation, startedAt: number): MouseOperationSnapshot {
  return {
    id: op.id,
    kind: op.kind,
    requestedBy: op.requestedBy,
    queuedAt: op.queuedAt,
    startedAt,
  }
}

function guessKindForUnknownCancelled(): MouseOperationKind {
  return 'button'
}

/* -------------------------------------------------------------------------- */
/*  Slice creation                                                            */
/* -------------------------------------------------------------------------- */

function createInitialSlice(t: number): PS2MouseStateSlice {
  const phase: PS2MousePhase = 'disconnected'
  const hostPower: MousePowerState = 'unknown'

  return {
    phase,
    hostPower,
    identified: false,

    deviceId: null,
    devicePath: null,
    baudRate: null,

    busy: false,
    queueDepth: 0,
    currentOp: null,

    lastError: null,
    errorHistory: [],
    operationHistory: [],

    // movement config + mapping (match your state.ts defaults)
    mode: 'relative-gain',
    gain: 10,
    accel: {
      enabled: true,
      baseGain: 5,
      maxGain: 20,
      velocityPxPerSecForMax: 1000,
    },
    absoluteGrid: {
      mode: 'auto',
      fixed: undefined,
      resolved: undefined,
    },
    mappingStatus: 'unknown-resolution',

    buttonsDown: { left: false, right: false, middle: false },

    reporting: 'unknown',
    protocolMode: 'unknown',
    lastHostCommand: null,
    lastDeviceId: null,

    lastMoveAt: null,
    lastWheelAt: null,
    lastButtonAt: null,

    updatedAt: t,
  }
}

function applyInitial(base: PS2MouseStateSlice, initial?: Partial<PS2MouseStateSlice>): PS2MouseStateSlice {
  if (!initial) return base

  const errorHistory = Array.isArray(initial.errorHistory) ? initial.errorHistory : base.errorHistory
  const operationHistory = Array.isArray(initial.operationHistory) ? initial.operationHistory : base.operationHistory

  return {
    ...base,
    ...initial,
    errorHistory,
    operationHistory,
  }
}

/* -------------------------------------------------------------------------- */
/*  Small utilities                                                           */
/* -------------------------------------------------------------------------- */

function errorToString(err: unknown): string | undefined {
  if (!err) return undefined
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message || String(err)
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function clampInt(n: unknown, min: number, max: number): number {
  const x = typeof n === 'number' ? n : typeof n === 'string' ? Number(n) : NaN
  if (!Number.isFinite(x)) return min
  const i = Math.trunc(x)
  if (i < min) return min
  if (i > max) return max
  return i
}

// This lets us safely use 'identifying' when the union includes it (your current types do),
// while still compiling if an older branch removed it.
function isPhaseIdentifyingSupported(_phase: PS2MousePhase): boolean {
  return true
}
