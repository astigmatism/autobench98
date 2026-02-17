// services/orchestrator/src/core/sinks/sink-manager.ts
import type {
  ArtifactRefs,
  MetricMap,
  PublishReceipt,
  ResultSink,
  RunSummary,
} from './result-sink.js'

export type LoggerLike = {
  info(msg: string, extra?: Record<string, unknown>): void
  warn(msg: string, extra?: Record<string, unknown>): void
  error(msg: string, extra?: Record<string, unknown>): void
}

const noopLogger: LoggerLike = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/**
 * SinkManager
 *
 * Responsibilities:
 * - Own a set of ResultSink implementations
 * - Initialize and shutdown sinks
 * - Publish results to all sinks (best-effort; one sink failing should not break others)
 *
 * Logging format convention:
 * - Message strings should be "key=value key=value" to match other subsystems.
 */
export class SinkManager {
  private readonly sinks: ResultSink[]
  private readonly log: LoggerLike

  constructor(opts: { sinks: ResultSink[]; logger?: LoggerLike }) {
    this.sinks = opts.sinks
    this.log = opts.logger ?? noopLogger
  }

  list(): string[] {
    return this.sinks.map((s) => s.id)
  }

  get(id: string): ResultSink | undefined {
    return this.sinks.find((s) => s.id === id)
  }

  async initAll(): Promise<void> {
    for (const sink of this.sinks) {
      try {
        this.log.info(`kind=sink-init-start id=${sink.id}`)
        await sink.init()
        this.log.info(`kind=sink-init-ok id=${sink.id}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Keep err as a single token (quoted) since it may contain spaces.
        this.log.error(`kind=sink-init-failed id=${sink.id} err=${JSON.stringify(msg)}`)
      }
    }
  }

  async shutdownAll(): Promise<void> {
    for (const sink of this.sinks) {
      if (!sink.shutdown) continue
      try {
        this.log.info(`kind=sink-shutdown-start id=${sink.id}`)
        await sink.shutdown()
        this.log.info(`kind=sink-shutdown-ok id=${sink.id}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.log.error(`kind=sink-shutdown-failed id=${sink.id} err=${JSON.stringify(msg)}`)
      }
    }
  }

  /**
   * Publish to all sinks. Never throws unless *all* sinks throw before returning.
   * In practice, each sink error is captured and returned as a failed receipt.
   */
  async publishAll(
    run: RunSummary,
    metrics: MetricMap,
    artifacts: ArtifactRefs
  ): Promise<PublishReceipt[]> {
    const receipts: PublishReceipt[] = []

    for (const sink of this.sinks) {
      try {
        const res = await sink.publish(run, metrics, artifacts)
        if (res) receipts.push(res)
        else {
          receipts.push({
            sinkId: sink.id,
            runId: run.runId,
            publishedAt: new Date().toISOString(),
            ok: true,
            warnings: ['sink did not return a receipt (scaffold default)'],
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.log.error(
          `kind=sink-publish-failed id=${sink.id} runId=${run.runId} err=${JSON.stringify(msg)}`
        )
        receipts.push({
          sinkId: sink.id,
          runId: run.runId,
          publishedAt: new Date().toISOString(),
          ok: false,
          details: { error: msg },
        })
      }
    }

    return receipts
  }

  async healthySnapshot(): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {}
    for (const sink of this.sinks) {
      try {
        out[sink.id] = await sink.healthy()
      } catch {
        out[sink.id] = false
      }
    }
    return out
  }
}
