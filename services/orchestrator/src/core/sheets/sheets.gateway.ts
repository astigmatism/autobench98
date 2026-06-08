// services/orchestrator/src/core/sheets/sheets.gateway.ts
import type { ChannelLogger } from '@autobench98/logging'

import type {
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
} from '../sinks/sheets/sheets.protocol.js'

import { SheetsHost, type SheetsExecMode } from './sheets.host.js'
import { TtlCache } from './sheets.cache.js'

export type SpreadsheetMeta = SpreadsheetMetaWorker

export type RangeReadOptions = {
  mode?: SheetsExecMode
  majorDimension?: SheetsMajorDimension
  valueRenderOption?: SheetsValueRenderOption
  dateTimeRenderOption?: SheetsDateTimeRenderOption
  /**
   * Override cache TTL for this call (ms). If not provided, uses cfg.cache.rangeTtlMs.
   * 0 disables caching for this call.
   */
  cacheTtlMs?: number
  /**
   * If true, bypass cache for this call.
   */
  bypassCache?: boolean
}

export type KeyMapOptions = {
  mode?: SheetsExecMode
  startColumnLetter?: string
  endColumnLetter?: string
  cacheTtlMs?: number
  bypassCache?: boolean
}

export type RangeWriteOptions = {
  mode?: SheetsExecMode
  valueInputOption?: 'RAW' | 'USER_ENTERED'
  includeValuesInResponse?: boolean
}

export type InsertRowOptions = {
  mode?: SheetsExecMode
  inheritFromBefore?: boolean
}

export type CopyRowOptions = {
  mode?: SheetsExecMode
  pasteType?: 'PASTE_NORMAL' | 'PASTE_VALUES' | 'PASTE_FORMAT'
}

/**
 * SheetsGateway
 *
 * Main-thread facade that:
 * - exposes read/write primitives for Google Sheets (database-like use)
 * - adds safe in-memory caching for metadata, key maps, and value ranges
 * - delegates ALL network work to SheetsHost workers
 *
 * This is intentionally general-purpose and can be used by:
 * - benchmark flows (template model / workbook mapping)
 * - Studio UI lookups (historical/reference data)
 * - the SheetsSink (result publishing) indirectly
 */
export class SheetsGateway {
  private readonly host: SheetsHost
  private readonly log: ChannelLogger

  private readonly metaCache: TtlCache<SpreadsheetMeta>
  private readonly keyMapCache: TtlCache<Record<string, string>>
  private readonly rangeCache: TtlCache<ValuesGetResultWorker>

  constructor(opts: { host: SheetsHost; logger: ChannelLogger }) {
    this.host = opts.host
    this.log = opts.logger

    const cfg = this.host.getConfig()
    this.metaCache = new TtlCache({ maxEntries: cfg.cache.maxEntries })
    this.keyMapCache = new TtlCache({ maxEntries: cfg.cache.maxEntries })
    this.rangeCache = new TtlCache({ maxEntries: cfg.cache.maxEntries })
  }

  getConfig() {
    return this.host.getConfig()
  }

  /**
   * Explicit init (optional). The host is idempotent; callers can also rely on lazy init.
   */
  async init(): Promise<void> {
    await this.host.init()
  }

  async healthySnapshot() {
    return await this.host.healthySnapshot()
  }

  // -----------------------------
  // Metadata + helpers
  // -----------------------------

  private metaCacheKey(): string {
    const cfg = this.host.getConfig()
    return `meta:${cfg.spreadsheetId ?? 'null'}`
  }

  async getSpreadsheetMeta(opts: { bypassCache?: boolean; cacheTtlMs?: number; mode?: SheetsExecMode } = {}): Promise<SpreadsheetMeta> {
    const cfg = this.host.getConfig()
    const now = Date.now()

    const cacheEnabled = cfg.cache.enabled
    const cacheTtl = opts.cacheTtlMs ?? cfg.cache.sheetMetaTtlMs
    const key = this.metaCacheKey()

    if (cacheEnabled && !opts.bypassCache) {
      const hit = this.metaCache.get(key, now)
      if (hit) return hit
    }

    const mode = opts.mode ?? 'background'
    const meta = await this.host.exec<SpreadsheetMetaWorker>(mode, (taskId) => ({
      kind: 'getSpreadsheetMeta',
      taskId,
    }))

    if (cacheEnabled && cacheTtl > 0) {
      this.metaCache.set(key, meta, cacheTtl, now)
    }

    return meta
  }

  /**
   * Find a sheet by title (exact match).
   */
  async getSheetByName(sheetName: string): Promise<{ sheetId: number; title: string; rowCount?: number; columnCount?: number }> {
    const meta = await this.getSpreadsheetMeta()
    const s = meta.sheets.find((x) => x.title === sheetName)
    if (!s) throw new Error(`Sheet not found name=${sheetName}`)
    return s
  }

  // -----------------------------
  // Read primitives
  // -----------------------------

  private rangeCacheKey(range: string, majorDimension: SheetsMajorDimension, valueRenderOption?: string, dateTimeRenderOption?: string): string {
    return `range:${majorDimension}:${valueRenderOption ?? ''}:${dateTimeRenderOption ?? ''}:${range}`
  }

  async valuesGet(range: string, opts: RangeReadOptions = {}): Promise<ValuesGetResultWorker> {
    const cfg = this.host.getConfig()
    const now = Date.now()

    const majorDimension = opts.majorDimension ?? 'ROWS'
    const cacheEnabled = cfg.cache.enabled
    const cacheTtl = opts.cacheTtlMs ?? cfg.cache.rangeTtlMs
    const cacheKey = this.rangeCacheKey(range, majorDimension, opts.valueRenderOption, opts.dateTimeRenderOption)

    if (cacheEnabled && cacheTtl > 0 && !opts.bypassCache) {
      const hit = this.rangeCache.get(cacheKey, now)
      if (hit) return hit
    }

    const mode = opts.mode ?? 'background'
    const res = await this.host.exec<ValuesGetResultWorker>(mode, (taskId) => ({
      kind: 'valuesGet',
      taskId,
      range,
      majorDimension,
      valueRenderOption: opts.valueRenderOption,
      dateTimeRenderOption: opts.dateTimeRenderOption,
    }))

    if (cacheEnabled && cacheTtl > 0) {
      this.rangeCache.set(cacheKey, res, cacheTtl, now)
    }

    return res
  }

  async valuesBatchGet(ranges: string[], opts: RangeReadOptions = {}): Promise<ValuesBatchGetResultWorker> {
    const mode = opts.mode ?? 'background'
    return await this.host.exec<ValuesBatchGetResultWorker>(mode, (taskId) => ({
      kind: 'valuesBatchGet',
      taskId,
      ranges,
      majorDimension: opts.majorDimension ?? 'ROWS',
      valueRenderOption: opts.valueRenderOption,
      dateTimeRenderOption: opts.dateTimeRenderOption,
    }))
  }

  // -----------------------------
  // Key map helpers (template model)
  // -----------------------------

  private keyMapCacheKey(sheetName: string, rowNumber: number, startCol: string, endCol: string): string {
    return `keymap:${sheetName}:${rowNumber}:${startCol}:${endCol}`
  }

  /**
   * Get a mapping from cell value -> column letter for a given row (usually the "keys row").
   *
   * This supports your workbook-template model:
   * - keys row contains semantic markers ("Preface-start", benchmark IDs, etc.)
   * - you locate blocks by marker -> write values into that block
   */
  async getValueToColumnLetterMap(sheetName: string, rowNumber: number, opts: KeyMapOptions = {}): Promise<Record<string, string>> {
    const cfg = this.host.getConfig()
    const now = Date.now()

    const mode = opts.mode ?? 'background'

    const meta = await this.getSheetByName(sheetName)
    const startCol = (opts.startColumnLetter ?? 'A').toUpperCase()
    const endCol =
      (opts.endColumnLetter ?? columnNumberToLetter(meta.columnCount ?? 1)).toUpperCase()

    const cacheEnabled = cfg.cache.enabled
    const cacheTtl = opts.cacheTtlMs ?? cfg.cache.keyMapTtlMs
    const cacheKey = this.keyMapCacheKey(sheetName, rowNumber, startCol, endCol)

    if (cacheEnabled && cacheTtl > 0 && !opts.bypassCache) {
      const hit = this.keyMapCache.get(cacheKey, now)
      if (hit) return hit
    }

    const range = `${sheetName}!${startCol}${rowNumber}:${endCol}${rowNumber}`
    const res = await this.valuesGet(range, { mode, majorDimension: 'ROWS', bypassCache: true })

    const row = res.values?.[0] ?? []
    const map: Record<string, string> = {}

    for (let i = 0; i < row.length; i++) {
      const v = row[i]
      if (v === null || v === undefined) continue
      const s = String(v).trim()
      if (!s) continue

      const colNum = letterToColumnNumber(startCol) + i
      const colLetter = columnNumberToLetter(colNum)
      map[s] = colLetter
    }

    if (cacheEnabled && cacheTtl > 0) {
      this.keyMapCache.set(cacheKey, map, cacheTtl, now)
    }

    return map
  }

  // -----------------------------
  // Write primitives (template model building blocks)
  // -----------------------------

  async valuesUpdate(range: string, values: (string | number | boolean | null)[][], opts: RangeWriteOptions = {}): Promise<ValuesUpdateResultWorker> {
    const mode = opts.mode ?? 'blocking'
    return await this.host.exec<ValuesUpdateResultWorker>(mode, (taskId) => ({
      kind: 'valuesUpdate',
      taskId,
      range,
      values,
      valueInputOption: opts.valueInputOption ?? 'USER_ENTERED',
      includeValuesInResponse: opts.includeValuesInResponse ?? false,
    }))
  }

  async insertRow(sheetName: string, rowNumber?: number, opts: InsertRowOptions = {}): Promise<InsertRowResultWorker> {
    const mode = opts.mode ?? 'blocking'
    return await this.host.exec<InsertRowResultWorker>(mode, (taskId) => ({
      kind: 'insertRow',
      taskId,
      sheetName,
      rowNumber,
      inheritFromBefore: opts.inheritFromBefore ?? true,
    }))
  }

  async insertColumn(sheetName: string, afterColumnLetter: string, opts: { mode?: SheetsExecMode; inheritFromBefore?: boolean } = {}): Promise<InsertColumnResultWorker> {
    const mode = opts.mode ?? 'blocking'
    return await this.host.exec<InsertColumnResultWorker>(mode, (taskId) => ({
      kind: 'insertColumn',
      taskId,
      sheetName,
      afterColumnLetter,
      inheritFromBefore: opts.inheritFromBefore ?? true,
    }))
  }

  async copyRow(
    sheetName: string,
    sourceRowNumber: number,
    targetRowNumber: number,
    startColumnLetter: string,
    endColumnLetter: string,
    opts: CopyRowOptions = {}
  ): Promise<CopyRowResultWorker> {
    const mode = opts.mode ?? 'blocking'
    return await this.host.exec<CopyRowResultWorker>(mode, (taskId) => ({
      kind: 'copyRow',
      taskId,
      sheetName,
      sourceRowNumber,
      targetRowNumber,
      startColumnLetter,
      endColumnLetter,
      pasteType: opts.pasteType ?? 'PASTE_NORMAL',
    }))
  }

  // -----------------------------
  // Cache control
  // -----------------------------

  clearAllCaches(): void {
    this.metaCache.clear()
    this.keyMapCache.clear()
    this.rangeCache.clear()
    this.log.info('SheetsGateway caches cleared')
  }
}

// -----------------------------
// Column helpers (A1 tools)
// -----------------------------

export function letterToColumnNumber(letter: string): number {
  if (typeof letter !== 'string' || !/^[A-Z]+$/i.test(letter)) {
    throw new Error(`Invalid column letter: ${letter}`)
  }
  let column = 0
  const letters = letter.toUpperCase()
  for (let i = 0; i < letters.length; i++) {
    const charCode = letters.charCodeAt(i)
    if (charCode < 65 || charCode > 90) {
      throw new Error(`Invalid column letter: ${letter}`)
    }
    column = column * 26 + (charCode - 64)
  }
  return column
}

export function columnNumberToLetter(column: number): string {
  if (!Number.isFinite(column) || column <= 0) {
    throw new Error(`Invalid column number: ${column}`)
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
