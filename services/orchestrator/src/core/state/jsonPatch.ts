import type { AppState, JsonPatchOp, JsonValue } from './types'
import { clone, deepEqual, assertJsonValue } from './utils'

function escapeJsonPointerSegment(seg: string): string {
  // RFC 6901: '~' -> '~0', '/' -> '~1'
  return seg.replace(/~/g, '~0').replace(/\//g, '~1')
}

function pathForTopLevelKey(key: string): string {
  return '/' + escapeJsonPointerSegment(key)
}

/**
 * Project-specific JSON Patch computation.
 *
 * Safety-critical note:
 * - This implementation is intentionally conservative: it emits add/remove/replace
 *   at the TOP LEVEL (plus /version), even if only nested fields changed.
 * - This avoids subtle bugs from incomplete deep-diff logic.
 * - If you later adopt a proven RFC 6902 library, you can swap this implementation.
 */
export function compareTopLevel(prev: AppState, next: AppState): JsonPatchOp[] {
  const ops: JsonPatchOp[] = []

  // Always include version update if it changed.
  if (prev.version !== next.version) {
    ops.push({ op: 'replace', path: '/version', value: next.version as unknown as JsonValue })
  }

  const prevKeys = Object.keys(prev).filter(k => k !== 'version')
  const nextKeys = Object.keys(next).filter(k => k !== 'version')
  const allKeys = new Set<string>([...prevKeys, ...nextKeys])

  const sorted = Array.from(allKeys).sort()
  for (const key of sorted) {
    const pHas = Object.prototype.hasOwnProperty.call(prev as any, key)
    const nHas = Object.prototype.hasOwnProperty.call(next as any, key)
    const path = pathForTopLevelKey(key)

    if (!pHas && nHas) {
      const val = clone((next as any)[key]) as unknown
      assertJsonValue(val)
      ops.push({ op: 'add', path, value: val as JsonValue })
      continue
    }

    if (pHas && !nHas) {
      ops.push({ op: 'remove', path })
      continue
    }

    // both present
    if (!deepEqual((prev as any)[key], (next as any)[key])) {
      const val = clone((next as any)[key]) as unknown
      assertJsonValue(val)
      ops.push({ op: 'replace', path, value: val as JsonValue })
    }
  }

  return ops
}
