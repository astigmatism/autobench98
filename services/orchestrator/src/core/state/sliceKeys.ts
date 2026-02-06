import type { JsonPatchOp, SliceKey } from './types'

/**
 * Determine whether two hierarchical slice keys overlap.
 *
 * Rule: keys overlap if one equals the other, or one is a dot-prefix of the other.
 * - subscriber "power" overlaps changes "power.pc"
 * - subscriber "power.pc" overlaps changes "power"
 */
export function sliceKeysOverlap(a: SliceKey, b: SliceKey): boolean {
  if (a === b) return true
  if (a.startsWith(b + '.')) return true
  if (b.startsWith(a + '.')) return true
  return false
}

/**
 * Conservative derivation of slice keys from JSON Patch ops:
 * - '/power/pc' -> 'power'
 * - '/devices/foo' -> 'devices'
 * - '/version' -> ignored
 *
 * Note: this is only a fallback when commits do not supply explicit changedSliceKeys.
 */
export function deriveSliceKeysFromPatch(patch: JsonPatchOp[]): SliceKey[] {
  const keys = new Set<SliceKey>()
  for (const op of patch) {
    if (!op.path || op.path === '/version') continue
    if (!op.path.startsWith('/')) continue
    const parts = op.path.split('/').filter(Boolean)
    const top = parts[0]
    if (top && top !== 'version') keys.add(top)
  }
  return Array.from(keys)
}
