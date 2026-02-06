import type { ServerConfig } from './types'

function asInt(envVal: string | undefined, fallback: number): number {
  if (envVal == null || envVal.trim() === '') return fallback
  const n = Number(envVal)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function asNumber(envVal: string | undefined, fallback: number): number {
  if (envVal == null || envVal.trim() === '') return fallback
  const n = Number(envVal)
  return Number.isFinite(n) ? n : fallback
}

function asBool(envVal: string | undefined, fallback: boolean): boolean {
  if (envVal == null || envVal.trim() === '') return fallback
  const v = envVal.trim().toLowerCase()
  if (v === 'true' || v === '1' || v === 'yes' || v === 'y') return true
  if (v === 'false' || v === '0' || v === 'no' || v === 'n') return false
  return fallback
}

function asStringList(envVal: string | undefined, fallback: string[]): string[] {
  if (envVal == null || envVal.trim() === '') return fallback
  return envVal
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

function asLogLevel(
  envVal: string | undefined,
  fallback: ServerConfig['logs']['minLevel']
): ServerConfig['logs']['minLevel'] {
  if (envVal == null || envVal.trim() === '') return fallback
  const v = envVal.trim().toLowerCase()
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error' || v === 'fatal') return v
  return fallback
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

/**
 * Build ServerConfig from environment variables described in orchestrator_state_plan_final.md.
 *
 * - CLIENT_LOGS_SNAPSHOT
 * - CLIENT_LOGS_CAPACITY
 * - LOG_CHANNEL_ALLOWLIST
 * - LOG_LEVEL_MIN
 * - VITE_WS_HEARTBEAT_* / reconnect params
 */
export function readServerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const logsSnapshot = asInt(env.CLIENT_LOGS_SNAPSHOT, 200)
  const logsCapacity = asInt(env.CLIENT_LOGS_CAPACITY, 2000)

  const allowedChannels = asStringList(env.LOG_CHANNEL_ALLOWLIST, [
    'orchestrator',
    'ws',
    'devices',
    'sidecar',
    'frontend'
  ])

  const minLevel = asLogLevel(env.LOG_LEVEL_MIN, 'info')

  const heartbeatIntervalMs = asInt(env.VITE_WS_HEARTBEAT_INTERVAL_MS, 5_000)
  const heartbeatTimeoutMs = asInt(env.VITE_WS_HEARTBEAT_TIMEOUT_MS, 15_000)

  const reconnectEnabled = asBool(env.VITE_WS_RECONNECT_ENABLED, true)
  const reconnectMinMs = asInt(env.VITE_WS_RECONNECT_MIN_MS, 500)
  const reconnectMaxMs = asInt(env.VITE_WS_RECONNECT_MAX_MS, 10_000)

  // NOTE: These are FLOATS in your .env example (e.g., 1.8, 0.2). Do not truncate.
  const reconnectFactor = clamp(asNumber(env.VITE_WS_RECONNECT_FACTOR, 2.0), 1.0, 100.0)
  const reconnectJitter = clamp(asNumber(env.VITE_WS_RECONNECT_JITTER, 0.2), 0.0, 1.0)

  return {
    logs: {
      snapshot: logsSnapshot,
      capacity: logsCapacity,
      allowedChannels,
      minLevel
    },
    ws: {
      heartbeatIntervalMs,
      heartbeatTimeoutMs,
      reconnectEnabled,
      reconnectMinMs,
      reconnectMaxMs,
      reconnectFactor,
      reconnectJitter
    }
  }
}
