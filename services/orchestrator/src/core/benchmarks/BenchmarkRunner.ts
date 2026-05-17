// services/orchestrator/src/core/benchmarks/BenchmarkRunner.ts

import type {
  BenchmarkEventSink,
  BenchmarkFailure,
  BenchmarkFailureAction,
  BenchmarkKeyboardInputAdapter,
  BenchmarkRecipe,
  BenchmarkRunHandle,
  BenchmarkRunPhase,
  BenchmarkRunResult,
  BenchmarkScreenAnalysisAdapter,
  BenchmarkStep,
  BenchmarkStepRunResult,
} from './types.js'

type LoggerLike = {
  info(msg: string, extra?: Record<string, unknown>): void
  warn(msg: string, extra?: Record<string, unknown>): void
  error(msg: string, extra?: Record<string, unknown>): void
  debug(msg: string, extra?: Record<string, unknown>): void
}

const noopLogger: LoggerLike = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
}

const DEFAULT_STEP_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_DELAY_MS = 1_000

class BenchmarkCancelledError extends Error {
  public readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.name = 'BenchmarkCancelledError'
    this.reason = reason
  }
}

function now(): number {
  return Date.now()
}

function makeRunId(): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `bench-${Date.now().toString(36)}-${rand}`
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const delay = Math.max(0, Math.trunc(ms))
  if (delay <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(new BenchmarkCancelledError('cancelled'))

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, delay)

    const onAbort = () => {
      cleanup()
      reject(new BenchmarkCancelledError('cancelled'))
    }

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BenchmarkCancelledError('cancelled')
}

function failureFromError(err: unknown, opts?: { fatal?: boolean; retryable?: boolean; code?: string }): BenchmarkFailure {
  if (err instanceof BenchmarkCancelledError) {
    return {
      code: 'cancelled',
      message: err.reason,
      fatal: false,
      retryable: false,
    }
  }

  const message = err instanceof Error ? err.message : String(err)
  return {
    code: opts?.code ?? 'step-failed',
    message,
    fatal: opts?.fatal ?? true,
    retryable: opts?.retryable,
  }
}

function failureResult(opts: {
  runId: string
  recipeId: string
  step: BenchmarkStep
  stepIndex: number
  attempt: number
  startedAt: number
  failure: BenchmarkFailure
  status?: 'failed' | 'cancelled'
}): BenchmarkStepRunResult {
  const endedAt = now()
  return {
    runId: opts.runId,
    recipeId: opts.recipeId,
    stepId: opts.step.id,
    stepIndex: opts.stepIndex,
    stepType: opts.step.type,
    attempt: opts.attempt,
    status: opts.status ?? 'failed',
    startedAt: opts.startedAt,
    endedAt,
    durationMs: endedAt - opts.startedAt,
    failure: opts.failure,
  }
}

function successResult(opts: {
  runId: string
  recipeId: string
  step: BenchmarkStep
  stepIndex: number
  attempt: number
  startedAt: number
  output?: Record<string, unknown>
}): BenchmarkStepRunResult {
  const endedAt = now()
  return {
    runId: opts.runId,
    recipeId: opts.recipeId,
    stepId: opts.step.id,
    stepIndex: opts.stepIndex,
    stepType: opts.step.type,
    attempt: opts.attempt,
    status: 'success',
    startedAt: opts.startedAt,
    endedAt,
    durationMs: endedAt - opts.startedAt,
    ...(opts.output !== undefined ? { output: opts.output } : {}),
  }
}

function phaseForStep(step: BenchmarkStep): BenchmarkRunPhase {
  if (step.type === 'wait') return 'waiting'
  if (step.type.startsWith('keyboard.')) return 'sending-input'
  if (step.type.startsWith('screen.')) return 'watching-screen'
  return 'running'
}

function isActiveStatus(status: BenchmarkRunResult['status'] | undefined): boolean {
  return status === undefined
}

export class BenchmarkRunner {
  private readonly keyboard: BenchmarkKeyboardInputAdapter
  private readonly screen: BenchmarkScreenAnalysisAdapter
  private readonly events: BenchmarkEventSink
  private readonly log: LoggerLike

  private activeAbort: AbortController | null = null
  private activeDone: Promise<BenchmarkRunResult> | null = null
  private activeRunId: string | null = null

  constructor(opts: {
    keyboard: BenchmarkKeyboardInputAdapter
    screen: BenchmarkScreenAnalysisAdapter
    events: BenchmarkEventSink
    logger?: LoggerLike
  }) {
    this.keyboard = opts.keyboard
    this.screen = opts.screen
    this.events = opts.events
    this.log = opts.logger ?? noopLogger
  }

  isRunning(): boolean {
    return !!this.activeAbort && !this.activeAbort.signal.aborted && !!this.activeDone
  }

  start(recipe: BenchmarkRecipe): BenchmarkRunHandle {
    if (this.activeDone && this.activeRunId) {
      throw new Error(`benchmark run already active: ${this.activeRunId}`)
    }

    const runId = makeRunId()
    const abort = new AbortController()
    this.activeAbort = abort
    this.activeRunId = runId

    this.events.publish({
      kind: 'benchmark-run-loading',
      at: now(),
      runId,
      recipeId: recipe.id,
      recipeName: recipe.name,
    })

    const done = this.executeRun(runId, recipe, abort.signal)
      .catch((err: unknown) => {
        const startedAt = now()
        const failure = failureFromError(err, { fatal: true, retryable: false, code: 'runner-error' })
        const result: BenchmarkRunResult = {
          runId,
          recipeId: recipe.id,
          recipeName: recipe.name,
          status: 'failed',
          startedAt,
          endedAt: now(),
          durationMs: 0,
          completedSteps: 0,
          failedSteps: 1,
          failure,
        }
        this.events.publish({ kind: 'benchmark-run-failed', at: now(), result })
        return result
      })
      .finally(() => {
        if (this.activeRunId === runId) {
          this.activeAbort = null
          this.activeDone = null
          this.activeRunId = null
        }
      })

    this.activeDone = done
    return { runId, done }
  }

  cancel(reason = 'cancelled'): boolean {
    if (!this.activeAbort || !this.activeRunId) return false

    this.log.info(`kind=benchmark-cancel-requested runId=${this.activeRunId} reason=${JSON.stringify(reason)}`)
    try {
      this.keyboard.cancelAll?.(reason)
    } catch (err) {
      this.log.warn('keyboard cancelAll failed during benchmark cancellation', {
        err: err instanceof Error ? err.message : String(err),
      })
    }
    this.activeAbort.abort(reason)
    return true
  }

  private async executeRun(
    runId: string,
    recipe: BenchmarkRecipe,
    signal: AbortSignal
  ): Promise<BenchmarkRunResult> {
    const startedAt = now()
    let completedSteps = 0
    let failedSteps = 0

    this.events.publish({
      kind: 'benchmark-run-started',
      at: startedAt,
      runId,
      recipeId: recipe.id,
      recipeName: recipe.name,
      totalSteps: recipe.steps.length,
    })

    try {
      for (let i = 0; i < recipe.steps.length; i++) {
        assertNotAborted(signal)
        const step = recipe.steps[i]
        const outcome = await this.executeStepWithFailurePolicy(runId, recipe, step, i, signal)

        if (outcome.status === 'success') {
          completedSteps++
          continue
        }

        failedSteps++
        if (outcome.status === 'cancelled') {
          throw new BenchmarkCancelledError(outcome.failure?.message ?? 'cancelled')
        }

        const action = this.failureAction(recipe, step)
        if (action === 'continue') continue

        const result = this.buildRunResult({
          runId,
          recipe,
          startedAt,
          status: 'failed',
          completedSteps,
          failedSteps,
          failure: {
            ...(outcome.failure ?? failureFromError('step failed', { fatal: true })),
            fatal: true,
          },
        })
        this.events.publish({ kind: 'benchmark-run-failed', at: now(), result })
        return result
      }

      const result = this.buildRunResult({
        runId,
        recipe,
        startedAt,
        status: 'completed',
        completedSteps,
        failedSteps,
      })
      this.events.publish({ kind: 'benchmark-run-completed', at: now(), result })
      return result
    } catch (err) {
      if (err instanceof BenchmarkCancelledError || signal.aborted) {
        const reason = err instanceof BenchmarkCancelledError ? err.reason : String(signal.reason ?? 'cancelled')
        const result = this.buildRunResult({
          runId,
          recipe,
          startedAt,
          status: 'cancelled',
          completedSteps,
          failedSteps,
          failure: {
            code: 'cancelled',
            message: reason,
            fatal: false,
            retryable: false,
          },
        })
        this.events.publish({ kind: 'benchmark-run-cancelled', at: now(), result, reason })
        return result
      }

      const failure = failureFromError(err, { fatal: true, retryable: false, code: 'runner-error' })
      const result = this.buildRunResult({
        runId,
        recipe,
        startedAt,
        status: 'failed',
        completedSteps,
        failedSteps: Math.max(1, failedSteps),
        failure,
      })
      this.events.publish({ kind: 'benchmark-run-failed', at: now(), result })
      return result
    }
  }

  private async executeStepWithFailurePolicy(
    runId: string,
    recipe: BenchmarkRecipe,
    step: BenchmarkStep,
    stepIndex: number,
    signal: AbortSignal
  ): Promise<BenchmarkStepRunResult> {
    const action = this.failureAction(recipe, step)
    const maxAttempts = this.maxAttempts(recipe, step, action)
    const retryDelayMs = this.retryDelayMs(recipe, step)

    let lastResult: BenchmarkStepRunResult | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      assertNotAborted(signal)
      const startedAt = now()
      const phase = phaseForStep(step)

      this.events.publish({
        kind: 'benchmark-step-started',
        at: startedAt,
        runId,
        recipeId: recipe.id,
        stepId: step.id,
        stepIndex,
        stepType: step.type,
        attempt,
        phase,
      })

      try {
        const output = await this.executeStepBody(recipe, step, signal)
        const result = successResult({
          runId,
          recipeId: recipe.id,
          step,
          stepIndex,
          attempt,
          startedAt,
          output,
        })
        this.events.publish({ kind: 'benchmark-step-completed', at: now(), result })
        return result
      } catch (err) {
        const cancelled = err instanceof BenchmarkCancelledError || signal.aborted
        const failure = cancelled
          ? failureFromError(new BenchmarkCancelledError(String(signal.reason ?? 'cancelled')), {
              fatal: false,
              retryable: false,
              code: 'cancelled',
            })
          : failureFromError(err, {
              fatal: action === 'abort',
              retryable: action === 'retry' && attempt < maxAttempts,
            })

        const result = failureResult({
          runId,
          recipeId: recipe.id,
          step,
          stepIndex,
          attempt,
          startedAt,
          failure,
          status: cancelled ? 'cancelled' : 'failed',
        })
        const willRetry = !cancelled && action === 'retry' && attempt < maxAttempts
        this.events.publish({
          kind: 'benchmark-step-failed',
          at: now(),
          result,
          action,
          willRetry,
          ...(willRetry ? { nextAttempt: attempt + 1 } : {}),
        })

        lastResult = result

        if (cancelled) return result
        if (!willRetry) return result

        await sleep(retryDelayMs, signal)
      }
    }

    if (lastResult) return lastResult

    const startedAt = now()
    return failureResult({
      runId,
      recipeId: recipe.id,
      step,
      stepIndex,
      attempt: 1,
      startedAt,
      failure: {
        code: 'step-not-executed',
        message: 'step did not execute',
        fatal: true,
        retryable: false,
      },
    })
  }

  private async executeStepBody(
    recipe: BenchmarkRecipe,
    step: BenchmarkStep,
    signal: AbortSignal
  ): Promise<Record<string, unknown> | undefined> {
    assertNotAborted(signal)

    switch (step.type) {
      case 'wait': {
        await sleep(step.durationMs, signal)
        return { durationMs: step.durationMs }
      }

      case 'keyboard.typeText': {
        return this.withStepTimeout(
          () =>
            this.keyboard.typeText(step.text, {
              interKeyDelayMs: step.interKeyDelayMs,
              requestedBy: `benchmark:${recipe.id}:${step.id}`,
              signal,
            }),
          this.stepTimeoutMs(recipe, step),
          signal,
          () => this.keyboard.cancelAll?.(`benchmark-step-timeout:${step.id}`)
        )
      }

      case 'keyboard.key': {
        return this.withStepTimeout(
          () =>
            this.keyboard.pressKey(step.key, {
              action: step.action ?? 'press',
              requestedBy: `benchmark:${recipe.id}:${step.id}`,
              signal,
            }),
          this.stepTimeoutMs(recipe, step),
          signal,
          () => this.keyboard.cancelAll?.(`benchmark-step-timeout:${step.id}`)
        )
      }

      case 'keyboard.hotkey': {
        return this.withStepTimeout(
          () =>
            this.keyboard.hotkey(step.keys, {
              interKeyDelayMs: step.interKeyDelayMs,
              requestedBy: `benchmark:${recipe.id}:${step.id}`,
              signal,
            }),
          this.stepTimeoutMs(recipe, step),
          signal,
          () => this.keyboard.cancelAll?.(`benchmark-step-timeout:${step.id}`)
        )
      }

      case 'screen.waitForImageMatch': {
        const result = await this.screen.waitForImageMatch({
          referenceImage: step.referenceImage,
          threshold: step.threshold,
          timeoutMs: step.timeoutMs,
          pollIntervalMs: step.pollIntervalMs,
          signal,
        })
        if (!result.matched) {
          throw new Error(
            `screen image did not match reference=${step.referenceImage} threshold=${step.threshold} score=${result.score ?? 'none'}`
          )
        }
        return result as unknown as Record<string, unknown>
      }

      case 'screen.waitForStatic': {
        const result = await this.screen.waitForStatic({
          stableDurationMs: step.stableDurationMs,
          differenceThreshold: step.differenceThreshold,
          timeoutMs: step.timeoutMs,
          pollIntervalMs: step.pollIntervalMs,
          signal,
        })
        if (!result.becameStatic) {
          throw new Error(
            `screen did not become static stableDurationMs=${step.stableDurationMs} threshold=${step.differenceThreshold} lastDifference=${result.lastDifference ?? 'none'}`
          )
        }
        return result as unknown as Record<string, unknown>
      }
    }
  }

  private async withStepTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    signal: AbortSignal,
    onTimeout?: () => void
  ): Promise<T> {
    assertNotAborted(signal)

    let timeout: NodeJS.Timeout | null = null

    try {
      return await new Promise<T>((resolve, reject) => {
        let settled = false

        const finish = (cb: () => void) => {
          if (settled) return
          settled = true
          if (timeout) clearTimeout(timeout)
          signal.removeEventListener('abort', onAbort)
          cb()
        }

        const onAbort = () => {
          finish(() => reject(new BenchmarkCancelledError(String(signal.reason ?? 'cancelled'))))
        }

        timeout = setTimeout(() => {
          try {
            onTimeout?.()
          } catch {
            // ignore timeout cleanup failures
          }
          finish(() => reject(new Error(`step timed out after ${timeoutMs}ms`)))
        }, timeoutMs)

        signal.addEventListener('abort', onAbort, { once: true })

        fn()
          .then((value) => finish(() => resolve(value)))
          .catch((err) => finish(() => reject(err)))
      })
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private failureAction(recipe: BenchmarkRecipe, step: BenchmarkStep): BenchmarkFailureAction {
    return step.onFailure ?? recipe.defaults?.onFailure ?? 'abort'
  }

  private maxAttempts(
    recipe: BenchmarkRecipe,
    step: BenchmarkStep,
    action: BenchmarkFailureAction
  ): number {
    if (action !== 'retry') return 1
    return Math.max(1, Math.trunc(step.retry?.maxAttempts ?? recipe.defaults?.retry?.maxAttempts ?? 2))
  }

  private retryDelayMs(recipe: BenchmarkRecipe, step: BenchmarkStep): number {
    return Math.max(
      0,
      Math.trunc(step.retry?.delayMs ?? recipe.defaults?.retry?.delayMs ?? DEFAULT_RETRY_DELAY_MS)
    )
  }

  private stepTimeoutMs(recipe: BenchmarkRecipe, step: BenchmarkStep): number {
    return Math.max(1, Math.trunc(step.timeoutMs ?? recipe.defaults?.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS))
  }

  private buildRunResult(opts: {
    runId: string
    recipe: BenchmarkRecipe
    startedAt: number
    status: BenchmarkRunResult['status']
    completedSteps: number
    failedSteps: number
    failure?: BenchmarkFailure
  }): BenchmarkRunResult {
    const endedAt = now()
    return {
      runId: opts.runId,
      recipeId: opts.recipe.id,
      recipeName: opts.recipe.name,
      status: opts.status,
      startedAt: opts.startedAt,
      endedAt,
      durationMs: endedAt - opts.startedAt,
      completedSteps: opts.completedSteps,
      failedSteps: opts.failedSteps,
      ...(opts.failure !== undefined ? { failure: opts.failure } : {}),
    }
  }
}
