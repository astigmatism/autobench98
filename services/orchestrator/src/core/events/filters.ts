import type { AttributeFilter, Primitive } from './types';

/**
 * Attribute matching per v1 requirements:
 * - attribute values are string | number | boolean
 * - operators:
 *   - equals: exact match
 *   - exists: key presence
 */
export function matchAttributes(
  eventAttrs: Record<string, Primitive> | undefined,
  filter: AttributeFilter | undefined
): boolean {
  if (!filter) return true;

  const attrs = eventAttrs ?? {};

  if (filter.exists && filter.exists.length > 0) {
    for (const key of filter.exists) {
      if (!(key in attrs)) return false;
    }
  }

  if (filter.equals) {
    for (const [key, val] of Object.entries(filter.equals)) {
      if (!(key in attrs)) return false;
      if (attrs[key] !== val) return false;
    }
  }

  return true;
}
