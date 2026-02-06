import type { AppState, ServerConfig } from './types'
import { readServerConfigFromEnv } from './serverConfig'
import { isPlainObject } from './utils'

export type InitialStateOptions = {
  startedAt?: Date
  build?: string
  status?: AppState['meta']['status']
  serverConfig?: ServerConfig
}

function asInt(envVal: string | undefined, fallback: number): number {
  if (envVal == null || envVal.trim() === '') return fallback
  const n = Number(envVal)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function asMetaStatus(
  envVal: string | undefined,
  fallback: AppState['meta']['status']
): AppState['meta']['status'] {
  if (envVal == null || envVal.trim() === '') return fallback
  const v = envVal.trim().toLowerCase()
  if (v === 'booting' || v === 'ready' || v === 'error') return v
  return fallback
}

function parseFeatureFlags(envVal: string | undefined): Record<string, boolean> | undefined {
  if (envVal == null || envVal.trim() === '') return undefined
  try {
    const parsed = JSON.parse(envVal)
    if (!isPlainObject(parsed)) return undefined
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'boolean') out[k] = v
    }
    return out
  } catch {
    return undefined
  }
}

/**
 * Create a baseline initial AppState matching the state plan schema.
 *
 * Safety-critical note:
 * - Use explicit 'unknown' for truth signals that have not been observed yet.
 */
export function createInitialState(opts: InitialStateOptions = {}): AppState {
  const env = process.env

  // NEW (Application state section): STATE_* values override defaults.
  const serverConfig = opts.serverConfig ?? readServerConfigFromEnv(env)

  const startedAt = opts.startedAt ?? new Date()

  // Prefer STATE_BUILD_ID, then BUILD_ID, then 'dev'
  const build =
    opts.build ??
    env.STATE_BUILD_ID ??
    env.BUILD_ID ??
    'dev'

  // Prefer STATE_BOOT_STATUS (booting|ready|error); default booting
  const status = opts.status ?? asMetaStatus(env.STATE_BOOT_STATUS, 'booting')

  // Mirror request sampling control into AppState.config (REQUEST_SAMPLE is already used elsewhere)
  const requestSample = asInt(env.REQUEST_SAMPLE, 1)

  // Optional feature flags for the UI / flows (JSON object of booleans)
  const features = parseFeatureFlags(env.STATE_FEATURES_JSON) ?? {}

  return {
    version: 0,
    meta: {
      startedAt: startedAt.toISOString(),
      build,
      status
    },
    config: {
      requestSample,
      features
    },
    devices: {},
    streams: {},
    jobs: {
      queue: [],
      running: []
    },
    pno: {
      status: 'idle'
    },
    logs: {
      nextSeq: 1,
      capacity: serverConfig.logs.capacity,
      size: 0,
      head: 0
    },
    serverConfig,
    power: {
      pc: { value: 'unknown' }
    }
  }
}
