// services/orchestrator/src/plugins/benchmarks.ts

import fp from 'fastify-plugin'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import path from 'node:path'

import { createLogger, LogChannel, type ClientLogBuffer } from '@autobench98/logging'

import { BenchmarkRunner } from '../core/benchmarks/BenchmarkRunner.js'
import { PS2KeyboardBenchmarkInputAdapter } from '../core/benchmarks/keyboard-input.adapter.js'
import { SidecarScreenAnalysisAdapter } from '../core/benchmarks/screen-analysis.adapter.js'
import { validateBenchmarkRecipe } from '../core/benchmarks/recipe-validator.js'
import type { BenchmarkEventSink, BenchmarkRunnerEvent } from '../core/benchmarks/types.js'
import { BenchmarkRunnerStateAdapter } from '../adapters/benchmarkRunner.adapter.js'
import { peekSlice, setBenchmarkRunnerSnapshot } from '../core/state.js'

declare module 'fastify' {
  interface FastifyInstance {
    benchmarkRunner?: BenchmarkRunner
    clientBuf: ClientLogBuffer
  }
}

class FanoutBenchmarkEventSink implements BenchmarkEventSink {
  private readonly sinks: BenchmarkEventSink[]

  constructor(...sinks: BenchmarkEventSink[]) {
    this.sinks = sinks
  }

  publish(evt: BenchmarkRunnerEvent): void {
    for (const sink of this.sinks) {
      try {
        sink.publish(evt)
      } catch {
        // Event observers must not break the benchmark runner.
      }
    }
  }
}

class BenchmarkLoggerEventSink implements BenchmarkEventSink {
  private readonly log: ReturnType<ReturnType<typeof createLogger>['channel']>

  constructor(app: FastifyInstance) {
    const { channel } = createLogger('benchmark-runner', app.clientBuf)
    this.log = channel(LogChannel.benchmark)
  }

  publish(evt: BenchmarkRunnerEvent): void {
    switch (evt.kind) {
      case 'benchmark-run-loading': {
        this.log.info(`kind=${evt.kind} runId=${evt.runId} recipeId=${evt.recipeId}`)
        break
      }
      case 'benchmark-run-started': {
        this.log.info(
          `kind=${evt.kind} runId=${evt.runId} recipeId=${evt.recipeId} steps=${evt.totalSteps}`
        )
        break
      }
      case 'benchmark-run-phase-changed': {
        this.log.debug(`kind=${evt.kind} runId=${evt.runId} phase=${evt.phase}`)
        break
      }
      case 'benchmark-step-started': {
        this.log.info(
          `kind=${evt.kind} runId=${evt.runId} stepId=${evt.stepId} type=${evt.stepType} attempt=${evt.attempt}`
        )
        break
      }
      case 'benchmark-step-completed': {
        this.log.info(
          `kind=${evt.kind} runId=${evt.result.runId} stepId=${evt.result.stepId} durationMs=${evt.result.durationMs}`
        )
        break
      }
      case 'benchmark-step-failed': {
        this.log.warn(
          `kind=${evt.kind} runId=${evt.result.runId} stepId=${evt.result.stepId} action=${evt.action} willRetry=${evt.willRetry ? 'true' : 'false'} err=${JSON.stringify(evt.result.failure?.message ?? 'unknown')}`
        )
        break
      }
      case 'benchmark-run-completed': {
        this.log.info(
          `kind=${evt.kind} runId=${evt.result.runId} durationMs=${evt.result.durationMs} completedSteps=${evt.result.completedSteps}`
        )
        break
      }
      case 'benchmark-run-failed': {
        this.log.error(
          `kind=${evt.kind} runId=${evt.result.runId} err=${JSON.stringify(evt.result.failure?.message ?? 'unknown')}`
        )
        break
      }
      case 'benchmark-run-cancelled': {
        this.log.warn(
          `kind=${evt.kind} runId=${evt.result.runId} reason=${JSON.stringify(evt.reason)}`
        )
        break
      }
    }
  }
}

function extractRecipeBody(body: unknown): unknown {
  if (body && typeof body === 'object' && !Array.isArray(body) && 'recipe' in body) {
    return (body as { recipe?: unknown }).recipe
  }
  return body
}

const benchmarksPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  const { channel } = createLogger('benchmarks-plugin', app.clientBuf)
  const log = channel(LogChannel.app)

  const dataDir = String(process.env.DATA_DIR || '/app/data')
  const assetRoot = String(process.env.BENCHMARK_ASSET_ROOT || path.join(dataDir, 'benchmark-assets'))
  const sidecarPort = Number.isFinite(Number(process.env.SIDECAR_PORT))
    ? Number(process.env.SIDECAR_PORT)
    : 3100
  const sidecarBaseUrl = String(process.env.BENCHMARK_SIDECAR_BASE_URL || `http://127.0.0.1:${sidecarPort}`)

  const stateAdapter = new BenchmarkRunnerStateAdapter()
  const events = new FanoutBenchmarkEventSink(new BenchmarkLoggerEventSink(app), {
    publish(evt: BenchmarkRunnerEvent): void {
      stateAdapter.handle(evt)
      setBenchmarkRunnerSnapshot(stateAdapter.getState())
    },
  })

  const keyboard = new PS2KeyboardBenchmarkInputAdapter({
    getKeyboard: () => (app as any).ps2Keyboard,
    logger: log,
  })

  const screen = new SidecarScreenAnalysisAdapter({
    baseUrl: sidecarBaseUrl,
    assetRoot,
    logger: log,
  })

  const runner = new BenchmarkRunner({
    keyboard,
    screen,
    events,
    logger: log,
  })

  app.decorate('benchmarkRunner', runner)

  log.info(
    `benchmark runner scaffold configured assetRoot=${JSON.stringify(assetRoot)} sidecarBaseUrl=${JSON.stringify(sidecarBaseUrl)}`
  )

  app.post('/api/benchmarks/validate', async (req, reply) => {
    const recipeInput = extractRecipeBody(req.body)
    const validation = validateBenchmarkRecipe(recipeInput)
    if (!validation.ok) {
      reply.code(400)
      return { ok: false, errors: validation.errors }
    }
    return { ok: true, recipe: validation.recipe }
  })

  app.post('/api/benchmarks/runs', async (req, reply) => {
    const recipeInput = extractRecipeBody(req.body)
    const validation = validateBenchmarkRecipe(recipeInput)
    if (!validation.ok) {
      reply.code(400)
      return { ok: false, errors: validation.errors }
    }

    try {
      const handle = runner.start(validation.recipe)
      // Keep the HTTP request short. Live state flows through AppState/WS and GET current.
      handle.done.catch((err: unknown) => {
        log.error('benchmark runner done promise rejected unexpectedly', {
          err: err instanceof Error ? err.message : String(err),
        })
      })
      return {
        ok: true,
        runId: handle.runId,
        state: peekSlice('benchmarkRunner'),
      }
    } catch (err) {
      reply.code(409)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  app.get('/api/benchmarks/runs/current', async () => {
    return { ok: true, state: peekSlice('benchmarkRunner') }
  })

  app.post('/api/benchmarks/runs/current/cancel', async (req, reply) => {
    const body = (req.body ?? {}) as { reason?: string }
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'cancelled'
    const cancelled = runner.cancel(reason)
    if (!cancelled) {
      reply.code(409)
      return { ok: false, error: 'no benchmark run is active' }
    }
    return { ok: true, state: peekSlice('benchmarkRunner') }
  })

  app.addHook('onClose', async () => {
    runner.cancel('orchestrator-shutdown')
  })
}

export default fp(benchmarksPlugin, {
  name: 'benchmarks-plugin',
})
