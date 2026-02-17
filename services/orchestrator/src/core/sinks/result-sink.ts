/**
 * Result sink interface (scaffold).
 *
 * Source of truth:
 * - Refactor plan describes a ResultSink interface and lists Google Sheets as a primary sink.
 *   (See: "16.4) Pluggable Result Sinks (Google Sheets as primary)")
 *
 * NOTE: Domain types (RunSummary/MetricMap/ArtifactRefs) are deliberately minimal here.
 * Replace these with your orchestrator's real domain types once available.
 */

export type MetricValue = number | string | boolean | null

export type MetricMap = Record<string, MetricValue>

export type ArtifactRef = {
  type: string
  path: string
  url?: string
  sha256?: string
  meta?: Record<string, unknown>
}

export type ArtifactRefs = Record<string, ArtifactRef>

export type RunStatus = 'success' | 'failed' | 'aborted'

export type RunSummary = {
  runId: string
  jobId?: string
  recipeId?: string
  recipeVersion?: string
  startedAt?: string // ISO
  finishedAt?: string // ISO
  durationMs?: number
  status?: RunStatus
  deviceId?: string
  operatorNote?: string
  orchestratorBuild?: string

  // Allow forward-compat without `any`
  extra?: Record<string, unknown>
}

export type PublishMode = 'blocking' | 'background'

export type PublishReceipt = {
  sinkId: string
  runId: string
  publishedAt: string // ISO
  ok: boolean
  details?: Record<string, unknown>
  warnings?: string[]
}

export interface ResultSink {
  id: string
  init(): Promise<void>
  publish(run: RunSummary, metrics: MetricMap, artifacts: ArtifactRefs): Promise<PublishReceipt | void>
  healthy(): Promise<boolean>
  shutdown?(): Promise<void>
}
