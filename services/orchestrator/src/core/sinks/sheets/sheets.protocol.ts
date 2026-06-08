// services/orchestrator/src/core/sinks/sheets/sheets.protocol.ts
import type { RunEnvelope } from './sheets.envelope.js'
import type { SheetsConfig } from './sheets.config.js'

export type TaskId = string

export type SheetsWorkerInit = {
  kind: 'init'
  taskId: TaskId
  config: SheetsConfig
}

export type SheetsWorkerHealthcheck = {
  kind: 'healthcheck'
  taskId: TaskId
}

/**
 * Auth warm-up / preflight.
 *
 * This performs a read-only request against the spreadsheet to verify:
 * - googleapis can be loaded
 * - service account creds are valid
 * - the spreadsheetId is reachable and shared with the service account
 */
export type SheetsWorkerAuthWarmup = {
  kind: 'authWarmup'
  taskId: TaskId
}

export type SheetsWorkerPublishRun = {
  kind: 'publishRun'
  taskId: TaskId
  envelope: RunEnvelope
  /**
   * If true, the worker should avoid any destructive writes and prefer idempotent operations.
   * (Scaffold: currently unused.)
   */
  idempotent?: boolean
}

/**
 * Read-only spreadsheet metadata (sheet names/ids and grid properties).
 */
export type SheetsWorkerGetSpreadsheetMeta = {
  kind: 'getSpreadsheetMeta'
  taskId: TaskId
}

export type SheetsMajorDimension = 'ROWS' | 'COLUMNS'
export type SheetsValueRenderOption = 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA'
export type SheetsDateTimeRenderOption = 'SERIAL_NUMBER' | 'FORMATTED_STRING'

/**
 * Read values from a single A1 range.
 *
 * NOTE: The Sheets API omits empty trailing rows/columns in its response. This is
 * a Google API behavior; callers should not rely on fixed-width arrays.
 */
export type SheetsWorkerValuesGet = {
  kind: 'valuesGet'
  taskId: TaskId
  range: string
  majorDimension?: SheetsMajorDimension
  valueRenderOption?: SheetsValueRenderOption
  dateTimeRenderOption?: SheetsDateTimeRenderOption
}

export type SheetsWorkerValuesBatchGet = {
  kind: 'valuesBatchGet'
  taskId: TaskId
  ranges: string[]
  majorDimension?: SheetsMajorDimension
  valueRenderOption?: SheetsValueRenderOption
  dateTimeRenderOption?: SheetsDateTimeRenderOption
}

/**
 * Update values in a single A1 range.
 *
 * SAFETY: If config.dryRun === true, the worker will skip the write and return
 * a result with dryRunSkipped=true.
 */
export type SheetsWorkerValuesUpdate = {
  kind: 'valuesUpdate'
  taskId: TaskId
  range: string
  values: (string | number | boolean | null)[][]
  valueInputOption?: 'RAW' | 'USER_ENTERED'
  includeValuesInResponse?: boolean
}

/**
 * Insert a row at the given 1-based rowNumber. If rowNumber is omitted, insert at the bottom.
 *
 * SAFETY: If config.dryRun === true, the worker will skip the write and return
 * a result with dryRunSkipped=true.
 */
export type SheetsWorkerInsertRow = {
  kind: 'insertRow'
  taskId: TaskId
  sheetName: string
  rowNumber?: number
  inheritFromBefore?: boolean
}

/**
 * Insert a column after the given column letter (e.g., afterColumnLetter="C" inserts a new column after C).
 *
 * SAFETY: If config.dryRun === true, the worker will skip the write and return
 * a result with dryRunSkipped=true.
 */
export type SheetsWorkerInsertColumn = {
  kind: 'insertColumn'
  taskId: TaskId
  sheetName: string
  afterColumnLetter: string
  inheritFromBefore?: boolean
}

/**
 * Copy a single row's cells from sourceRowNumber to targetRowNumber over a column span.
 *
 * This is the "template row → new result row" primitive in the older design.
 *
 * SAFETY: If config.dryRun === true, the worker will skip the write and return
 * a result with dryRunSkipped=true.
 */
export type SheetsWorkerCopyRow = {
  kind: 'copyRow'
  taskId: TaskId
  sheetName: string
  sourceRowNumber: number
  targetRowNumber: number
  startColumnLetter: string
  endColumnLetter: string
  pasteType?: 'PASTE_NORMAL' | 'PASTE_VALUES' | 'PASTE_FORMAT'
}

export type SheetsWorkerShutdown = {
  kind: 'shutdown'
  taskId: TaskId
}

export type SheetsWorkerRequest =
  | SheetsWorkerInit
  | SheetsWorkerHealthcheck
  | SheetsWorkerAuthWarmup
  | SheetsWorkerPublishRun
  | SheetsWorkerGetSpreadsheetMeta
  | SheetsWorkerValuesGet
  | SheetsWorkerValuesBatchGet
  | SheetsWorkerValuesUpdate
  | SheetsWorkerInsertRow
  | SheetsWorkerInsertColumn
  | SheetsWorkerCopyRow
  | SheetsWorkerShutdown

export type SheetsWorkerReady = {
  kind: 'ready'
  taskId: TaskId
  workerId: string
  version: string
}

export type SheetsWorkerResult<T> = {
  kind: 'result'
  taskId: TaskId
  ok: true
  result: T
}

export type SheetsWorkerError = {
  kind: 'result'
  taskId: TaskId
  ok: false
  error: {
    message: string
    code?: string
    retryable?: boolean
  }
}

export type SheetsWorkerLog = {
  kind: 'log'
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  meta?: Record<string, unknown>
}

export type SheetsWorkerResponse<T = unknown> =
  | SheetsWorkerReady
  | SheetsWorkerResult<T>
  | SheetsWorkerError
  | SheetsWorkerLog

export type AuthWarmupStatus =
  | { status: 'never' } // warmup never attempted on this worker
  | { status: 'ok'; at: string; spreadsheetTitle?: string }
  | { status: 'error'; at: string; error: { message: string; code?: string } }

export type WorkerHealth = {
  status: 'ok' | 'error'
  at: string
  details?: {
    dryRun?: boolean
    authWarmup?: AuthWarmupStatus
  } & Record<string, unknown>
}

export type SpreadsheetMetaWorker = {
  spreadsheetId: string
  title?: string
  sheets: Array<{
    sheetId: number
    title: string
    rowCount?: number
    columnCount?: number
  }>
}

export type ValuesGetResultWorker = {
  range: string
  majorDimension: SheetsMajorDimension
  values: (string | number | boolean | null)[][]
}

export type ValuesBatchGetResultWorker = {
  spreadsheetId: string
  valueRanges: Array<{
    range: string
    majorDimension: SheetsMajorDimension
    values: (string | number | boolean | null)[][]
  }>
}

export type ValuesUpdateResultWorker = {
  updatedRange?: string
  updatedRows?: number
  updatedColumns?: number
  updatedCells?: number
  dryRunSkipped?: boolean
}

export type InsertRowResultWorker = {
  insertedRowNumber: number
  dryRunSkipped?: boolean
}

export type InsertColumnResultWorker = {
  insertedColumnLetter: string
  dryRunSkipped?: boolean
}

export type CopyRowResultWorker = {
  ok: true
  dryRunSkipped?: boolean
}

export type PublishReceiptWorker = {
  runId: string
  publishedAt: string
  ok: boolean
  // Range refs are optional in scaffold
  runsRowRef?: { sheet: string; row: number }
  metricsRangeRef?: { sheet: string; startRow: number; endRow: number }
  artifactsRangeRef?: { sheet: string; startRow: number; endRow: number }
  warnings?: string[]
  details?: Record<string, unknown>
}
