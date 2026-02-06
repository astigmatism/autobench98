import { EventEmitter } from 'node:events'
import type { AppState, JsonValue, SliceChangeMeta, SliceKey, StatePatch, Version } from './types'
import { compareTopLevel } from './jsonPatch'
import { clone, deepEqual, deepFreeze, isPlainObject } from './utils'
import { deriveSliceKeysFromPatch, sliceKeysOverlap } from './sliceKeys'
import { createInitialState, type InitialStateOptions } from './initialState'

export type StateEvents = {
  patch: (msg: StatePatch) => void
  snapshot: (state: AppState) => void
}

export type SliceSubscriber<T> = {
  sliceKey: SliceKey
  selector: (s: AppState) => T
  onChange: (next: T, prev: T, meta: SliceChangeMeta) => void
  name?: string
  onError?: (err: unknown) => void
  isEnabled: boolean
}

export type SubscribeSliceOptions = {
  name?: string
  onError?: (err: unknown) => void
}

export type StateLogger = {
  debug?: (msg: string, meta?: Record<string, unknown>) => void
  info?: (msg: string, meta?: Record<string, unknown>) => void
  warn?: (msg: string, meta?: Record<string, unknown>) => void
  error?: (msg: string, meta?: Record<string, unknown>) => void
}

let logger: StateLogger = {
  warn: (msg, meta) => console.warn(msg, meta ?? {}),
  error: (msg, meta) => console.error(msg, meta ?? {})
}

export function setStateLogger(next: StateLogger) {
  logger = next
}

/**
 * stateEvents is used by the WS plugin (and optionally tests) to observe patch/snapshot changes.
 * This matches the websocket-pane guide, which expects an EventEmitter called stateEvents.
 */
export const stateEvents = new EventEmitter()

// Internal canonical state (frozen).
let state: AppState = deepFreeze(createInitialState())

// Commit serialization (single process; main thread).
let isCommitting = false

// Subscriber registry
const sliceSubs: Map<number, SliceSubscriber<any>> = new Map()
let nextSubId = 1

// Coalesced pending notification for slice subscribers
let pending:
  | {
      prev: AppState
      next: AppState
      changedSliceKeys: SliceKey[]
      toVersion: Version
    }
  | undefined

let flushScheduled = false
const idleWaiters: Array<() => void> = []

function emitIdleIfDrained() {
  if (!pending && !flushScheduled) {
    for (const resolve of idleWaiters.splice(0, idleWaiters.length)) resolve()
  }
}

function scheduleFlush() {
  if (flushScheduled) return
  flushScheduled = true
  queueMicrotask(() => flushSubscribers())
}

function flushSubscribers() {
  flushScheduled = false
  const notice = pending
  pending = undefined

  if (!notice) {
    emitIdleIfDrained()
    return
  }

  const meta: SliceChangeMeta = {
    toVersion: notice.toVersion,
    changedSliceKeys: notice.changedSliceKeys
  }

  for (const [id, sub] of sliceSubs) {
    if (!sub.isEnabled) continue

    const interested = meta.changedSliceKeys.some(k => sliceKeysOverlap(k, sub.sliceKey))
    if (!interested) continue

    try {
      const prevVal = sub.selector(notice.prev)
      const nextVal = sub.selector(notice.next)
      if (!deepEqual(prevVal, nextVal)) {
        sub.onChange(nextVal, prevVal, meta)
      }
    } catch (err) {
      // isolate failures
      logger.error?.('state.sliceSubscriber.error', {
        subscriber: sub.name ?? id,
        sliceKey: sub.sliceKey,
        error: err instanceof Error ? err.message : String(err)
      })
      sub.onError?.(err)
    }
  }

  // If new pending work was scheduled during subscriber dispatch, flush again.
  if (pending) scheduleFlush()
  emitIdleIfDrained()
}

function emitChanges(prev: AppState, next: AppState, changedSliceKeys?: SliceKey[]) {
  const patchOps = compareTopLevel(prev, next)

  if (patchOps.length > 0) {
    const msg: StatePatch = {
      from: prev.version,
      to: next.version,
      patch: patchOps
    }
    stateEvents.emit('patch', msg)
  }

  stateEvents.emit('snapshot', clone(next))

  // Internal slice pub/sub: async + coalesced.
  const derived = changedSliceKeys && changedSliceKeys.length > 0
    ? changedSliceKeys
    : deriveSliceKeysFromPatch(patchOps)

  if (!pending) {
    pending = { prev, next, changedSliceKeys: [...derived], toVersion: next.version }
  } else {
    // Preserve earliest prev; update to latest next.
    pending.next = next
    pending.toVersion = next.version
    // Union slice keys (dedup)
    const set = new Set<SliceKey>([...pending.changedSliceKeys, ...derived])
    pending.changedSliceKeys = Array.from(set)
  }

  scheduleFlush()
}

/**
 * Initialize/replace the current state at process start.
 * Call this once during orchestrator boot, from composition root/plugin wiring.
 */
export function initState(opts: InitialStateOptions = {}) {
  const prev = state
  const next = deepFreeze(createInitialState(opts))
  state = next
  emitChanges(prev, next, ['meta', 'config', 'devices', 'streams', 'jobs', 'pno', 'logs', 'serverConfig', 'power'])
}

/**
 * Read-only snapshot. Returns a cloned plain object to prevent accidental mutation.
 */
export function getSnapshot(): AppState {
  return clone(state)
}

/**
 * Replace the entire AppState (excluding version), bumping version once.
 * Prefer set()/merge()/commit() in most cases; this is primarily for resync/admin operations.
 */
export function replaceState(next: Omit<AppState, 'version'> & { version?: number }, changedSliceKeys?: SliceKey[]) {
  if (isCommitting) throw new Error('replaceState called during another commit')

  isCommitting = true
  try {
    const prev = state
    const baseVersion = typeof next.version === 'number' ? next.version : prev.version
    const updated: AppState = { ...(clone(next) as any), version: baseVersion + 1 } as AppState
    state = deepFreeze(updated)
    emitChanges(prev, state, changedSliceKeys)
  } finally {
    isCommitting = false
  }
}

/**
 * Set a TOP-LEVEL key of AppState and bump version once.
 * This matches the pattern in autobench98-websocket-pane-guide.md.
 */
export function set<K extends keyof AppState>(key: K, value: AppState[K], sliceKey: SliceKey = String(key)) {
  if (isCommitting) throw new Error('set called during another commit')

  isCommitting = true
  try {
    const prev = state
    const nextShallow = { ...state, [key]: clone(value) } as AppState
    const updated: AppState = { ...nextShallow, version: state.version + 1 }
    state = deepFreeze(updated)
    emitChanges(prev, state, [sliceKey])
  } finally {
    isCommitting = false
  }
}

/**
 * Shallow-merge a TOP-LEVEL object field of AppState.
 * - If the target is not a plain object, this throws.
 */
export function merge<K extends keyof AppState>(
  key: K,
  partial: Partial<AppState[K]>,
  sliceKey: SliceKey = String(key)
) {
  const current = (state as any)[key] as unknown
  if (!isPlainObject(current)) {
    throw new Error(`merge(${String(key)}) requires state[${String(key)}] to be a plain object`)
  }
  if (!isPlainObject(partial)) {
    throw new Error(`merge(${String(key)}) requires partial to be a plain object`)
  }

  const merged = { ...(current as any), ...(clone(partial) as any) }
  set(key, merged as AppState[K], sliceKey)
}

/**
 * Commit a mutation function against a cloned draft, bumping version once.
 *
 * Prefer providing changedSliceKeys for precise slice-sub notifications.
 * If omitted, slice keys are derived conservatively from the computed patch (top-level only).
 */
export function commit(
  mutator: (draft: AppState) => void,
  opts?: { changedSliceKeys?: SliceKey[] }
) {
  if (isCommitting) throw new Error('commit called during another commit')

  isCommitting = true
  try {
    const prev = state
    const draft = clone(state)
    mutator(draft)
    draft.version = state.version + 1
    state = deepFreeze(draft)
    emitChanges(prev, state, opts?.changedSliceKeys)
  } finally {
    isCommitting = false
  }
}

/**
 * Subscribe to changes for a hierarchical slice key. Registered in composition root.
 * Notifications are async+coalesced; callback receives (next, prev, meta).
 */
export function subscribeSlice<T>(
  sliceKey: SliceKey,
  selector: (s: AppState) => T,
  onChange: (next: T, prev: T, meta: SliceChangeMeta) => void,
  options: SubscribeSliceOptions = {}
) {
  const id = nextSubId++
  const sub: SliceSubscriber<T> = {
    sliceKey,
    selector,
    onChange,
    name: options.name,
    onError: options.onError,
    isEnabled: true
  }
  sliceSubs.set(id, sub)

  return {
    unsubscribe: () => sliceSubs.delete(id),
    disable: () => {
      const found = sliceSubs.get(id)
      if (found) found.isEnabled = false
    },
    enable: () => {
      const found = sliceSubs.get(id)
      if (found) found.isEnabled = true
    },
    isActive: () => sliceSubs.has(id) && (sliceSubs.get(id)?.isEnabled ?? false)
  }
}

/**
 * Resolve when all currently queued subscriber notifications have been flushed.
 * Useful in tests and controlled shutdown.
 */
export async function idle(): Promise<void> {
  if (!pending && !flushScheduled) return
  return new Promise<void>(resolve => {
    idleWaiters.push(resolve)
  })
}
