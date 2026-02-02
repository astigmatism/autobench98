import type {
  FrontPanelConfig,
  FrontPanelIdentifyConfig,
  FrontPanelQueueConfig,
  FrontPanelReconnectConfig,
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
/*  Front panel config builder                                                 */
/* -------------------------------------------------------------------------- */

export function buildFrontPanelConfigFromEnv(env: NodeJS.ProcessEnv): FrontPanelConfig {
  const expectedIdToken = envString(env, 'FP_ID_TOKEN', 'FP') ?? 'FP'

  // Sketch default is 9600.
  const baudRate = clampInt(envInt(env, 'FP_BAUD', 9600) ?? 9600, 300, 2_000_000)

  const identify: FrontPanelIdentifyConfig = {
    request: envString(env, 'FP_IDENTIFY_REQUEST', 'identify') ?? 'identify',
    completion:
      envString(env, 'FP_IDENTIFY_COMPLETION', 'identify_complete') ??
      'identify_complete',
    timeoutMs: clampInt(envInt(env, 'FP_IDENTIFY_TIMEOUT_MS', 3000) ?? 3000, 250, 60_000),
    retries: clampInt(envInt(env, 'FP_IDENTIFY_RETRIES', 3) ?? 3, 1, 50),
    writeLineEnding: envLineEnding(env, 'FP_WRITE_EOL', '\n'),
  }

  const reconnect: FrontPanelReconnectConfig = {
    enabled: envBool(env, 'FP_RECONNECT_ENABLED', true),
    baseDelayMs: clampInt(envInt(env, 'FP_RECONNECT_BASE_DELAY_MS', 500) ?? 500, 0, 60_000),
    maxDelayMs: clampInt(envInt(env, 'FP_RECONNECT_MAX_DELAY_MS', 10_000) ?? 10_000, 0, 300_000),
    maxAttempts: clampInt(envInt(env, 'FP_RECONNECT_MAX_ATTEMPTS', 0) ?? 0, 0, 1_000_000),
  }

  const queue: FrontPanelQueueConfig = {
    maxDepth: clampInt(envInt(env, 'FP_QUEUE_MAX_DEPTH', 200) ?? 200, 1, 50_000),
    retainAcrossReconnect: envBool(env, 'FP_QUEUE_RETAIN_ACROSS_RECONNECT', true),
  }

  const interCommandDelayMs = clampInt(
    envInt(env, 'FP_INTER_COMMAND_DELAY_MS', 25) ?? 25,
    0,
    5_000
  )

  // Default human-like press duration for a power tap.
  const powerPressHoldMs = clampInt(
    envInt(env, 'FP_POWER_PRESS_HOLD_MS', 250) ?? 250,
    50,
    10_000
  )

  const state = {
    maxErrorHistory: clampInt(envInt(env, 'FP_STATE_MAX_ERROR_HISTORY', 25) ?? 25, 0, 500),
    maxOperationHistory: clampInt(
      envInt(env, 'FP_STATE_MAX_OPERATION_HISTORY', 50) ?? 50,
      0,
      1_000
    ),
  }

  return {
    kind: 'arduino.frontpanel',
    expectedIdToken,
    baudRate,
    identify,
    reconnect,
    queue,
    tuning: {
      interCommandDelayMs,
      powerPressHoldMs,
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

export function makeOpId(prefix: string): string {
  const ts = Date.now()
  const rand = Math.floor(Math.random() * 1_000_000)
    .toString(16)
    .padStart(5, '0')
  return `${prefix}-${ts}-${rand}`
}
