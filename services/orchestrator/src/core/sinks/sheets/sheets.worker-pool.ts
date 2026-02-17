import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'

import type {
  SheetsWorkerRequest,
  SheetsWorkerResponse,
  TaskId,
  WorkerHealth,
  PublishReceiptWorker,
} from './sheets.protocol.js'

export type WorkerPoolStats = {
  size: number
  busy: number
  pending: number
}

export type WorkerPoolOptions = {
  name: string
  size: number
  workerUrl: URL
  maxPending: number
  timeoutMs: number
}

type PendingTask = {
  taskId: TaskId
  req: SheetsWorkerRequest
  resolve: (v: any) => void
  reject: (e: any) => void
  timeout: NodeJS.Timeout
  slotId: string | null
  direct: boolean
}

type WorkerSlot = {
  id: string
  worker: Worker
  busy: boolean
  currentTaskId: string | null
  restarting: boolean
}

/**
 * Minimal worker pool (scaffold).
 *
 * Safety goals:
 * - bounded queue (maxPending)
 * - per-task timeouts
 * - fail-fast on worker errors (reject current task)
 * - restart worker on abnormal exit/timeout
 *
 * NOTE: This is intentionally simple and should be hardened later with:
 * - exponential backoff + jitter on respawn
 * - poison-pill / circuit breaker on repeated failures
 * - better drain semantics and shutdown coordination
 */
export class WorkerPool {
  private readonly name: string
  private readonly size: number
  private readonly workerUrl: URL
  private readonly maxPending: number
  private readonly timeoutMs: number

  private readonly slots: WorkerSlot[] = []
  private readonly queue: PendingTask[] = []
  private readonly inflight: Map<string, PendingTask> = new Map()

  constructor(opts: WorkerPoolOptions) {
    this.name = opts.name
    this.size = opts.size
    this.workerUrl = opts.workerUrl
    this.maxPending = opts.maxPending
    this.timeoutMs = opts.timeoutMs
  }

  async start(): Promise<void> {
    if (this.size <= 0) return
    for (let i = 0; i < this.size; i++) {
      const slot = this.spawnSlot()
      this.slots.push(slot)
    }
  }

  private spawnSlot(): WorkerSlot {
    const id = `${this.name}:${randomUUID()}`
    const slot: WorkerSlot = {
      id,
      worker: new Worker(this.workerUrl, { type: 'module' }),
      busy: false,
      currentTaskId: null,
      restarting: false,
    }
    this.attachWorker(slot, slot.worker)
    return slot
  }

  private attachWorker(slot: WorkerSlot, worker: Worker): void {
    slot.worker = worker

    worker.on('message', (msg: SheetsWorkerResponse) => {
      // Worker log messages are emitted with kind='log' and no taskId
      if (msg && (msg as any).kind === 'log') return

      const taskId = (msg as any).taskId as string | undefined
      if (!taskId) return

      const pending = this.inflight.get(taskId)
      if (!pending) return

      this.inflight.delete(taskId)
      clearTimeout(pending.timeout)

      // free slot
      slot.busy = false
      slot.currentTaskId = null

      if ((msg as any).kind === 'result') {
        if ((msg as any).ok) pending.resolve((msg as any).result)
        else {
          pending.reject(
            Object.assign(new Error((msg as any).error?.message ?? 'Worker error'), {
              details: (msg as any).error,
            })
          )
        }
      } else {
        // 'ready' or unknown message
        pending.resolve(msg as any)
      }

      // Only dispatch queued work for non-direct tasks.
      // (Direct tasks are typically init broadcasts before the queue is used.)
      if (!pending.direct) this.dispatch()
    })

    worker.on('error', (err) => {
      void this.failSlotAndRestart(slot, err)
    })

    worker.on('exit', (code) => {
      if (code === 0) return
      void this.failSlotAndRestart(slot, new Error(`Worker exited code=${code}`))
    })
  }

  private async failSlotAndRestart(slot: WorkerSlot, reason: unknown): Promise<void> {
    // Reject inflight task on this slot
    if (slot.currentTaskId) {
      const pending = this.inflight.get(slot.currentTaskId)
      if (pending) {
        this.inflight.delete(slot.currentTaskId)
        clearTimeout(pending.timeout)
        pending.reject(reason)
      }
    }

    slot.busy = false
    slot.currentTaskId = null

    await this.restartSlot(slot)
    this.dispatch()
  }

  private async restartSlot(slot: WorkerSlot): Promise<void> {
    if (slot.restarting) return
    slot.restarting = true
    try {
      try {
        await slot.worker.terminate()
      } catch {
        // ignore
      }
      const next = new Worker(this.workerUrl, { type: 'module' })
      this.attachWorker(slot, next)
    } finally {
      slot.restarting = false
    }
  }

  stats(): WorkerPoolStats {
    const busy = this.slots.filter((s) => s.busy).length
    return {
      size: this.slots.length,
      busy,
      pending: this.queue.length + this.inflight.size,
    }
  }

  /**
   * Wait until all queued tasks are dispatched and all workers are idle.
   *
   * SAFETY NOTE: This uses polling and assumes the process event loop is healthy.
   * Replace with a condition variable/event-based approach if you see latency or CPU issues.
   */
  async drain(): Promise<void> {
    while (true) {
      const s = this.stats()
      if (s.pending === 0 && s.busy === 0) return
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  /**
   * Execute a task using the pool scheduler (FIFO, first available worker).
   */
  async exec<T>(makeReq: (taskId: TaskId) => SheetsWorkerRequest): Promise<T> {
    if (this.size <= 0) {
      throw new Error(`WorkerPool(${this.name}) size=0; cannot execute tasks`)
    }

    if (this.queue.length + this.inflight.size >= this.maxPending) {
      throw new Error(
        `WorkerPool(${this.name}) backpressure: pending >= maxPending (${this.maxPending})`
      )
    }

    const taskId = randomUUID()
    const req = makeReq(taskId)

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const inflight = this.inflight.get(taskId)
        if (inflight) {
          this.inflight.delete(taskId)
          inflight.reject(
            new Error(
              `WorkerPool(${this.name}) task timeout after ${this.timeoutMs}ms taskId=${taskId}`
            )
          )

          // If we know which slot was executing this task, restart it.
          if (inflight.slotId) {
            const slot = this.slots.find((s) => s.id === inflight.slotId)
            if (slot) {
              slot.busy = false
              slot.currentTaskId = null
              void this.restartSlot(slot)
            }
          }
        }
        this.dispatch()
      }, this.timeoutMs)

      const pending: PendingTask = {
        taskId,
        req,
        resolve,
        reject,
        timeout,
        slotId: null,
        direct: false,
      }
      this.queue.push(pending)
      this.dispatch()
    })
  }

  /**
   * Execute a task on *each* worker in this pool (sequentially).
   * This is used for per-worker initialization (e.g., sending an auth/config message).
   */
  async broadcast<T>(makeReq: (taskId: TaskId) => SheetsWorkerRequest): Promise<T[]> {
    const out: T[] = []
    for (const slot of this.slots) {
      out.push(await this.execDirectOnSlot<T>(slot, makeReq))
    }
    return out
  }

  private async execDirectOnSlot<T>(
    slot: WorkerSlot,
    makeReq: (taskId: TaskId) => SheetsWorkerRequest
  ): Promise<T> {
    if (slot.restarting) {
      throw new Error(`WorkerPool(${this.name}) slot restarting; cannot run direct task`)
    }
    if (slot.busy) {
      throw new Error(`WorkerPool(${this.name}) slot busy; cannot run direct task`)
    }

    const taskId = randomUUID()
    const req = makeReq(taskId)

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const inflight = this.inflight.get(taskId)
        if (inflight) {
          this.inflight.delete(taskId)
          inflight.reject(
            new Error(
              `WorkerPool(${this.name}) direct task timeout after ${this.timeoutMs}ms taskId=${taskId}`
            )
          )
          slot.busy = false
          slot.currentTaskId = null
          void this.restartSlot(slot)
        }
      }, this.timeoutMs)

      const pending: PendingTask = {
        taskId,
        req,
        resolve,
        reject,
        timeout,
        slotId: slot.id,
        direct: true,
      }

      slot.busy = true
      slot.currentTaskId = taskId
      this.inflight.set(taskId, pending)
      slot.worker.postMessage(req)
    })
  }

  private dispatch(): void {
    const idle = this.slots.find((s) => !s.busy && !s.restarting)
    if (!idle) return
    const task = this.queue.shift()
    if (!task) return

    idle.busy = true
    idle.currentTaskId = task.taskId
    task.slotId = idle.id
    this.inflight.set(task.taskId, task)

    idle.worker.postMessage(task.req)
  }

  async close(): Promise<void> {
    for (const slot of this.slots) {
      try {
        await slot.worker.terminate()
      } catch {
        // ignore
      }
    }
    this.slots.length = 0
    this.queue.length = 0
    this.inflight.clear()
  }
}

export type SheetsPoolsStats = {
  blocking: WorkerPoolStats
  background: WorkerPoolStats
}

export type SheetsPools = {
  blocking: WorkerPool
  background: WorkerPool
}

export async function healthcheckPool(pool: WorkerPool): Promise<WorkerHealth> {
  return await pool.exec<WorkerHealth>((taskId) => ({ kind: 'healthcheck', taskId }))
}

export async function publishRunInPool(
  pool: WorkerPool,
  envelope: any
): Promise<PublishReceiptWorker> {
  return await pool.exec<PublishReceiptWorker>((taskId) => ({
    kind: 'publishRun',
    taskId,
    envelope,
  }))
}
