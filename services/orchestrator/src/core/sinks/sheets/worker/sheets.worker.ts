import { parentPort } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'

import type {
  SheetsWorkerRequest,
  SheetsWorkerResponse,
  PublishReceiptWorker,
  WorkerHealth,
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
          version: 'scaffold-1',
        })
        return
      }

      case 'healthcheck': {
        const health: WorkerHealth = await runtime.healthcheck()
        send({ kind: 'result', taskId: req.taskId, ok: true, result: health })
        return
      }

      case 'publishRun': {
        const receipt: PublishReceiptWorker = await runtime.publishRun(req.envelope)
        send({ kind: 'result', taskId: req.taskId, ok: true, result: receipt })
        return
      }

      case 'shutdown': {
        // Scaffold: no special cleanup
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
