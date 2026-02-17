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

export type SheetsWorkerShutdown = {
  kind: 'shutdown'
  taskId: TaskId
}

export type SheetsWorkerRequest =
  | SheetsWorkerInit
  | SheetsWorkerHealthcheck
  | SheetsWorkerPublishRun
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

export type WorkerHealth = {
  status: 'ok' | 'error'
  at: string
  details?: Record<string, unknown>
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
