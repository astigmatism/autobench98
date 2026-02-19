// services/orchestrator/src/core/sinks/sheets/sheets.envelope.ts
import type { ArtifactRef, MetricMap, MetricValue, RunSummary } from '../result-sink.js'

/**
 * Normalized envelope consumed by the Sheets worker.
 *
 * This is a "data store" representation (Runs/Metrics/Artifacts) rather than
 * a template-driven worksheet writer.
 */
export type SheetsRunRecord = {
  run_id: string
  job_id?: string
  recipe_id?: string
  recipe_version?: string
  started_at?: string
  finished_at?: string
  duration_ms?: number
  status?: string
  device_id?: string
  operator_note?: string
  orchestrator_build?: string
}

export type SheetsMetricRecord = {
  run_id: string
  metric_key: string
  value: MetricValue
  unit?: string
  metric_name?: string
  source?: string
  captured_at?: string
  extra?: Record<string, unknown>
}

export type SheetsArtifactRecord = {
  run_id: string
  artifact_type: string
  path: string
  url?: string
  sha256?: string
  created_at?: string
  extra?: Record<string, unknown>
}

export type RunEnvelope = {
  schemaVersion: number
  run: SheetsRunRecord
  metrics: SheetsMetricRecord[]
  artifacts: SheetsArtifactRecord[]
}

export function buildEnvelopeFromInputs(opts: {
  schemaVersion: number
  run: RunSummary
  metrics: MetricMap
  artifacts: Record<string, ArtifactRef>
}): RunEnvelope {
  const r = opts.run
  const run_id = r.runId

  const run: SheetsRunRecord = {
    run_id,
    job_id: r.jobId,
    recipe_id: r.recipeId,
    recipe_version: r.recipeVersion,
    started_at: r.startedAt,
    finished_at: r.finishedAt,
    duration_ms: r.durationMs,
    status: r.status,
    device_id: r.deviceId,
    operator_note: r.operatorNote,
    orchestrator_build: r.orchestratorBuild,
  }

  const metrics: SheetsMetricRecord[] = Object.entries(opts.metrics).map(([metric_key, value]) => ({
    run_id,
    metric_key,
    value,
  }))

  const artifacts: SheetsArtifactRecord[] = Object.entries(opts.artifacts).map(([key, a]) => ({
    run_id,
    artifact_type: a.type || key,
    path: a.path,
    url: a.url,
    sha256: a.sha256,
  }))

  return {
    schemaVersion: opts.schemaVersion,
    run,
    metrics,
    artifacts,
  }
}
