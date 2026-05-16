// services/orchestrator/src/core/sinks/sheets/worker/sheets.runtime.ts
import type { SheetsConfig } from '../sheets.config.js'
import type { RunEnvelope } from '../sheets.envelope.js'
import type {
  AuthWarmupStatus,
  PublishReceiptWorker,
  WorkerHealth,
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

type SheetsServiceLike = {
  init(): Promise<void>
  getAuthWarmupStatus(): AuthWarmupStatus
  authWarmup(): Promise<AuthWarmupStatus>
  getSpreadsheetMeta(): Promise<SpreadsheetMetaWorker>
  valuesGet(params: {
    range: string
    majorDimension: SheetsMajorDimension
    valueRenderOption?: SheetsValueRenderOption
    dateTimeRenderOption?: SheetsDateTimeRenderOption
  }): Promise<ValuesGetResultWorker>
  valuesBatchGet(params: {
    ranges: string[]
    majorDimension: SheetsMajorDimension
    valueRenderOption?: SheetsValueRenderOption
    dateTimeRenderOption?: SheetsDateTimeRenderOption
  }): Promise<ValuesBatchGetResultWorker>
  valuesUpdate(params: {
    range: string
    values: (string | number | boolean | null)[][]
    valueInputOption: 'RAW' | 'USER_ENTERED'
    includeValuesInResponse?: boolean
  }): Promise<ValuesUpdateResultWorker>
  insertRow(params: { sheetName: string; rowNumber?: number; inheritFromBefore: boolean }): Promise<InsertRowResultWorker>
  insertColumn(params: { sheetName: string; afterColumnLetter: string; inheritFromBefore: boolean }): Promise<InsertColumnResultWorker>
  copyRow(params: {
    sheetName: string
    sourceRowNumber: number
    targetRowNumber: number
    startColumnLetter: string
    endColumnLetter: string
    pasteType: 'PASTE_NORMAL' | 'PASTE_VALUES' | 'PASTE_FORMAT'
  }): Promise<CopyRowResultWorker>
  publishRun(envelope: RunEnvelope): Promise<PublishReceiptWorker>
}

async function importDual<TModule extends Record<string, any>>(base: string): Promise<TModule> {
  try {
    return (await import(`./${base}.js`)) as TModule
  } catch {
    return (await import(`./${base}.ts`)) as TModule
  }
}

async function loadSheetsServiceCtor(): Promise<new (cfg: SheetsConfig) => SheetsServiceLike> {
  const mod = await importDual<{ SheetsService: new (cfg: SheetsConfig) => SheetsServiceLike }>('sheets.service')
  if (typeof mod.SheetsService !== 'function') {
    throw new Error('SheetsRuntime: SheetsService export missing/invalid')
  }
  return mod.SheetsService
}

export class SheetsRuntime {
  private cfg: SheetsConfig | null = null
  private svc: SheetsServiceLike | null = null
  private svcCtorPromise: Promise<new (cfg: SheetsConfig) => SheetsServiceLike> | null = null

  async init(cfg: SheetsConfig): Promise<void> {
    this.cfg = cfg
    if (!this.svcCtorPromise) this.svcCtorPromise = loadSheetsServiceCtor()
    const Ctor = await this.svcCtorPromise
    this.svc = new Ctor(cfg)
    await this.svc.init()
  }

  async shutdown(): Promise<void> {
    // Currently no explicit teardown required; the worker will exit.
    return
  }

  async healthcheck(): Promise<WorkerHealth> {
    const at = new Date().toISOString()
    if (!this.cfg) return { status: 'error', at, details: { reason: 'not initialized' } }
    if (!this.svc) return { status: 'error', at, details: { reason: 'service missing' } }
    return {
      status: 'ok',
      at,
      details: {
        dryRun: this.cfg.dryRun,
        authWarmup: this.svc.getAuthWarmupStatus(),
      },
    }
  }

  async authWarmup(): Promise<AuthWarmupStatus> {
    const at = new Date().toISOString()
    if (!this.cfg || !this.svc) {
      return { status: 'error', at, error: { message: 'worker not initialized' } }
    }
    return await this.svc.authWarmup()
  }

  async getSpreadsheetMeta(): Promise<SpreadsheetMetaWorker> {
    if (!this.svc) throw new Error('SheetsRuntime not initialized')
    return await this.svc.getSpreadsheetMeta()
  }

  async valuesGet(params: {
    range: string
    majorDimension: SheetsMajorDimension
    valueRenderOption?: SheetsValueRenderOption
    dateTimeRenderOption?: SheetsDateTimeRenderOption
  }): Promise<ValuesGetResultWorker> {
    if (!this.svc) throw new Error('SheetsRuntime not initialized')
    return await this.svc.valuesGet(params)
  }

  async valuesBatchGet(params: {
    ranges: string[]
    majorDimension: SheetsMajorDimension
    valueRenderOption?: SheetsValueRenderOption
    dateTimeRenderOption?: SheetsDateTimeRenderOption
  }): Promise<ValuesBatchGetResultWorker> {
    if (!this.svc) throw new Error('SheetsRuntime not initialized')
    return await this.svc.valuesBatchGet(params)
  }

  async valuesUpdate(params: {
    range: string
    values: (string | number | boolean | null)[][]
    valueInputOption: 'RAW' | 'USER_ENTERED'
    includeValuesInResponse?: boolean
  }): Promise<ValuesUpdateResultWorker> {
    if (!this.svc) throw new Error('SheetsRuntime not initialized')
    return await this.svc.valuesUpdate(params)
  }

  async insertRow(params: {
    sheetName: string
    rowNumber?: number
    inheritFromBefore: boolean
  }): Promise<InsertRowResultWorker> {
    if (!this.svc) throw new Error('SheetsRuntime not initialized')
    return await this.svc.insertRow(params)
  }

  async insertColumn(params: {
    sheetName: string
    afterColumnLetter: string
    inheritFromBefore: boolean
  }): Promise<InsertColumnResultWorker> {
    if (!this.svc) throw new Error('SheetsRuntime not initialized')
    return await this.svc.insertColumn(params)
  }

  async copyRow(params: {
    sheetName: string
    sourceRowNumber: number
    targetRowNumber: number
    startColumnLetter: string
    endColumnLetter: string
    pasteType: 'PASTE_NORMAL' | 'PASTE_VALUES' | 'PASTE_FORMAT'
  }): Promise<CopyRowResultWorker> {
    if (!this.svc) throw new Error('SheetsRuntime not initialized')
    return await this.svc.copyRow(params)
  }

  async publishRun(envelope: RunEnvelope): Promise<PublishReceiptWorker> {
    if (!this.svc) throw new Error('SheetsRuntime not initialized')
    return await this.svc.publishRun(envelope)
  }
}
