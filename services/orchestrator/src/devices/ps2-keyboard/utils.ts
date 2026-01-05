// services/orchestrator/src/devices/ps2-keyboard/utils.ts

import type {
  PS2KeyboardConfig,
  PS2KeyboardIdentifyConfig,
  PS2KeyboardQueueConfig,
  PS2KeyboardReconnectConfig,
} from './types'

/* -------------------------------------------------------------------------- */
/*  Env parsing helpers (strict + predictable)                                 */
/* -------------------------------------------------------------------------- */

function envString(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback?: string
): string | undefined {
  const v = env[name]
  if (v == null) return fallback
  const t = String(v)
  return t.length === 0 ? fallback : t
}

function envInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback?: number
): number | undefined {
  const raw = env[name]
  if (raw == null || raw === '') return fallback
  const n = Number.parseInt(String(raw), 10)
  return Number.isFinite(n) ? n : fallback
}

function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]
  if (raw == null || raw === '') return fallback
  const v = String(raw).trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function envLineEnding(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: '\n' | '\r\n'
): '\n' | '\r\n' {
  const raw = env[name]
  if (raw == null || raw === '') return fallback
  // allow escaped sequences in .env
  if (raw === '\\n') return '\n'
  if (raw === '\\r\\n') return '\r\n'
  if (raw === '\n') return '\n'
  if (raw === '\r\n') return '\r\n'
  return fallback
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

/* -------------------------------------------------------------------------- */
/*  Keyboard config builder                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build PS2 keyboard service config from environment variables.
 *
 * Strict rules:
 * - If an env var is missing or invalid, we use a conservative default.
 * - No hidden side effects, no IO.
 * - This function should not throw unless the caller explicitly wants it to.
 */
export function buildPS2KeyboardConfigFromEnv(
  env: NodeJS.ProcessEnv
): PS2KeyboardConfig {
  const expectedIdToken = envString(env, 'PS2_KB_ID_TOKEN', 'KB') ?? 'KB'

  // Sketch default is 9600.
  const baudRate = clampInt(envInt(env, 'PS2_KB_BAUD', 9600) ?? 9600, 300, 2_000_000)

  const identify: PS2KeyboardIdentifyConfig = {
    request: envString(env, 'PS2_KB_IDENTIFY_REQUEST', 'identify') ?? 'identify',
    completion:
      envString(env, 'PS2_KB_IDENTIFY_COMPLETION', 'identify_complete') ??
      'identify_complete',
    timeoutMs: clampInt(envInt(env, 'PS2_KB_IDENTIFY_TIMEOUT_MS', 3000) ?? 3000, 250, 60_000),
    retries: clampInt(envInt(env, 'PS2_KB_IDENTIFY_RETRIES', 3) ?? 3, 1, 50),
    writeLineEnding: envLineEnding(env, 'PS2_KB_WRITE_EOL', '\n'),
  }

  const reconnect: PS2KeyboardReconnectConfig = {
    enabled: envBool(env, 'PS2_KB_RECONNECT_ENABLED', true),
    baseDelayMs: clampInt(envInt(env, 'PS2_KB_RECONNECT_BASE_DELAY_MS', 500) ?? 500, 0, 60_000),
    maxDelayMs: clampInt(envInt(env, 'PS2_KB_RECONNECT_MAX_DELAY_MS', 10_000) ?? 10_000, 0, 300_000),
    maxAttempts: clampInt(envInt(env, 'PS2_KB_RECONNECT_MAX_ATTEMPTS', 0) ?? 0, 0, 1_000_000),
  }

  const queue: PS2KeyboardQueueConfig = {
    maxDepth: clampInt(envInt(env, 'PS2_KB_QUEUE_MAX_DEPTH', 500) ?? 500, 1, 50_000),
    retainAcrossReconnect: envBool(env, 'PS2_KB_QUEUE_RETAIN_ACROSS_RECONNECT', true),
  }

  const interCommandDelayMs = clampInt(
    envInt(env, 'PS2_KB_INTER_COMMAND_DELAY_MS', 25) ?? 25,
    0,
    5_000
  )

  const pressHoldMs = clampInt(envInt(env, 'PS2_KB_PRESS_HOLD_MS', 0) ?? 0, 0, 5_000)

  const waitBetweenKeysFactor = (() => {
    const raw = envString(env, 'PS2_KB_WAIT_BETWEEN_KEYS_FACTOR', '1') ?? '1'
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return 1
    // cap to prevent accidental "0.0001" that explodes pacing
    return Math.min(n, 100)
  })()

  const state = {
    maxErrorHistory: clampInt(envInt(env, 'PS2_KB_STATE_MAX_ERROR_HISTORY', 25) ?? 25, 0, 500),
    maxOperationHistory: clampInt(
      envInt(env, 'PS2_KB_STATE_MAX_OPERATION_HISTORY', 50) ?? 50,
      0,
      1_000
    ),
  }

  return {
    kind: 'arduino.ps2.keyboard',
    expectedIdToken,
    baudRate,
    identify,
    reconnect,
    queue,
    tuning: {
      pressHoldMs,
      interCommandDelayMs,
      waitBetweenKeysFactor,
    },
    state,
  }
}

/* -------------------------------------------------------------------------- */
/*  Misc helpers used by the service                                           */
/* -------------------------------------------------------------------------- */

export function sleep(ms: number): Promise<void> {
  const n = Number.isFinite(ms) ? ms : 0
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, n)))
}

export function now(): number {
  return Date.now()
}

/**
 * Make a stable operation id. Caller provides prefix so you can tell kinds apart.
 * This is intentionally non-crypto and deterministic enough for logs.
 */
export function makeOpId(prefix: string): string {
  const ts = Date.now()
  const rand = Math.floor(Math.random() * 1_000_000)
    .toString(16)
    .padStart(5, '0')
  return `${prefix}-${ts}-${rand}`
}

/**
 * Normalize hex-ish values to an integer byte.
 * Accepts:
 * - number
 * - "0x1E"
 * - "1E"
 */
export function toByte(v: unknown): number | null {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null
    const n = Math.floor(v)
    if (n < 0 || n > 255) return null
    return n
  }
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase().replace(/^0x/, '')
    if (s.length === 0) return null
    const n = Number.parseInt(s, 16)
    if (!Number.isFinite(n) || n < 0 || n > 255) return null
    return n
  }
  return null
}

/** Format a scan code pair exactly how the Arduino sketch expects. */
export function formatWireScanCode(prefix: number | undefined, code: number): string {
  const p = typeof prefix === 'number' ? prefix : 0x00
  const pp = p.toString(16)
  const cc = code.toString(16)
  return `${pp}:${cc}`
}
