import type { JsonValue } from './types'

export function clone<T>(v: T): T {
  // Prefer structuredClone when available (Node 17+). Fallback to JSON clone.
  const sc = (globalThis as any).structuredClone as undefined | ((x: any) => any)
  if (typeof sc === 'function') return sc(v) as T

  // Safety note: JSON clone assumes AppState is JSON-serializable.
  return JSON.parse(JSON.stringify(v)) as T
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v == null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

export function deepFreeze<T>(obj: T): T {
  if (obj == null || typeof obj !== 'object') return obj
  Object.freeze(obj)
  for (const key of Object.keys(obj as any)) {
    const val = (obj as any)[key]
    if (val && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val)
    }
  }
  return obj
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a == null || b == null) return a === b

  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false
    if (a.length !== (b as any[]).length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], (b as any[])[i])) return false
    }
    return true
  }

  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    // Deterministic key order not required for equality.
    for (const k of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false
      if (!deepEqual((a as any)[k], (b as any)[k])) return false
    }
    return true
  }

  // For non-plain objects, fall back to strict equality (should not appear in AppState).
  return false
}

export function assertJsonValue(v: unknown): asserts v is JsonValue {
  // Soft runtime guard; intended to catch accidental non-serializable writes.
  // In production you may want stricter validation per slice.
  const t = typeof v
  if (
    v === null ||
    t === 'string' ||
    t === 'number' ||
    t === 'boolean' ||
    Array.isArray(v) ||
    isPlainObject(v)
  ) {
    return
  }
  throw new Error(`Non-JSON value written into AppState: ${String(v)}`)
}
