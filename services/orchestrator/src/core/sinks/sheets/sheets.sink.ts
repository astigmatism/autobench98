import type {
  ArtifactRefs,
  MetricMap,
  PublishMode,
  PublishReceipt,
  ResultSink,
  RunSummary,
} from '../result-sink.js'

import { buildSheetsConfigFromEnv, validateSheetsConfigForWrites, type SheetsConfig } from './sheets.config.js'
import { buildEnvelopeFromInputs } from './sheets.envelope.js'
import { Barrier, Mutex } from './sheets.lock.js'
import { WorkerPool, healthcheckPool, publishRunInPool } from './sheets.worker-pool.js'

export type SheetsSinkLogger = {
  debug(msg: string, extra?: Record<string, unknown>): void
  info(msg: string, extra?: Record<string, unknown>): void
  warn(msg: string, extra?: Record<string, unknown>): void
  error(msg: string, extra?: Record<string, unknown>): void
}

const noopLog: SheetsSinkLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/**
 * SheetsSink (scaffold)
 *
 * - All Google Sheets I/O must occur in worker threads.
 * - Supports two pools: blocking + background.
 * - Supports a "barrier" mode that drains background work, then runs blocking publishes exclusively.
 */
export class SheetsSink implements ResultSink {
  public readonly id = 'sheets'

  private readonly log: SheetsSinkLogger
  private cfg: SheetsConfig | null = null

  private blockingPool: WorkerPool | null = null
  private backgroundPool: WorkerPool | null = null

  private readonly barrier = new Barrier()
  private readonly blockingMutex = new Mutex()

  constructor(opts?: { logger?: SheetsSinkLogger; config?: SheetsConfig }) {
    this.log = opts?.logger ?? noopLog
    this.cfg = opts?.config ?? null
  }

  getConfig(): SheetsConfig | null {
    return this.cfg
  }

  async init(): Promise<void> {
    const cfg = this.cfg ?? buildSheetsConfigFromEnv()
    this.cfg = cfg

    if (!cfg.enabled) {
      this.log.info('SheetsSink disabled (SHEETS_ENABLED=false)')
      return
    }

    const v = validateSheetsConfigForWrites(cfg)
    if (!v.ok) {
      // Safety gate: refuse to start in write mode when required config is missing.
      // Dry-run still allowed.
      this.log.error('SheetsSink config invalid for writes', { errors: v.errors })
      // Keep running, but in dry-run to avoid unsafe/undefined behavior.
      cfg.dryRun = true
      this.log.warn('Forcing SHEETS_DRY_RUN=true due to invalid config for writes')
    }

    // Worker entrypoint (compiled .js under NodeNext)
    const workerUrl = new URL('./worker/sheets.worker.js', import.meta.url)

    this.blockingPool = new WorkerPool({
      name: 'sheets:blocking',
      size: cfg.workersBlocking,
      workerUrl,
      maxPending: cfg.maxPendingBlocking,
      timeoutMs: cfg.blockingTimeoutMs,
    })

    // serializeAll routes background work through blocking pool
    const bgSize = cfg.lockMode === 'serializeAll' ? 0 : cfg.workersBackground
    this.backgroundPool = new WorkerPool({
      name: 'sheets:background',
      size: bgSize,
      workerUrl,
      maxPending: cfg.maxPendingBackground,
      timeoutMs: cfg.backgroundTimeoutMs,
    })

    await this.blockingPool.start()
    await this.backgroundPool.start()

    // Initialize workers with config (including auth).
    // NOTE: This may include secrets; worker must not log these.
    await this.initWorkers(cfg)

    this.log.info('SheetsSink initialized', {
      dryRun: cfg.dryRun,
      lockMode: cfg.lockMode,
      workersBlocking: cfg.workersBlocking,
      workersBackground: bgSize,
    })
  }

  private async initWorkers(cfg: SheetsConfig): Promise<void> {
  if (!this.blockingPool) throw new Error('Blocking pool not created')

  // SAFETY: each worker thread must receive init/config before it can handle publish requests.
  await this.blockingPool.broadcast((taskId) => ({ kind: 'init', taskId, config: cfg }))

  if (this.backgroundPool && this.backgroundPool.stats().size > 0) {
    await this.backgroundPool.broadcast((taskId) => ({ kind: 'init', taskId, config: cfg }))
  }
}

  async healthy(): Promise<boolean> {
    const cfg = this.cfg
    if (!cfg || !cfg.enabled) return true

    const pool = this.blockingPool
    if (!pool) return false

    try {
      const res = await healthcheckPool(pool)
      return res.status === 'ok'
    } catch {
      return false
    }
  }

  /**
   * Default publish behavior required by ResultSink.
   *
   * Use SHEETS_DEFAULT_PUBLISH_MODE to choose blocking vs background.
   * For explicit workflow barriers, call publishBlocking(...) directly.
   */
  async publish(run: RunSummary, metrics: MetricMap, artifacts: ArtifactRefs): Promise<PublishReceipt> {
    const cfg = this.cfg ?? buildSheetsConfigFromEnv()
    this.cfg = cfg

    const mode: PublishMode = cfg.publish.defaultMode
    if (mode === 'blocking') {
      return await this.publishBlocking(run, metrics, artifacts)
    }
    return await this.publishBackground(run, metrics, artifacts)
  }

  async publishBlocking(run: RunSummary, metrics: MetricMap, artifacts: ArtifactRefs): Promise<PublishReceipt> {
    return await this.publishWithMode('blocking', run, metrics, artifacts)
  }

  async publishBackground(run: RunSummary, metrics: MetricMap, artifacts: ArtifactRefs): Promise<PublishReceipt> {
    return await this.publishWithMode('background', run, metrics, artifacts)
  }

  private async publishWithMode(
    mode: PublishMode,
    run: RunSummary,
    metrics: MetricMap,
    artifacts: ArtifactRefs
  ): Promise<PublishReceipt> {
    const cfg = this.cfg
    if (!cfg || !cfg.enabled) {
      return {
        sinkId: this.id,
        runId: run.runId,
        publishedAt: new Date().toISOString(),
        ok: true,
        warnings: ['SheetsSink disabled; publish was a no-op'],
      }
    }

    const envelope = buildEnvelopeFromInputs({
      schemaVersion: cfg.schema.version,
      run,
      metrics,
      artifacts,
    })

    const blockingPool = this.blockingPool
    if (!blockingPool) throw new Error('SheetsSink not initialized (blocking pool missing)')

    const backgroundPool = this.backgroundPool

    const doPublish = async () => {
      const receipt = await publishRunInPool(
        // In serializeAll, background pool is size 0 -> always use blocking pool
        mode === 'background' && cfg.lockMode !== 'serializeAll' && backgroundPool ? backgroundPool : blockingPool,
        envelope
      )

      return {
        sinkId: this.id,
        runId: run.runId,
        publishedAt: receipt.publishedAt,
        ok: receipt.ok,
        details: receipt.details,
        warnings: receipt.warnings,
      } satisfies PublishReceipt
    }

    if (cfg.lockMode === 'none') {
      return await doPublish()
    }

    if (cfg.lockMode === 'serializeAll') {
      // All tasks run on blocking pool, but still allow parallelism if workersBlocking > 1.
      return await this.blockingMutex.runExclusive(doPublish)
    }

    // exclusiveBarrier:
    // - blocking publishes wait for background to drain, then run exclusively
    // - background publishes wait while barrier active
    if (mode === 'background') {
      await this.barrier.waitIfActive()
      return await doPublish()
    }

    // blocking
    return await this.blockingMutex.runExclusive(async () => {
      // ensure no background work is running before barrier activates
      if (backgroundPool) await backgroundPool.drain()
      this.barrier.activate()
      try {
        return await doPublish()
      } finally {
        this.barrier.deactivate()
      }
    })
  }

  async shutdown(): Promise<void> {
    if (this.backgroundPool) await this.backgroundPool.close()
    if (this.blockingPool) await this.blockingPool.close()
    this.backgroundPool = null
    this.blockingPool = null
  }
}
