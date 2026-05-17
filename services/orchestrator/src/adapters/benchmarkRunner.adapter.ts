// services/orchestrator/src/adapters/benchmarkRunner.adapter.ts

import {
  createIdleBenchmarkRunnerSnapshot,
  type BenchmarkFailure,
  type BenchmarkRunnerEvent,
  type BenchmarkRunnerSnapshot,
  type BenchmarkRunnerStateEvent,
} from '../core/benchmarks/types.js'

const MAX_EVENT_HISTORY = 100

function eventMessage(evt: BenchmarkRunnerEvent): string | undefined {
  switch (evt.kind) {
    case 'benchmark-run-loading':
      return `loading recipe ${evt.recipeId}`
    case 'benchmark-run-started':
      return `started recipe ${evt.recipeId}`
    case 'benchmark-run-phase-changed':
      return `phase ${evt.phase}`
    case 'benchmark-step-started':
      return `step ${evt.stepId} attempt ${evt.attempt} started`
    case 'benchmark-step-completed':
      return `step ${evt.result.stepId} completed`
    case 'benchmark-step-failed':
      return `step ${evt.result.stepId} failed action=${evt.action} retry=${evt.willRetry ? 'true' : 'false'}`
    case 'benchmark-run-completed':
      return 'run completed'
    case 'benchmark-run-failed':
      return evt.result.failure?.message ?? 'run failed'
    case 'benchmark-run-cancelled':
      return `run cancelled: ${evt.reason}`
  }
}

function compactEvent(evt: BenchmarkRunnerEvent): BenchmarkRunnerStateEvent {
  const runId =
    'runId' in evt
      ? evt.runId
      : 'result' in evt
        ? evt.result.runId
        : undefined

  const stepId =
    evt.kind === 'benchmark-step-started'
      ? evt.stepId
      : (evt.kind === 'benchmark-step-completed' || evt.kind === 'benchmark-step-failed')
        ? evt.result.stepId
        : undefined

  return {
    at: evt.at,
    kind: evt.kind,
    ...(runId !== undefined ? { runId } : {}),
    ...(stepId !== undefined ? { stepId } : {}),
    ...(eventMessage(evt) !== undefined ? { message: eventMessage(evt) } : {}),
  }
}

function failureFromEvent(evt: BenchmarkRunnerEvent): BenchmarkFailure | null {
  if (evt.kind === 'benchmark-step-failed') return evt.result.failure ?? null
  if (evt.kind === 'benchmark-run-failed') return evt.result.failure ?? null
  if (evt.kind === 'benchmark-run-cancelled') return evt.result.failure ?? null
  return null
}

export class BenchmarkRunnerStateAdapter {
  private state: BenchmarkRunnerSnapshot

  constructor() {
    this.state = createIdleBenchmarkRunnerSnapshot()
  }

  handle(evt: BenchmarkRunnerEvent): void {
    const at = evt.at ?? Date.now()

    switch (evt.kind) {
      case 'benchmark-run-loading': {
        this.state = {
          ...createIdleBenchmarkRunnerSnapshot(at),
          phase: 'loading-recipe',
          runId: evt.runId,
          recipeId: evt.recipeId,
          recipeName: evt.recipeName,
          updatedAt: at,
        }
        break
      }

      case 'benchmark-run-started': {
        this.state = {
          ...this.state,
          phase: 'running',
          runId: evt.runId,
          recipeId: evt.recipeId,
          recipeName: evt.recipeName,
          startedAt: evt.at,
          endedAt: null,
          currentStep: null,
          lastStepResult: null,
          lastError: null,
          totals: {
            steps: evt.totalSteps,
            completed: 0,
            failed: 0,
            retries: 0,
          },
          cancellationRequested: false,
          updatedAt: at,
        }
        break
      }

      case 'benchmark-run-phase-changed': {
        this.state = {
          ...this.state,
          phase: evt.phase,
          updatedAt: at,
        }
        break
      }

      case 'benchmark-step-started': {
        this.state = {
          ...this.state,
          phase: evt.phase,
          currentStep: {
            id: evt.stepId,
            index: evt.stepIndex,
            type: evt.stepType,
            attempt: evt.attempt,
          },
          updatedAt: at,
        }
        break
      }

      case 'benchmark-step-completed': {
        this.state = {
          ...this.state,
          phase: 'step-succeeded',
          currentStep: null,
          lastStepResult: evt.result,
          totals: {
            ...this.state.totals,
            completed: this.state.totals.completed + 1,
          },
          updatedAt: at,
        }
        break
      }

      case 'benchmark-step-failed': {
        this.state = {
          ...this.state,
          phase: 'step-failed',
          currentStep: null,
          lastStepResult: evt.result,
          lastError: evt.result.failure ?? this.state.lastError,
          totals: {
            ...this.state.totals,
            failed: this.state.totals.failed + 1,
            retries: this.state.totals.retries + (evt.willRetry ? 1 : 0),
          },
          updatedAt: at,
        }
        break
      }

      case 'benchmark-run-completed': {
        this.state = {
          ...this.state,
          phase: 'run-completed',
          currentStep: null,
          endedAt: evt.result.endedAt,
          cancellationRequested: false,
          updatedAt: at,
        }
        break
      }

      case 'benchmark-run-failed': {
        this.state = {
          ...this.state,
          phase: 'run-failed',
          currentStep: null,
          endedAt: evt.result.endedAt,
          lastError: evt.result.failure ?? this.state.lastError,
          cancellationRequested: false,
          updatedAt: at,
        }
        break
      }

      case 'benchmark-run-cancelled': {
        this.state = {
          ...this.state,
          phase: 'cancelled',
          currentStep: null,
          endedAt: evt.result.endedAt,
          lastError: evt.result.failure ?? this.state.lastError,
          cancellationRequested: false,
          updatedAt: at,
        }
        break
      }
    }

    const failure = failureFromEvent(evt)
    if (failure) this.state.lastError = failure
    this.pushEvent(evt)
  }

  getState(): BenchmarkRunnerSnapshot {
    return JSON.parse(JSON.stringify(this.state)) as BenchmarkRunnerSnapshot
  }

  private pushEvent(evt: BenchmarkRunnerEvent): void {
    const events = [compactEvent(evt), ...this.state.events]
    if (events.length > MAX_EVENT_HISTORY) events.length = MAX_EVENT_HISTORY
    this.state = {
      ...this.state,
      events,
      updatedAt: evt.at ?? Date.now(),
    }
  }
}
