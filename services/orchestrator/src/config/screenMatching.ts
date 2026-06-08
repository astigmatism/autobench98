import path from 'node:path'

export type ScreenMatchingConfig = {
  staticThreshold: number
  defaultReferenceThreshold: number
  referenceDir: string
  sidecarBaseUrl: string
  warnings: string[]
}

const DEFAULT_STATIC_THRESHOLD = 0.985
const DEFAULT_REFERENCE_THRESHOLD = 0.92

function parseThresholdEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  warnings: string[]
): number {
  const raw = env[name]
  if (raw === undefined || String(raw).trim() === '') return fallback

  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    warnings.push(`${name} must be a number between 0 and 1; using ${fallback}`)
    return fallback
  }

  return n
}

function trimEnv(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name] ?? '').trim()
}

function resolveReferenceDir(dataDir: string, referenceDirRaw: string): string {
  if (!referenceDirRaw) return path.join(dataDir, 'screen-references')
  if (path.isAbsolute(referenceDirRaw)) return referenceDirRaw
  return path.join(dataDir, referenceDirRaw)
}

export function buildScreenMatchingConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ScreenMatchingConfig {
  const warnings: string[] = []

  const dataDir = path.resolve(trimEnv(env, 'DATA_DIR') || '/app/data')
  const referenceDir = resolveReferenceDir(
    dataDir,
    trimEnv(env, 'SCREEN_MATCH_REFERENCE_DIR')
  )

  const sidecarPort = Number.isFinite(Number(env.SIDECAR_PORT)) ? Number(env.SIDECAR_PORT) : 3100
  const sidecarBaseUrl = (
    trimEnv(env, 'SCREEN_MATCH_SIDECAR_BASE_URL') ||
    trimEnv(env, 'BENCHMARK_SIDECAR_BASE_URL') ||
    `http://127.0.0.1:${sidecarPort}`
  ).replace(/\/+$/, '')

  return {
    staticThreshold: parseThresholdEnv(
      env,
      'SCREEN_MATCH_STATIC_THRESHOLD',
      DEFAULT_STATIC_THRESHOLD,
      warnings
    ),
    defaultReferenceThreshold: parseThresholdEnv(
      env,
      'SCREEN_MATCH_REFERENCE_THRESHOLD',
      DEFAULT_REFERENCE_THRESHOLD,
      warnings
    ),
    referenceDir: path.resolve(referenceDir),
    sidecarBaseUrl,
    warnings,
  }
}
