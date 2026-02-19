// services/orchestrator/src/core/sheets/sheets.host.ts
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

import type { ChannelLogger } from '@autobench98/logging'

import type { SheetsConfig } from '../sinks/sheets/sheets.config.js'
import type {
  SheetsWorkerRequest,
  WorkerHealth,
  AuthWarmupStatus,
} from '../sinks/sheets/sheets.protocol.js'
import { Barrier, Mutex } from '../sinks/sheets/sheets.lock.js'
import { WorkerPool, healthcheckPool, authWarmupPool } from '../sinks/sheets/sheets.worker-pool.js'

export type SheetsExecMode = 'blocking' | 'background'

export type SheetsHostStats = {
  pools: {
    blocking: ReturnType<WorkerPool['stats']>
    background: ReturnType<WorkerPool['stats']>
  }
}

/**
 * SheetsHost
 *
 * Owns worker pools + concurrency policy (barrier/mutex).
 *
 * This is the shared substrate used by:
 * - SheetsSink (publishing results)
 * - SheetsGateway (read/lookup + template model operations)
 *
 * All Google Sheets API calls MUST go through these workers to keep Fastify's
 * main thread isolated from third-party network and latency.
 */
export class SheetsHost {
  private readonly cfg: SheetsConfig
  private readonly log: ChannelLogger
  private readonly workerUrl: URL

  private blockingPool: WorkerPool | null = null
  private backgroundPool: WorkerPool | null = null

  private readonly barrier = new Barrier()
  private readonly mutex = new Mutex()

  private started = false
  private starting: Promise<void> | null = null

  constructor(opts: { config: SheetsConfig; logger: ChannelLogger; workerUrl?: URL }) {
    this.cfg = opts.config
    this.log = opts.logger

    this.workerUrl = opts.workerUrl ?? SheetsHost.defaultWorkerUrl()
  }

  static defaultWorkerUrl(): URL {
    // Resolve worker module relative to this file at runtime
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)

    // core/sheets/sheets.host.ts -> core/sinks/sheets/worker/sheets.worker.js
    const workerPath = path.resolve(__dirname, '../sinks/sheets/worker/sheets.worker.js')
    return pathToFileURL(workerPath)
  }

  getConfig(): SheetsConfig {
    return this.cfg
  }

  isStarted(): boolean {
    return this.started
  }

  stats(): SheetsHostStats {
    return {
      pools: {
        blocking: this.blockingPool?.stats() ?? { size: 0, busy: 0, pending: 0 },
        background: this.backgroundPool?.stats() ?? { size: 0, busy: 0, pending: 0 },
      },
    }
  }

  /**
   * Initialize worker pools and apply auth strategy.
   *
   * Idempotent: safe to call multiple times.
   */
  async init(): Promise<void> {
    if (this.started) return
    if (this.starting) return await this.starting

    this.starting = (async () => {
      if (!this.cfg.enabled) {
        this.log.info('sheetsHost init skipped enabled=false')
        this.started = true
        return
      }

      // Start pools
      const blocking = new WorkerPool({
        name: 'sheets:blocking',
        size: this.cfg.workersBlocking,
        workerUrl: this.workerUrl,
        maxPending: this.cfg.maxPendingBlocking,
        timeoutMs: this.cfg.blockingTimeoutMs,
      })

      const background = new WorkerPool({
        name: 'sheets:background',
        size: this.cfg.workersBackground,
        workerUrl: this.workerUrl,
        maxPending: this.cfg.maxPendingBackground,
        timeoutMs: this.cfg.backgroundTimeoutMs,
      })

      await blocking.start()
      await background.start()

      // Broadcast init to all workers (so each worker caches config/creds once)
      await blocking.broadcast((taskId) => ({ kind: 'init', taskId, config: this.cfg }))
      await background.broadcast((taskId) => ({ kind: 'init', taskId, config: this.cfg }))

      this.blockingPool = blocking
      this.backgroundPool = background

      this.started = true

      this.log.info(
        `sheetsHost started lockMode=${this.cfg.lockMode} workersBlocking=${this.cfg.workersBlocking} workersBackground=${this.cfg.workersBackground} authStrategy=${this.cfg.auth.strategy} dryRun=${this.cfg.dryRun}`
      )

      // Auth strategy
      if (this.cfg.auth.strategy === 'warmup') {
        // fire-and-forget warmup (log any errors)
        void (async () => {
          try {
            const status = await this.authWarmup()
            this.log.info(
              `sheetsHost authWarmup status=${status.status}${status.status === 'ok' ? ` title=${status.spreadsheetTitle ?? 'unknown'}` : ''}`
            )
          } catch (err) {
            this.log.warn(
              `sheetsHost authWarmup failed err=${err instanceof Error ? err.message : String(err)}`
            )
          }
        })()
      }

      if (this.cfg.auth.strategy === 'strict') {
        const status = await this.authWarmup()
        if (status.status !== 'ok') {
          // strict => fail init
          throw new Error(
            `Sheets strict warmup failed status=${status.status} message=${status.status === 'error' ? status.error.message : 'unknown'}`
          )
        }
        this.log.info(
          `sheetsHost strict authWarmup ok title=${status.spreadsheetTitle ?? 'unknown'}`
        )
      }
    })()

    return await this.starting
  }

  async shutdown(): Promise<void> {
    if (!this.started) return

    const blocking = this.blockingPool
    const background = this.backgroundPool

    this.blockingPool = null
    this.backgroundPool = null
    this.started = false
    this.starting = null

    try {
      await background?.close()
    } catch {
      // ignore
    }
    try {
      await blocking?.close()
    } catch {
      // ignore
    }
  }

  private requirePools(): { blocking: WorkerPool; background: WorkerPool } {
    if (!this.blockingPool || !this.backgroundPool) {
      throw new Error('SheetsHost not initialized: pools are missing. Call init() first.')
    }
    return { blocking: this.blockingPool, background: this.backgroundPool }
  }

  async authWarmup(): Promise<AuthWarmupStatus> {
    await this.init()
    if (!this.cfg.enabled) return { status: 'never' }

    const { blocking } = this.requirePools()
    return await authWarmupPool(blocking)
  }

  async healthySnapshot(): Promise<{ blocking: WorkerHealth; background: WorkerHealth }> {
    await this.init()
    const { blocking, background } = this.requirePools()
    const [hb, hg] = await Promise.all([healthcheckPool(blocking), healthcheckPool(background)])
    return { blocking: hb, background: hg }
  }

  /**
   * Execute an arbitrary worker request under the configured lock mode.
   *
   * - background mode is used for non-critical tasks (read lookups, best-effort publishes).
   * - blocking mode is used for critical tasks that need barrier semantics.
   */
  async exec<T>(mode: SheetsExecMode, makeReq: (taskId: string) => SheetsWorkerRequest): Promise<T> {
    await this.init()
    if (!this.cfg.enabled) {
      throw new Error('SheetsHost exec called but SHEETS_ENABLED=false')
    }

    const { blocking, background } = this.requirePools()

    // serializeAll: everything goes through the mutex + blocking pool (1 thread recommended)
    if (this.cfg.lockMode === 'serializeAll') {
      return await this.mutex.runExclusive(async () => {
        return await blocking.exec<T>(makeReq)
      })
    }

    // none: no barrier/mutex
    if (this.cfg.lockMode === 'none') {
      const pool = mode === 'blocking' ? blocking : background
      return await pool.exec<T>(makeReq)
    }

    // exclusiveBarrier: background tasks wait for barrier; blocking tasks run exclusive after draining background
    if (mode === 'background') {
      await this.barrier.wait()
      return await background.exec<T>(makeReq)
    }

    // blocking
    await background.drain()
    return await this.barrier.runExclusive(async () => {
      return await blocking.exec<T>(makeReq)
    })
  }
}
