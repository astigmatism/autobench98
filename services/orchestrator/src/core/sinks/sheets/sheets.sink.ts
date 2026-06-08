// services/orchestrator/src/core/sinks/sheets/sheets.sink.ts
import type {
  ArtifactRefs,
  MetricMap,
  PublishMode,
  PublishReceipt,
  ResultSink,
  RunSummary,
} from '../result-sink.js'

import {
  buildSheetsConfigFromEnv,
  validateSheetsConfigForWrites,
  type SheetsConfig,
  type SheetsAuthStrategy,
} from './sheets.config.js'
import { buildEnvelopeFromInputs } from './sheets.envelope.js'
import type { PublishReceiptWorker } from './sheets.protocol.js'

import { SheetsHost } from '../../sheets/sheets.host.js'

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
 * SheetsSink
 *
 * ResultSink adapter that publishes benchmark results to Google Sheets.
 *
 * IMPORTANT: This sink does NOT talk to Google directly.
 * It delegates all work to SheetsHost worker threads.
 */
export class SheetsSink implements ResultSink {
  public readonly id = 'sheets'

  private readonly log: SheetsSinkLogger
  private cfg: SheetsConfig | null = null
  private readonly host: SheetsHost

  constructor(opts?: { logger?: SheetsSinkLogger; config?: SheetsConfig; host?: SheetsHost }) {
    this.log = opts?.logger ?? noopLog
    this.cfg = opts?.config ?? null

    // If no shared host is provided, create a private host (works, but duplicates workers).
    const cfg = this.cfg ?? buildSheetsConfigFromEnv()
    this.cfg = cfg
    this.host =
      opts?.host ??
      new SheetsHost({
        config: cfg,
        logger: (opts?.logger as any) ?? (noopLog as any),
      })
  }

  getConfig(): SheetsConfig | null {
    return this.cfg
  }

  async init(): Promise<void> {
    const cfg = this.cfg ?? buildSheetsConfigFromEnv()
    this.cfg = cfg

    if (!cfg.enabled) {
      this.log.info('kind=sheets-sink-disabled enabled=false')
      return
    }

    const authStrategy: SheetsAuthStrategy = cfg.auth.strategy

    // Validate config for non-dry-run writes.
    // If invalid:
    // - strict: fail init
    // - warmup/lazy: force dry-run (safety) and continue (read ops may still work)
    const v = validateSheetsConfigForWrites(cfg)
    if (!v.ok) {
      this.log.error(
        `kind=sheets-config-invalid-for-writes strategy=${authStrategy} errorsCount=${v.errors.length}`
      )
      for (let i = 0; i < v.errors.length; i++) {
        this.log.error(`kind=sheets-config-error idx=${i} msg=${JSON.stringify(v.errors[i])}`)
      }

      if (authStrategy === 'strict') {
        throw new Error('SheetsSink strict mode: invalid config for writes')
      }

      // Safety fallback: avoid unsafe/undefined writes
      cfg.dryRun = true
      this.log.warn('kind=sheets-config-forced-dry-run dryRun=true reason=invalid-config-for-writes')
    }

    await this.host.init()
  }

  async healthy(): Promise<boolean> {
    const cfg = this.cfg ?? buildSheetsConfigFromEnv()
    this.cfg = cfg
    if (!cfg.enabled) return true

    try {
      const snap = await this.host.healthySnapshot()
      const hb = snap.blocking
      if (hb.status !== 'ok') return false

      const auth = hb.details?.authWarmup
      if (cfg.auth.strategy === 'strict') return auth?.status === 'ok'
      if (cfg.auth.strategy === 'warmup') {
        if (auth && auth.status === 'error') return false
        return true
      }
      return true
    } catch {
      return false
    }
  }

  async publish(run: RunSummary, metrics: MetricMap, artifacts: ArtifactRefs): Promise<PublishReceipt> {
    const cfg = this.cfg ?? buildSheetsConfigFromEnv()
    this.cfg = cfg

    const mode: PublishMode = cfg.publish.defaultMode
    if (mode === 'blocking') return await this.publishBlocking(run, metrics, artifacts)
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
    const cfg = this.cfg ?? buildSheetsConfigFromEnv()
    this.cfg = cfg

    if (!cfg.enabled) {
      return {
        sinkId: this.id,
        runId: run.runId,
        publishedAt: new Date().toISOString(),
        ok: true,
        warnings: ['SheetsSink disabled; publish was a no-op'],
      }
    }

    // Ensure host is available (idempotent)
    await this.host.init()

    const envelope = buildEnvelopeFromInputs({
      schemaVersion: cfg.schema.version,
      run,
      metrics,
      artifacts,
    })

    const execMode = mode === 'blocking' ? 'blocking' : 'background'
    const receipt = await this.host.exec<PublishReceiptWorker>(execMode, (taskId) => ({
      kind: 'publishRun',
      taskId,
      envelope,
    }))

    return {
      sinkId: this.id,
      runId: run.runId,
      publishedAt: receipt.publishedAt,
      ok: receipt.ok,
      details: receipt.details,
      warnings: receipt.warnings,
    } satisfies PublishReceipt
  }

  async shutdown(): Promise<void> {
    await this.host.shutdown()
  }
}
