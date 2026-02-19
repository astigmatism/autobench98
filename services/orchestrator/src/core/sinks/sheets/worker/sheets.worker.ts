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

import { toWorkerError } from './sheets.errors.js'
import { SheetsRuntime } from './sheets.runtime.js'

const runtime = new SheetsRuntime()
const workerId = randomUUID()

if (!parentPort) {
  throw new Error('sheets.worker: parentPort is null (not running in a Worker)')
}

function send<T>(msg: SheetsWorkerResponse<T>) {
  parentPort!.postMessage(msg)
}

parentPort.on('message', async (req: SheetsWorkerRequest) => {
  try {
    switch (req.kind) {
      case 'init': {
        await runtime.init(req.config)
        send({
          kind: 'ready',
          taskId: req.taskId,
          workerId,
          version: 'scaffold-3',
        })
        return
      }

      case 'healthcheck': {
        const health: WorkerHealth = await runtime.healthcheck()
        send({ kind: 'result', taskId: req.taskId, ok: true, result: health })
        return
      }

      case 'authWarmup': {
        const status: AuthWarmupStatus = await runtime.authWarmup()
        send({ kind: 'result', taskId: req.taskId, ok: true, result: status })
        return
      }

      case 'getSpreadsheetMeta': {
        const meta: SpreadsheetMetaWorker = await runtime.getSpreadsheetMeta()
        send({ kind: 'result', taskId: req.taskId, ok: true, result: meta })
        return
      }

      case 'valuesGet': {
        const result: ValuesGetResultWorker = await runtime.valuesGet({
          range: req.range,
          majorDimension: req.majorDimension ?? 'ROWS',
          valueRenderOption: req.valueRenderOption,
          dateTimeRenderOption: req.dateTimeRenderOption,
        })
        send({ kind: 'result', taskId: req.taskId, ok: true, result })
        return
      }

      case 'valuesBatchGet': {
        const result: ValuesBatchGetResultWorker = await runtime.valuesBatchGet({
          ranges: req.ranges,
          majorDimension: req.majorDimension ?? 'ROWS',
          valueRenderOption: req.valueRenderOption,
          dateTimeRenderOption: req.dateTimeRenderOption,
        })
        send({ kind: 'result', taskId: req.taskId, ok: true, result })
        return
      }

      case 'valuesUpdate': {
        const result: ValuesUpdateResultWorker = await runtime.valuesUpdate({
          range: req.range,
          values: req.values,
          valueInputOption: req.valueInputOption ?? 'USER_ENTERED',
          includeValuesInResponse: req.includeValuesInResponse,
        })
        send({ kind: 'result', taskId: req.taskId, ok: true, result })
        return
      }

      case 'insertRow': {
        const result: InsertRowResultWorker = await runtime.insertRow({
          sheetName: req.sheetName,
          rowNumber: req.rowNumber,
          inheritFromBefore: req.inheritFromBefore ?? true,
        })
        send({ kind: 'result', taskId: req.taskId, ok: true, result })
        return
      }

      case 'insertColumn': {
        const result: InsertColumnResultWorker = await runtime.insertColumn({
          sheetName: req.sheetName,
          afterColumnLetter: req.afterColumnLetter,
          inheritFromBefore: req.inheritFromBefore ?? true,
        })
        send({ kind: 'result', taskId: req.taskId, ok: true, result })
        return
      }

      case 'copyRow': {
        const result: CopyRowResultWorker = await runtime.copyRow({
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
        const receipt: PublishReceiptWorker = await runtime.publishRun(req.envelope)
        send({ kind: 'result', taskId: req.taskId, ok: true, result: receipt })
        return
      }

      case 'shutdown': {
        await runtime.shutdown()
        send({ kind: 'result', taskId: req.taskId, ok: true, result: { ok: true } })
        return
      }
    }
  } catch (err) {
    send({
      kind: 'result',
      taskId: (req as any).taskId ?? 'unknown',
      ok: false,
      error: toWorkerError(err),
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
