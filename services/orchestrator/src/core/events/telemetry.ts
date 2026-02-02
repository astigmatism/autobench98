/**
 * Telemetry interface for the message bus.
 *
 * Requirement (from you):
 * - log details must be single line, formatted: key=value key2=value2 ...
 *
 * Implementation choice:
 * - NEVER pass structured objects to the logger (avoids multi-line pretty output).
 * - Instead, append serialized key/value pairs to the message string.
 *
 * Safety-critical note:
 * - This does not create a ClientLogBuffer. Orchestrator must pass an existing logger bundle
 *   created with the shared buffer.
 */

export interface BusTelemetry {
  // Counters (per topic)
  published(topic: string): void;
  delivered(topic: string): void;
  schemaRejected(topic: string): void;
  handlerThrew(topic: string): void;
  subscriberDisabledBackpressure(topic: string): void;

  // Rejections
  messageRejected(topic: string, reason: string): void;

  // Logging
  error(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/** Default no-op telemetry (safe if telemetry is not wired yet). */
export const NoopTelemetry: BusTelemetry = {
  published: () => {},
  delivered: () => {},
  schemaRejected: () => {},
  handlerThrew: () => {},
  subscriberDisabledBackpressure: () => {},
  messageRejected: () => {},
  error: () => {},
  warn: () => {},
};

/**
 * Minimal shape of the app logging package channel logger:
 * (msg, extra?) => void
 *
 * We intentionally do NOT use the `extra` parameter to keep logs single-line.
 */
export interface ChannelLoggerLike {
  debug?: (msg: string, extra?: Record<string, unknown>) => void;
  info?: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
  fatal?: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Minimal shape of the app logging package logger bundle:
 * { channel(ch): ChannelLoggerLike }
 */
export interface LoggerBundleLike {
  channel: (ch: any) => ChannelLoggerLike;
}

export interface BusTelemetryCounters {
  published: Record<string, number>;
  delivered: Record<string, number>;
  schemaRejected: Record<string, number>;
  handlerThrew: Record<string, number>;
  subscriberDisabledBackpressure: Record<string, number>;
  messageRejected: Record<string, number>;
}

export interface BusTelemetryWithCounters extends BusTelemetry {
  snapshotCounters(): BusTelemetryCounters;
  resetCounters(): void;
}

function inc(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function snapshot(map: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of map.entries()) out[k] = v;
  return out;
}

function needsQuoting(s: string): boolean {
  // Quote if spaces, tabs, equals, or quotes exist (keeps parsing unambiguous)
  return /[\s="]/.test(s);
}

function escapeQuoted(s: string): string {
  // Minimal escaping for a quoted token
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function quoteIfNeeded(s: string): string {
  return needsQuoting(s) ? `"${escapeQuoted(s)}"` : s;
}

function fmtValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';

  // Use direct typeof guards so TS narrows correctly.
  if (typeof v === 'string') return quoteIfNeeded(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);

  // Objects/arrays/errors: compact JSON if possible, otherwise String(...)
  try {
    const json = JSON.stringify(v);
    if (typeof json === 'string') return quoteIfNeeded(json);
  } catch {
    // fall through
  }

  return quoteIfNeeded(String(v));
}

function fmtKVs(fields?: Record<string, unknown>): string {
  if (!fields) return '';
  const keys = Object.keys(fields);
  if (keys.length === 0) return '';

  keys.sort(); // deterministic ordering
  const parts: string[] = [];

  for (const k of keys) {
    const val = fields[k];
    parts.push(`${k}=${fmtValue(val)}`);
  }

  return parts.join(' ');
}

function line(msg: string, fields?: Record<string, unknown>): string {
  const kvs = fmtKVs(fields);
  return kvs ? `${msg} ${kvs}` : msg;
}

/**
 * Create a BusTelemetry implementation that logs using the application logging package.
 *
 * - Uses logger.channel(channelName).error/warn
 * - IMPORTANT: does not pass `extra` objects to logger; appends key=value pairs to message.
 * - Maintains in-memory per-topic counters and can snapshot/reset them.
 */
export function makeBusTelemetry(logger: LoggerBundleLike, opts?: { channelName?: string }): BusTelemetryWithCounters {
  const channelName = opts?.channelName ?? 'message-bus';
  const log = logger.channel(channelName);

  const c_published = new Map<string, number>();
  const c_delivered = new Map<string, number>();
  const c_schemaRejected = new Map<string, number>();
  const c_handlerThrew = new Map<string, number>();
  const c_subDisabled = new Map<string, number>();
  const c_msgRejected = new Map<string, number>();

  return {
    published: (topic: string) => inc(c_published, topic),
    delivered: (topic: string) => inc(c_delivered, topic),
    schemaRejected: (topic: string) => inc(c_schemaRejected, topic),
    handlerThrew: (topic: string) => inc(c_handlerThrew, topic),
    subscriberDisabledBackpressure: (topic: string) => inc(c_subDisabled, topic),

    messageRejected: (topic: string, _reason: string) => inc(c_msgRejected, topic),

    error: (msg: string, fields?: Record<string, unknown>) => {
      log.error(line(msg, fields));
    },
    warn: (msg: string, fields?: Record<string, unknown>) => {
      log.warn(line(msg, fields));
    },

    snapshotCounters: () => ({
      published: snapshot(c_published),
      delivered: snapshot(c_delivered),
      schemaRejected: snapshot(c_schemaRejected),
      handlerThrew: snapshot(c_handlerThrew),
      subscriberDisabledBackpressure: snapshot(c_subDisabled),
      messageRejected: snapshot(c_msgRejected),
    }),

    resetCounters: () => {
      c_published.clear();
      c_delivered.clear();
      c_schemaRejected.clear();
      c_handlerThrew.clear();
      c_subDisabled.clear();
      c_msgRejected.clear();
    },
  };
}
