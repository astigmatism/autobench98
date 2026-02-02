/**
 * Topic validation + wildcard matching.
 *
 * Requirements:
 * - dot-separated segments
 * - lowercase only
 * - allowed chars per segment: a-z, 0-9, '-'
 * - no empty segments, no leading/trailing '.'
 *
 * Topic patterns add:
 * - '*' matches exactly one segment
 * - '**' matches zero or more segments
 */

const SEGMENT_RE = /^[a-z0-9-]+$/;

export type TopicValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export type TopicPatternValidationResult =
  | { ok: true; segments: string[] }
  | { ok: false; reason: string };

export function validateTopicName(topic: unknown): TopicValidationResult {
  if (typeof topic !== 'string') return { ok: false, reason: 'not_a_string' };
  if (topic.length === 0) return { ok: false, reason: 'empty' };
  if (topic.startsWith('.') || topic.endsWith('.')) return { ok: false, reason: 'leading_or_trailing_dot' };
  if (topic.includes('..')) return { ok: false, reason: 'empty_segment' };

  const segments = topic.split('.');
  for (const seg of segments) {
    if (seg.length === 0) return { ok: false, reason: 'empty_segment' };
    if (!SEGMENT_RE.test(seg)) return { ok: false, reason: `invalid_segment:${seg}` };
  }
  return { ok: true };
}

export function validateTopicPattern(pattern: unknown): TopicPatternValidationResult {
  if (typeof pattern !== 'string') return { ok: false, reason: 'not_a_string' };
  if (pattern.length === 0) return { ok: false, reason: 'empty' };
  if (pattern.startsWith('.') || pattern.endsWith('.')) return { ok: false, reason: 'leading_or_trailing_dot' };
  if (pattern.includes('..')) return { ok: false, reason: 'empty_segment' };

  const segments = pattern.split('.');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.length === 0) return { ok: false, reason: 'empty_segment' };

    if (seg === '*') continue;
    if (seg === '**') {
      // Allow ** anywhere; matching implementation handles it.
      continue;
    }
    if (!SEGMENT_RE.test(seg)) return { ok: false, reason: `invalid_segment:${seg}` };
  }

  return { ok: true, segments };
}

/**
 * Match a compiled pattern (segments) to a concrete topic string.
 */
export function matchTopicPattern(patternSegments: string[], topic: string): boolean {
  // Validate topic quickly; if invalid, treat as no match.
  const tv = validateTopicName(topic);
  if (!tv.ok) return false;

  const topicSegments = topic.split('.');
  return matchSegments(patternSegments, 0, topicSegments, 0);
}

function matchSegments(pat: string[], pi: number, top: string[], ti: number): boolean {
  // If we consumed the pattern, topic must also be fully consumed.
  if (pi === pat.length) return ti === top.length;

  const p = pat[pi];

  if (p === '**') {
    // ** can match zero or more segments.
    // Try all possible consumptions.
    if (pi === pat.length - 1) {
      // Trailing ** always matches the rest.
      return true;
    }
    for (let k = ti; k <= top.length; k++) {
      if (matchSegments(pat, pi + 1, top, k)) return true;
    }
    return false;
  }

  if (ti === top.length) return false;

  if (p === '*') {
    // Match exactly one segment
    return matchSegments(pat, pi + 1, top, ti + 1);
  }

  // Literal segment
  if (p !== top[ti]) return false;
  return matchSegments(pat, pi + 1, top, ti + 1);
}
