// services/orchestrator/src/core/sinks/sheets/worker/sheets.service.ts
import type { SheetsConfig } from '../sheets.config.js'
import type { RunEnvelope } from '../sheets.envelope.js'
import type {
  AuthWarmupStatus,
  PublishReceiptWorker,
  SpreadsheetMetaWorker,
  ValuesGetResultWorker,
  ValuesBatchGetResultWorker,
  ValuesUpdateResultWorker,
  InsertRowResultWorker,
  InsertColumnResultWorker,
  CopyRowResultWorker,
  SheetsMajorDimension,
  SheetsValueRenderOption,
  SheetsDateTimeRenderOption,
} from '../sheets.protocol.js'

/**
 * SheetsService (worker-side)
 *
 * Safety posture:
 * - Default config uses dryRun=true, so NO writes occur.
 * - All Google API calls happen in this worker thread (never in Fastify main).
 * - Dependencies are loaded via dynamic import so orchestrator can boot without them.
 *
 * Auth warm-up (preflight):
 * - A lightweight read-only request (spreadsheets.get) to validate access.
 * - Stores the last warmup status for health reporting.
 */
export class SheetsService {
  private readonly cfg: SheetsConfig

  private sheetsClientPromise: Promise<any> | null = null
  private lastWarmup: AuthWarmupStatus = { status: 'never' }

  private metaCache: { atMs: number; meta: SpreadsheetMetaWorker } | null = null

  constructor(cfg: SheetsConfig) {
    this.cfg = cfg
  }

  async init(): Promise<void> {
    // Intentionally does not perform network I/O.
    // The orchestrator controls warmup via SHEETS_AUTH_STRATEGY through a separate worker message.
    return
  }

  getAuthWarmupStatus(): AuthWarmupStatus {
    return this.lastWarmup
  }

  private requireAuthConfig(): void {
    if (!this.cfg.spreadsheetId || !this.cfg.serviceAccountEmail || !this.cfg.privateKey) {
      throw new Error('missing spreadsheetId/serviceAccountEmail/privateKey')
    }
  }

  async authWarmup(): Promise<AuthWarmupStatus> {
    const at = new Date().toISOString()

    try {
      this.requireAuthConfig()
      const sheets = await this.getSheetsClient()

      const resp = await sheets.spreadsheets.get({
        spreadsheetId: this.cfg.spreadsheetId,
        fields: 'spreadsheetId,properties.title',
      })

      const title: string | undefined = resp?.data?.properties?.title
      this.lastWarmup = { status: 'ok', at, spreadsheetTitle: title }
      return this.lastWarmup
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const code = (err as any)?.code
      this.lastWarmup = {
        status: 'error',
        at,
        error: {
          message: msg,
          code: typeof code === 'string' ? code : undefined,
        },
      }
      return this.lastWarmup
    }
  }

  async getSpreadsheetMeta(): Promise<SpreadsheetMetaWorker> {
    this.requireAuthConfig()
    const now = Date.now()

    // 30s worker-local meta cache to avoid repeated metadata reads within a busy worker
    if (this.metaCache && now - this.metaCache.atMs < 30_000) {
      return this.metaCache.meta
    }

    const sheets = await this.getSheetsClient()

    const resp = await sheets.spreadsheets.get({
      spreadsheetId: this.cfg.spreadsheetId,
      fields:
        'spreadsheetId,properties.title,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))',
    })

    const meta: SpreadsheetMetaWorker = {
      spreadsheetId: resp?.data?.spreadsheetId ?? this.cfg.spreadsheetId!,
      title: resp?.data?.properties?.title,
      sheets: (resp?.data?.sheets ?? []).map((s: any) => ({
        sheetId: s?.properties?.sheetId,
        title: s?.properties?.title,
        rowCount: s?.properties?.gridProperties?.rowCount,
        columnCount: s?.properties?.gridProperties?.columnCount,
      })),
    }

    this.metaCache = { atMs: now, meta }
    return meta
  }

  async valuesGet(params: {
    range: string
    majorDimension: SheetsMajorDimension
    valueRenderOption?: SheetsValueRenderOption
    dateTimeRenderOption?: SheetsDateTimeRenderOption
  }): Promise<ValuesGetResultWorker> {
    this.requireAuthConfig()
    const sheets = await this.getSheetsClient()

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: this.cfg.spreadsheetId,
      range: params.range,
      majorDimension: params.majorDimension,
      valueRenderOption: params.valueRenderOption,
      dateTimeRenderOption: params.dateTimeRenderOption,
    })

    return {
      range: resp?.data?.range ?? params.range,
      majorDimension: (resp?.data?.majorDimension as SheetsMajorDimension) ?? params.majorDimension,
      values: (resp?.data?.values ?? []) as (string | number | boolean | null)[][],
    }
  }

  async valuesBatchGet(params: {
    ranges: string[]
    majorDimension: SheetsMajorDimension
    valueRenderOption?: SheetsValueRenderOption
    dateTimeRenderOption?: SheetsDateTimeRenderOption
  }): Promise<ValuesBatchGetResultWorker> {
    this.requireAuthConfig()
    const sheets = await this.getSheetsClient()

    const resp = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: this.cfg.spreadsheetId,
      ranges: params.ranges,
      majorDimension: params.majorDimension,
      valueRenderOption: params.valueRenderOption,
      dateTimeRenderOption: params.dateTimeRenderOption,
    })

    const valueRanges = (resp?.data?.valueRanges ?? []).map((vr: any) => ({
      range: vr.range ?? '',
      majorDimension: (vr.majorDimension as SheetsMajorDimension) ?? params.majorDimension,
      values: (vr.values ?? []) as (string | number | boolean | null)[][],
    }))

    return {
      spreadsheetId: resp?.data?.spreadsheetId ?? this.cfg.spreadsheetId!,
      valueRanges,
    }
  }

  async valuesUpdate(params: {
    range: string
    values: (string | number | boolean | null)[][]
    valueInputOption: 'RAW' | 'USER_ENTERED'
    includeValuesInResponse?: boolean
  }): Promise<ValuesUpdateResultWorker> {
    this.requireAuthConfig()

    if (this.cfg.dryRun) {
      return {
        updatedRange: params.range,
        updatedRows: 0,
        updatedColumns: 0,
        updatedCells: 0,
        dryRunSkipped: true,
      }
    }

    const sheets = await this.getSheetsClient()

    const resp = await sheets.spreadsheets.values.update({
      spreadsheetId: this.cfg.spreadsheetId,
      range: params.range,
      valueInputOption: params.valueInputOption,
      includeValuesInResponse: params.includeValuesInResponse ?? false,
      requestBody: { values: params.values },
    })

    return {
      updatedRange: resp?.data?.updatedRange,
      updatedRows: resp?.data?.updatedRows,
      updatedColumns: resp?.data?.updatedColumns,
      updatedCells: resp?.data?.updatedCells,
      dryRunSkipped: false,
    }
  }

  async insertRow(params: {
    sheetName: string
    rowNumber?: number
    inheritFromBefore: boolean
  }): Promise<InsertRowResultWorker> {
    this.requireAuthConfig()

    // Determine insertion point
    const meta = await this.getSpreadsheetMeta()
    const sheet = meta.sheets.find((s) => s.title === params.sheetName)
    if (!sheet) throw new Error(`sheet not found name=${params.sheetName}`)
    const rowCount = sheet.rowCount ?? 0

    const startIndex = params.rowNumber !== undefined ? Math.max(0, params.rowNumber - 1) : rowCount
    const insertedRowNumber = startIndex + 1 // 1-based

    if (this.cfg.dryRun) {
      return { insertedRowNumber, dryRunSkipped: true }
    }

    const sheetsApi = await this.getSheetsClient()

    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: this.cfg.spreadsheetId,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: {
                sheetId: sheet.sheetId,
                dimension: 'ROWS',
                startIndex,
                endIndex: startIndex + 1,
              },
              inheritFromBefore: params.inheritFromBefore,
            },
          },
        ],
      },
    })

    // Invalidate worker-local meta cache (grid size changed)
    this.metaCache = null

    return { insertedRowNumber, dryRunSkipped: false }
  }

  async insertColumn(params: {
    sheetName: string
    afterColumnLetter: string
    inheritFromBefore: boolean
  }): Promise<InsertColumnResultWorker> {
    this.requireAuthConfig()

    const meta = await this.getSpreadsheetMeta()
    const sheet = meta.sheets.find((s) => s.title === params.sheetName)
    if (!sheet) throw new Error(`sheet not found name=${params.sheetName}`)

    const after = letterToColumnNumber(params.afterColumnLetter)
    // Insert AFTER the given column => 0-based startIndex = after
    const startIndex = after
    const insertedColumnLetter = columnNumberToLetter(after + 1)

    if (this.cfg.dryRun) {
      return { insertedColumnLetter, dryRunSkipped: true }
    }

    const sheetsApi = await this.getSheetsClient()

    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: this.cfg.spreadsheetId,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: {
                sheetId: sheet.sheetId,
                dimension: 'COLUMNS',
                startIndex,
                endIndex: startIndex + 1,
              },
              inheritFromBefore: params.inheritFromBefore,
            },
          },
        ],
      },
    })

    this.metaCache = null

    return { insertedColumnLetter, dryRunSkipped: false }
  }

  async copyRow(params: {
    sheetName: string
    sourceRowNumber: number
    targetRowNumber: number
    startColumnLetter: string
    endColumnLetter: string
    pasteType: 'PASTE_NORMAL' | 'PASTE_VALUES' | 'PASTE_FORMAT'
  }): Promise<CopyRowResultWorker> {
    this.requireAuthConfig()

    const meta = await this.getSpreadsheetMeta()
    const sheet = meta.sheets.find((s) => s.title === params.sheetName)
    if (!sheet) throw new Error(`sheet not found name=${params.sheetName}`)

    const startRowIndex = Math.max(0, params.sourceRowNumber - 1)
    const endRowIndex = startRowIndex + 1

    const destStartRowIndex = Math.max(0, params.targetRowNumber - 1)
    const destEndRowIndex = destStartRowIndex + 1

    const startColumnIndex = Math.max(0, letterToColumnNumber(params.startColumnLetter) - 1)
    const endColumnIndex = Math.max(startColumnIndex + 1, letterToColumnNumber(params.endColumnLetter)) // exclusive

    if (this.cfg.dryRun) {
      return { ok: true, dryRunSkipped: true }
    }

    const sheetsApi = await this.getSheetsClient()

    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: this.cfg.spreadsheetId,
      requestBody: {
        requests: [
          {
            copyPaste: {
              source: {
                sheetId: sheet.sheetId,
                startRowIndex,
                endRowIndex,
                startColumnIndex,
                endColumnIndex,
              },
              destination: {
                sheetId: sheet.sheetId,
                startRowIndex: destStartRowIndex,
                endRowIndex: destEndRowIndex,
                startColumnIndex,
                endColumnIndex,
              },
              pasteType: params.pasteType,
            },
          },
        ],
      },
    })

    return { ok: true, dryRunSkipped: false }
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

    this.requireAuthConfig()

    const sheets = await this.getSheetsClient()

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

  private async getSheetsClient(): Promise<any> {
    if (this.sheetsClientPromise) return await this.sheetsClientPromise

    this.sheetsClientPromise = (async () => {
      // Dynamic import so the orchestrator can boot without googleapis installed
      let googleapis: any
      try {
        googleapis = await import('googleapis')
      } catch {
        throw new Error("SheetsService: 'googleapis' dependency not found. Install it.")
      }

      const { google } = googleapis
      const scopes = ['https://www.googleapis.com/auth/spreadsheets']

      // Normalize private key for env formats where newlines are escaped.
      const privateKey = this.cfg.privateKey!.replace(/\\n/g, '\n')

      const auth = new google.auth.JWT({
        email: this.cfg.serviceAccountEmail!,
        key: privateKey,
        scopes,
      })

      return google.sheets({ version: 'v4', auth })
    })()

    return await this.sheetsClientPromise
  }

  private async appendRunRow(sheets: any, envelope: RunEnvelope): Promise<void> {
    const row = envelope.run
    const values = [
      [
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
      ],
    ]

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

// -----------------------------
// A1 helpers (worker-local)
// -----------------------------

function letterToColumnNumber(letter: string): number {
  if (typeof letter !== 'string' || !/^[A-Z]+$/i.test(letter)) {
    throw new Error(`invalid column letter: ${letter}`)
  }
  let col = 0
  const up = letter.toUpperCase()
  for (let i = 0; i < up.length; i++) {
    const c = up.charCodeAt(i)
    col = col * 26 + (c - 64)
  }
  return col
}

function columnNumberToLetter(column: number): string {
  if (!Number.isFinite(column) || column <= 0) {
    throw new Error(`invalid column number: ${column}`)
  }
  let temp = column
  let out = ''
  while (temp > 0) {
    const rem = (temp - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    temp = Math.floor((temp - 1) / 26)
  }
  return out
}
