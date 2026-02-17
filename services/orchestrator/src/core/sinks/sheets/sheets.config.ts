import type { PublishMode } from '../result-sink.js'

export type SheetsLockMode = 'exclusiveBarrier' | 'none' | 'serializeAll'

export type SheetsConfig = {
  enabled: boolean
  dryRun: boolean

  spreadsheetId: string | null
  serviceAccountEmail: string | null
  privateKey: string | null

  workersBlocking: number
  workersBackground: number
  lockMode: SheetsLockMode

  blockingTimeoutMs: number
  backgroundTimeoutMs: number
  maxPendingBlocking: number
  maxPendingBackground: number

  retry: {
    maxAttempts: number
    baseDelayMs: number
    maxDelayMs: number
  }

  schema: {
    version: number
    tabRuns: string
    tabMetrics: string
    tabArtifacts: string
  }

  publish: {
    defaultMode: PublishMode
    blockOnJobEnd: boolean
  }
}

function parseBool(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def
  const n = v.trim().toLowerCase()
  if (n === 'true' || n === '1' || n === 'yes') return true
  if (n === 'false' || n === '0' || n === 'no') return false
  return def
}

function parseIntSafe(v: string | undefined, def: number): number {
  if (v === undefined) return def
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : def
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  if (n < min) return min
  if (n > max) return max
  return n
}

function parsePublishMode(v: string | undefined, def: PublishMode): PublishMode {
  if (v === 'blocking' || v === 'background') return v
  return def
}

function parseLockMode(v: string | undefined, def: SheetsLockMode): SheetsLockMode {
  if (v === 'exclusiveBarrier' || v === 'none' || v === 'serializeAll') return v
  return def
}

/**
 * Build SheetsConfig from environment.
 *
 * SAFETY: This loader does NOT throw by default. It returns config with nullable auth fields.
 * Call `validateSheetsConfigForWrites(cfg)` before enabling non-dry-run publishing.
 */
export function buildSheetsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SheetsConfig {
  const enabled = parseBool(env.SHEETS_ENABLED, false)
  const dryRun = parseBool(env.SHEETS_DRY_RUN, true)

  const spreadsheetId = (env.GOOGLE_SHEETS_SPREADSHEET_ID ?? env.GOOGLE_SHEETS_DOC_ID ?? '').trim() || null
  const serviceAccountEmail = (env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? '').trim() || null
  const privateKey = (env.GOOGLE_PRIVATE_KEY ?? '').trim() || null

  const workersBlocking = clampInt(parseIntSafe(env.SHEETS_WORKERS_BLOCKING, 1), 1, 32)
  const workersBackground = clampInt(parseIntSafe(env.SHEETS_WORKERS_BACKGROUND, 4), 0, 64)
  const lockMode = parseLockMode(env.SHEETS_LOCK_MODE, 'exclusiveBarrier')

  const blockingTimeoutMs = clampInt(parseIntSafe(env.SHEETS_BLOCKING_TIMEOUT_MS, 300_000), 1_000, 3_600_000)
  const backgroundTimeoutMs = clampInt(parseIntSafe(env.SHEETS_BACKGROUND_TIMEOUT_MS, 300_000), 1_000, 3_600_000)

  const maxPendingBlocking = clampInt(parseIntSafe(env.SHEETS_MAX_PENDING_BLOCKING, 20), 1, 10_000)
  const maxPendingBackground = clampInt(parseIntSafe(env.SHEETS_MAX_PENDING_BACKGROUND, 200), 0, 100_000)

  const retryMaxAttempts = clampInt(parseIntSafe(env.SHEETS_RETRY_MAX_ATTEMPTS, 10), 0, 1_000)
  const retryBaseDelayMs = clampInt(parseIntSafe(env.SHEETS_RETRY_BASE_DELAY_MS, 1_000), 0, 600_000)
  const retryMaxDelayMs = clampInt(parseIntSafe(env.SHEETS_RETRY_MAX_DELAY_MS, 30_000), 0, 3_600_000)

  const schemaVersion = clampInt(parseIntSafe(env.SHEETS_SCHEMA_VERSION, 1), 1, 1_000)
  const tabRuns = (env.SHEETS_TAB_RUNS ?? 'Runs').trim() || 'Runs'
  const tabMetrics = (env.SHEETS_TAB_METRICS ?? 'Metrics').trim() || 'Metrics'
  const tabArtifacts = (env.SHEETS_TAB_ARTIFACTS ?? 'Artifacts').trim() || 'Artifacts'

  const defaultMode = parsePublishMode(env.SHEETS_DEFAULT_PUBLISH_MODE, 'background')
  const blockOnJobEnd = parseBool(env.SHEETS_BLOCK_ON_JOB_END, false)

  return {
    enabled,
    dryRun,
    spreadsheetId,
    serviceAccountEmail,
    privateKey,
    workersBlocking,
    workersBackground,
    lockMode,
    blockingTimeoutMs,
    backgroundTimeoutMs,
    maxPendingBlocking,
    maxPendingBackground,
    retry: {
      maxAttempts: retryMaxAttempts,
      baseDelayMs: retryBaseDelayMs,
      maxDelayMs: retryMaxDelayMs,
    },
    schema: {
      version: schemaVersion,
      tabRuns,
      tabMetrics,
      tabArtifacts,
    },
    publish: {
      defaultMode,
      blockOnJobEnd,
    },
  }
}

export type SheetsConfigValidation = { ok: true } | { ok: false; errors: string[] }

/**
 * Safety-critical validation gate: verifies required auth values exist
 * BEFORE allowing non-dry-run publishing.
 */
export function validateSheetsConfigForWrites(cfg: SheetsConfig): SheetsConfigValidation {
  const errors: string[] = []

  if (!cfg.enabled) return { ok: true } // disabled is always "valid" (no-op)
  if (cfg.dryRun) return { ok: true } // dry-run avoids writes

  if (!cfg.spreadsheetId) errors.push('GOOGLE_SHEETS_SPREADSHEET_ID is required when SHEETS_ENABLED=true and SHEETS_DRY_RUN=false')
  if (!cfg.serviceAccountEmail) errors.push('GOOGLE_SERVICE_ACCOUNT_EMAIL is required when SHEETS_ENABLED=true and SHEETS_DRY_RUN=false')
  if (!cfg.privateKey) errors.push('GOOGLE_PRIVATE_KEY is required when SHEETS_ENABLED=true and SHEETS_DRY_RUN=false')

  // lock mode sanity
  if (cfg.lockMode === 'serializeAll' && cfg.workersBlocking < 1) {
    errors.push('SHEETS_LOCK_MODE=serializeAll requires SHEETS_WORKERS_BLOCKING>=1')
  }

  return errors.length ? { ok: false, errors } : { ok: true }
}
