// services/orchestrator/src/core/benchmarks/types.ts

export const BENCHMARK_RECIPE_SCHEMA_VERSION = 1 as const

export type BenchmarkRecipeSchemaVersion = typeof BENCHMARK_RECIPE_SCHEMA_VERSION

export type BenchmarkFailureAction = 'abort' | 'continue' | 'retry'

export type BenchmarkRunPhase =
  | 'idle'
  | 'loading-recipe'
  | 'running'
  | 'waiting'
  | 'watching-screen'
  | 'sending-input'
  | 'step-succeeded'
  | 'step-failed'
  | 'run-failed'
  | 'run-completed'
  | 'cancelled'

export type BenchmarkStepType =
  | 'wait'
  | 'keyboard.typeText'
  | 'keyboard.key'
  | 'keyboard.hotkey'
  | 'screen.waitForImageMatch'
  | 'screen.waitForStatic'

export type BenchmarkRetryPolicy = {
  /** Total attempts for this step, including the first attempt. */
  maxAttempts: number
  /** Delay before the next attempt. */
  delayMs?: number
}

export type BenchmarkRecipeDefaults = {
  stepTimeoutMs?: number
  onFailure?: BenchmarkFailureAction
  retry?: BenchmarkRetryPolicy
}

export type BenchmarkBaseStep = {
  id: string
  type: BenchmarkStepType
  timeoutMs?: number
  onFailure?: BenchmarkFailureAction
  retry?: BenchmarkRetryPolicy
  metadata?: Record<string, unknown>
}

export type BenchmarkWaitStep = BenchmarkBaseStep & {
  type: 'wait'
  durationMs: number
}

export type BenchmarkKeyboardTypeTextStep = BenchmarkBaseStep & {
  type: 'keyboard.typeText'
  text: string
  interKeyDelayMs?: number
}

export type BenchmarkKeyboardKeyStep = BenchmarkBaseStep & {
  type: 'keyboard.key'
  key: string
  action?: 'press' | 'hold' | 'release'
}

export type BenchmarkKeyboardHotkeyStep = BenchmarkBaseStep & {
  type: 'keyboard.hotkey'
  keys: string[]
  interKeyDelayMs?: number
}

export type BenchmarkScreenWaitForImageMatchStep = BenchmarkBaseStep & {
  type: 'screen.waitForImageMatch'
  referenceImage: string
  threshold: number
  timeoutMs: number
  pollIntervalMs?: number
}

export type BenchmarkScreenWaitForStaticStep = BenchmarkBaseStep & {
  type: 'screen.waitForStatic'
  stableDurationMs: number
  differenceThreshold: number
  timeoutMs: number
  pollIntervalMs?: number
}

export type BenchmarkStep =
  | BenchmarkWaitStep
  | BenchmarkKeyboardTypeTextStep
  | BenchmarkKeyboardKeyStep
  | BenchmarkKeyboardHotkeyStep
  | BenchmarkScreenWaitForImageMatchStep
  | BenchmarkScreenWaitForStaticStep

export type BenchmarkRecipe = {
  schemaVersion: BenchmarkRecipeSchemaVersion
  id: string
  name: string
  description?: string
  defaults?: BenchmarkRecipeDefaults
  metadata?: Record<string, unknown>
  steps: BenchmarkStep[]
}

export type BenchmarkValidationOk = {
  ok: true
  recipe: BenchmarkRecipe
}

export type BenchmarkValidationFailed = {
  ok: false
  errors: string[]
}

export type BenchmarkValidationResult = BenchmarkValidationOk | BenchmarkValidationFailed

export type BenchmarkFailure = {
  code: string
  message: string
  fatal: boolean
  retryable?: boolean
  detail?: Record<string, unknown>
}

export type BenchmarkStepRunStatus = 'success' | 'failed' | 'cancelled'

export type BenchmarkStepRunResult = {
  runId: string
  recipeId: string
  stepId: string
  stepIndex: number
  stepType: BenchmarkStepType
  attempt: number
  status: BenchmarkStepRunStatus
  startedAt: number
  endedAt: number
  durationMs: number
  output?: Record<string, unknown>
  failure?: BenchmarkFailure
}

export type BenchmarkRunResult = {
  runId: string
  recipeId: string
  recipeName: string
  status: 'completed' | 'failed' | 'cancelled'
  startedAt: number
  endedAt: number
  durationMs: number
  completedSteps: number
  failedSteps: number
  failure?: BenchmarkFailure
}

export type BenchmarkRunnerStateEvent = {
  at: number
  kind: BenchmarkRunnerEvent['kind']
  runId?: string
  stepId?: string
  message?: string
}

export type BenchmarkRunnerSnapshot = {
  phase: BenchmarkRunPhase
  runId: string | null
  recipeId: string | null
  recipeName: string | null
  startedAt: number | null
  endedAt: number | null
  currentStep: {
    id: string
    index: number
    type: BenchmarkStepType
    attempt: number
  } | null
  lastStepResult: BenchmarkStepRunResult | null
  lastError: BenchmarkFailure | null
  totals: {
    steps: number
    completed: number
    failed: number
    retries: number
  }
  cancellationRequested: boolean
  events: BenchmarkRunnerStateEvent[]
  updatedAt: number
}

export type ScreenFrame = {
  buffer: Buffer
  contentType: string
  capturedAt: number
  ageMs?: number
}

export type ScreenMatchResult = {
  matched: boolean
  score: number | null
  threshold: number
  referenceImage: string
  method: string
  attempts: number
  elapsedMs: number
}

export type StaticScreenResult = {
  becameStatic: boolean
  stableDurationMs: number
  observedStableMs: number
  differenceThreshold: number
  lastDifference: number | null
  method: string
  attempts: number
  elapsedMs: number
}

export type BenchmarkKeyboardInputAdapter = {
  typeText(text: string, opts?: {
    interKeyDelayMs?: number
    requestedBy?: string
    signal?: AbortSignal
  }): Promise<Record<string, unknown>>

  pressKey(key: string, opts?: {
    action?: 'press' | 'hold' | 'release'
    requestedBy?: string
    signal?: AbortSignal
  }): Promise<Record<string, unknown>>

  hotkey(keys: string[], opts?: {
    interKeyDelayMs?: number
    requestedBy?: string
    signal?: AbortSignal
  }): Promise<Record<string, unknown>>

  cancelAll?(reason?: string): void
}

export type BenchmarkScreenAnalysisAdapter = {
  captureFrame(signal?: AbortSignal): Promise<ScreenFrame>

  waitForImageMatch(opts: {
    referenceImage: string
    threshold: number
    timeoutMs: number
    pollIntervalMs?: number
    signal?: AbortSignal
  }): Promise<ScreenMatchResult>

  waitForStatic(opts: {
    stableDurationMs: number
    differenceThreshold: number
    timeoutMs: number
    pollIntervalMs?: number
    signal?: AbortSignal
  }): Promise<StaticScreenResult>
}

export type BenchmarkRunnerEvent =
  | {
      kind: 'benchmark-run-loading'
      at: number
      runId: string
      recipeId: string
      recipeName: string
    }
  | {
      kind: 'benchmark-run-started'
      at: number
      runId: string
      recipeId: string
      recipeName: string
      totalSteps: number
    }
  | {
      kind: 'benchmark-run-phase-changed'
      at: number
      runId: string
      phase: BenchmarkRunPhase
    }
  | {
      kind: 'benchmark-step-started'
      at: number
      runId: string
      recipeId: string
      stepId: string
      stepIndex: number
      stepType: BenchmarkStepType
      attempt: number
      phase: BenchmarkRunPhase
    }
  | {
      kind: 'benchmark-step-completed'
      at: number
      result: BenchmarkStepRunResult
    }
  | {
      kind: 'benchmark-step-failed'
      at: number
      result: BenchmarkStepRunResult
      action: BenchmarkFailureAction
      willRetry: boolean
      nextAttempt?: number
    }
  | {
      kind: 'benchmark-run-completed'
      at: number
      result: BenchmarkRunResult
    }
  | {
      kind: 'benchmark-run-failed'
      at: number
      result: BenchmarkRunResult
    }
  | {
      kind: 'benchmark-run-cancelled'
      at: number
      result: BenchmarkRunResult
      reason: string
    }

export type BenchmarkEventSink = {
  publish(evt: BenchmarkRunnerEvent): void
}

export type BenchmarkRunHandle = {
  runId: string
  done: Promise<BenchmarkRunResult>
}

export function createIdleBenchmarkRunnerSnapshot(now = Date.now()): BenchmarkRunnerSnapshot {
  return {
    phase: 'idle',
    runId: null,
    recipeId: null,
    recipeName: null,
    startedAt: null,
    endedAt: null,
    currentStep: null,
    lastStepResult: null,
    lastError: null,
    totals: {
      steps: 0,
      completed: 0,
      failed: 0,
      retries: 0,
    },
    cancellationRequested: false,
    events: [],
    updatedAt: now,
  }
}
