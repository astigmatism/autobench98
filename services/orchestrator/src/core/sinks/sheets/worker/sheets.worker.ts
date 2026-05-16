// services/orchestrator/src/core/sinks/sheets/worker/sheets.worker.ts
import { parentPort } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'

import type {
  SheetsWorkerRequest,
  SheetsWorkerResponse,
  PublishReceiptWorker,
  WorkerHealth,
  AuthWarmupStatus,
  SpreadsheetMetaWorker,
  ValuesGetResultWorker,
  ValuesBatchGetResultWorker,
  ValuesUpdateResultWorker,
  InsertRowResultWorker,
  InsertColumnResultWorker,
  CopyRowResultWorker,
} from '../sheets.protocol.js'

type SheetsWorkerErrorShape = {
  message: string
  code?: string
  retryable?: boolean
}

type ToWorkerErrorFn = (err: unknown) => SheetsWorkerErrorShape

type SheetsRuntimeLike = {
  init(cfg: any): Promise<void>
  shutdown(): Promise<void>
  healthcheck(): Promise<WorkerHealth>
  authWarmup(): Promise<AuthWarmupStatus>
  getSpreadsheetMeta(): Promise<SpreadsheetMetaWorker>
  valuesGet(params: {
    range: string
    majorDimension: any
    valueRenderOption?: any
    dateTimeRenderOption?: any
  }): Promise<ValuesGetResultWorker>
  valuesBatchGet(params: {
    ranges: string[]
    majorDimension: any
    valueRenderOption?: any
    dateTimeRenderOption?: any
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
  publishRun(envelope: any): Promise<PublishReceiptWorker>
}

async function importDual<TModule extends Record<string, any>>(base: string): Promise<TModule> {
  // Attempt .js first (dist/prod), then .ts (src/dev)
  try {
    return (await import(`./${base}.js`)) as TModule
  } catch {
    return (await import(`./${base}.ts`)) as TModule
  }
}

async function loadDeps(): Promise<{ toWorkerError: ToWorkerErrorFn; runtime: SheetsRuntimeLike }> {
  const errorsMod = await importDual<{ toWorkerError: ToWorkerErrorFn }>('sheets.errors')
  const runtimeMod = await importDual<{ SheetsRuntime: new () => SheetsRuntimeLike }>('sheets.runtime')

  if (typeof errorsMod.toWorkerError !== 'function') {
    throw new Error('sheets.worker: toWorkerError export missing/invalid')
  }
  if (typeof runtimeMod.SheetsRuntime !== 'function') {
    throw new Error('sheets.worker: SheetsRuntime export missing/invalid')
  }

  return {
    toWorkerError: errorsMod.toWorkerError,
    runtime: new runtimeMod.SheetsRuntime(),
  }
}

const workerId = randomUUID()

if (!parentPort) {
  throw new Error('sheets.worker: parentPort is null (not running in a Worker)')
}

function send<T>(msg: SheetsWorkerResponse<T>) {
  parentPort!.postMessage(msg)
}

const depsPromise = loadDeps()

parentPort.on('message', async (req: SheetsWorkerRequest) => {
  const deps = await depsPromise

  try {
    switch (req.kind) {
      case 'init': {
        await deps.runtime.init(req.config)
        send({
          kind: 'ready',
          taskId: req.taskId,
          workerId,
          version: 'scaffold-3',
        })
        return
      }

      case 'healthcheck': {
        const health: WorkerHealth = await deps.runtime.healthcheck()
        send({ kind: 'result', taskId: req.taskId, ok: true, result: health })
        return
      }

      case 'authWarmup': {
        const status: AuthWarmupStatus = await deps.runtime.authWarmup()
        send({ kind: 'result', taskId: req.taskId, ok: true, result: status })
        return
      }

      case 'getSpreadsheetMeta': {
        const meta: SpreadsheetMetaWorker = await deps.runtime.getSpreadsheetMeta()
        send({ kind: 'result', taskId: req.taskId, ok: true, result: meta })
        return
      }

      case 'valuesGet': {
        const result: ValuesGetResultWorker = await deps.runtime.valuesGet({
          range: req.range,
          majorDimension: req.majorDimension ?? 'ROWS',
          valueRenderOption: req.valueRenderOption,
          dateTimeRenderOption: req.dateTimeRenderOption,
        })
        send({ kind: 'result', taskId: req.taskId, ok: true, result })
        return
      }

      case 'valuesBatchGet': {
        const result: ValuesBatchGetResultWorker = await deps.runtime.valuesBatchGet({
          ranges: req.ranges,
          majorDimension: req.majorDimension ?? 'ROWS',
          valueRenderOption: req.valueRenderOption,
          dateTimeRenderOption: req.dateTimeRenderOption,
        })
        send({ kind: 'result', taskId: req.taskId, ok: true, result })
        return
      }

      case 'valuesUpdate': {
        const result: ValuesUpdateResultWorker = await deps.runtime.valuesUpdate({
          range: req.range,
          values: req.values,
          valueInputOption: req.valueInputOption ?? 'USER_ENTERED',
          includeValuesInResponse: req.includeValuesInResponse,
        })
        send({ kind: 'result', taskId: req.taskId, ok: true, result })
        return
      }

      case 'insertRow': {
        const result: InsertRowResultWorker = await deps.runtime.insertRow({
          sheetName: req.sheetName,
          rowNumber: req.rowNumber,
          inheritFromBefore: req.inheritFromBefore ?? true,
        })
        send({ kind: 'result', taskId: req.taskId, ok: true, result })
        return
      }

      case 'insertColumn': {
        const result: InsertColumnResultWorker = await deps.runtime.insertColumn({
          sheetName: req.sheetName,
          afterColumnLetter: req.afterColumnLetter,
          inheritFromBefore: req.inheritFromBefore ?? true,
        })
        send({ kind: 'result', taskId: req.taskId, ok: true, result })
        return
      }

      case 'copyRow': {
        const result: CopyRowResultWorker = await deps.runtime.copyRow({
          sheetName: req.sheetName,
          sourceRowNumber: req.sourceRowNumber,
          targetRowNumber: req.targetRowNumber,
          startColumnLetter: req.startColumnLetter,
          endColumnLetter: req.endColumnLetter,
          pasteType: req.pasteType ?? 'PASTE_NORMAL',
        })
        send({ kind: 'result', taskId: req.taskId, ok: true, result })
        return
      }

      case 'publishRun': {
        const receipt: PublishReceiptWorker = await deps.runtime.publishRun(req.envelope)
        send({ kind: 'result', taskId: req.taskId, ok: true, result: receipt })
        return
      }

      case 'shutdown': {
        await deps.runtime.shutdown()
        send({ kind: 'result', taskId: req.taskId, ok: true, result: { ok: true } })
        return
      }
    }
  } catch (err) {
    send({
      kind: 'result',
      taskId: (req as any).taskId ?? 'unknown',
      ok: false,
      error: deps.toWorkerError(err),
    })
  }
})

// Hard safety: prevent silent worker death
process.on('unhandledRejection', (err) => {
  send({ kind: 'log', level: 'error', message: 'unhandledRejection', meta: { err: String(err) } })
})

process.on('uncaughtException', (err) => {
  send({ kind: 'log', level: 'error', message: 'uncaughtException', meta: { err: String(err) } })
})
