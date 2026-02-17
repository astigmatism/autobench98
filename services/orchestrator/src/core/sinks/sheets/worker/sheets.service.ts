import type { SheetsConfig } from '../sheets.config.js'
import type { RunEnvelope } from '../sheets.envelope.js'
import type { PublishReceiptWorker } from '../sheets.protocol.js'

/**
 * SheetsService (worker-side) — SCAFFOLD ONLY
 *
 * Safety posture:
 * - Default config uses dryRun=true, so no writes occur.
 * - When dryRun=false, this service attempts to dynamically import 'googleapis'.
 *   If unavailable, it throws a clear error rather than silently failing.
 *
 * IMPORTANT: This is intentionally minimal and append-only. Idempotent upserts,
 * developer metadata tagging, and schema migration are TODOs.
 */
export class SheetsService {
  private readonly cfg: SheetsConfig

  constructor(cfg: SheetsConfig) {
    this.cfg = cfg
  }

  async init(): Promise<void> {
    // Placeholder for auth warm-up / sheet metadata cache.
    // In a full implementation, you would:
    // - Create auth client
    // - Verify spreadsheet access
    // - Ensure required tabs + headers exist (Runs/Metrics/Artifacts)
    return
  }

  async publishRun(envelope: RunEnvelope): Promise<PublishReceiptWorker> {
    const publishedAt = new Date().toISOString()

    if (this.cfg.dryRun) {
      return {
        runId: envelope.run.run_id,
        publishedAt,
        ok: true,
        warnings: ['dryRun=true (no Google API writes were performed)'],
        details: {
          mode: 'dryRun',
          tabRuns: this.cfg.schema.tabRuns,
          tabMetrics: this.cfg.schema.tabMetrics,
          tabArtifacts: this.cfg.schema.tabArtifacts,
          metricsCount: envelope.metrics.length,
          artifactsCount: envelope.artifacts.length,
        },
      }
    }

    // Safety gate: require auth fields
    if (!this.cfg.spreadsheetId || !this.cfg.serviceAccountEmail || !this.cfg.privateKey) {
      throw new Error('SheetsService: missing spreadsheetId/serviceAccountEmail/privateKey; cannot publish when dryRun=false')
    }

    // Normalize private key for env formats where newlines are escaped.
    const privateKey = this.cfg.privateKey.replace(/\\n/g, '\n')

    // Dynamic import so the orchestrator can boot without googleapis installed
    let googleapis: any
    try {
      googleapis = await import('googleapis')
    } catch (err) {
      throw new Error(
        "SheetsService: 'googleapis' dependency not found. Install it or set SHEETS_DRY_RUN=true."
      )
    }

    const { google } = googleapis
    const scopes = ['https://www.googleapis.com/auth/spreadsheets']

    const auth = new google.auth.JWT({
      email: this.cfg.serviceAccountEmail,
      key: privateKey,
      scopes,
    })

    const sheets = google.sheets({ version: 'v4', auth })

    // TODO: ensure schema (tabs + headers) and implement idempotent upsert.
    // For now: append to each tab in normalized long form.

    await this.appendRunRow(sheets, envelope)
    await this.appendMetricsRows(sheets, envelope)
    await this.appendArtifactsRows(sheets, envelope)

    return {
      runId: envelope.run.run_id,
      publishedAt,
      ok: true,
      warnings: ['append-only scaffold (not idempotent)'],
      details: { spreadsheetId: this.cfg.spreadsheetId },
    }
  }

  private async appendRunRow(sheets: any, envelope: RunEnvelope): Promise<void> {
    const row = envelope.run
    const values = [[
      row.run_id,
      row.job_id ?? '',
      row.recipe_id ?? '',
      row.recipe_version ?? '',
      row.started_at ?? '',
      row.finished_at ?? '',
      row.duration_ms ?? '',
      row.status ?? '',
      row.device_id ?? '',
      row.operator_note ?? '',
      row.orchestrator_build ?? '',
    ]]

    await sheets.spreadsheets.values.append({
      spreadsheetId: this.cfg.spreadsheetId,
      range: `${this.cfg.schema.tabRuns}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    })
  }

  private async appendMetricsRows(sheets: any, envelope: RunEnvelope): Promise<void> {
    if (envelope.metrics.length === 0) return

    const values = envelope.metrics.map((m) => [
      m.run_id,
      m.metric_key,
      m.value as any,
      m.unit ?? '',
      m.metric_name ?? '',
      m.source ?? '',
      m.captured_at ?? '',
    ])

    await sheets.spreadsheets.values.append({
      spreadsheetId: this.cfg.spreadsheetId,
      range: `${this.cfg.schema.tabMetrics}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    })
  }

  private async appendArtifactsRows(sheets: any, envelope: RunEnvelope): Promise<void> {
    if (envelope.artifacts.length === 0) return

    const values = envelope.artifacts.map((a) => [
      a.run_id,
      a.artifact_type,
      a.path,
      a.url ?? '',
      a.sha256 ?? '',
      a.created_at ?? '',
    ])

    await sheets.spreadsheets.values.append({
      spreadsheetId: this.cfg.spreadsheetId,
      range: `${this.cfg.schema.tabArtifacts}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    })
  }
}
