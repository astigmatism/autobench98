// services/orchestrator/src/core/benchmarks/recipe-validator.ts

import {
  BENCHMARK_RECIPE_SCHEMA_VERSION,
  type BenchmarkFailureAction,
  type BenchmarkRecipe,
  type BenchmarkRecipeDefaults,
  type BenchmarkRetryPolicy,
  type BenchmarkStep,
  type BenchmarkStepType,
  type BenchmarkValidationResult,
} from './types.js'

const STEP_TYPES: BenchmarkStepType[] = [
  'wait',
  'keyboard.typeText',
  'keyboard.key',
  'keyboard.hotkey',
  'screen.waitForImageMatch',
  'screen.waitForStatic',
]

const FAILURE_ACTIONS: BenchmarkFailureAction[] = ['abort', 'continue', 'retry']

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isPositiveMs(v: unknown): v is number {
  return isFiniteNumber(v) && v > 0
}

function isNonNegativeMs(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0
}

function isThreshold(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0 && v <= 1
}

function hasAllowedFailureAction(v: unknown): v is BenchmarkFailureAction {
  return typeof v === 'string' && FAILURE_ACTIONS.includes(v as BenchmarkFailureAction)
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim()
  return trimmed ? trimmed : undefined
}

function validateRetryPolicy(
  raw: unknown,
  path: string,
  errors: string[]
): BenchmarkRetryPolicy | undefined {
  if (raw === undefined) return undefined
  if (!isObject(raw)) {
    errors.push(`${path} must be an object`)
    return undefined
  }

  const maxAttemptsRaw = raw.maxAttempts
  const maxAttempts = Number(maxAttemptsRaw)
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    errors.push(`${path}.maxAttempts must be an integer >= 1`)
  }

  let delayMs: number | undefined
  if (raw.delayMs !== undefined) {
    if (!isNonNegativeMs(raw.delayMs)) {
      errors.push(`${path}.delayMs must be a finite number >= 0`)
    } else {
      delayMs = Math.trunc(raw.delayMs)
    }
  }

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) return undefined

  return {
    maxAttempts,
    ...(delayMs !== undefined ? { delayMs } : {}),
  }
}

function validateDefaults(raw: unknown, errors: string[]): BenchmarkRecipeDefaults | undefined {
  if (raw === undefined) return undefined
  if (!isObject(raw)) {
    errors.push('defaults must be an object')
    return undefined
  }

  const out: BenchmarkRecipeDefaults = {}

  if (raw.stepTimeoutMs !== undefined) {
    if (!isPositiveMs(raw.stepTimeoutMs)) {
      errors.push('defaults.stepTimeoutMs must be a finite number > 0')
    } else {
      out.stepTimeoutMs = Math.trunc(raw.stepTimeoutMs)
    }
  }

  if (raw.onFailure !== undefined) {
    if (!hasAllowedFailureAction(raw.onFailure)) {
      errors.push('defaults.onFailure must be one of abort, continue, retry')
    } else {
      out.onFailure = raw.onFailure
    }
  }

  const retry = validateRetryPolicy(raw.retry, 'defaults.retry', errors)
  if (retry) out.retry = retry

  return Object.keys(out).length > 0 ? out : undefined
}

function validateBaseStep(
  raw: Record<string, unknown>,
  index: number,
  errors: string[]
): {
  id: string
  type: BenchmarkStepType | null
  timeoutMs?: number
  onFailure?: BenchmarkFailureAction
  retry?: BenchmarkRetryPolicy
  metadata?: Record<string, unknown>
} {
  const path = `steps[${index}]`

  const idRaw = readString(raw, 'id')
  const id = idRaw ?? `step-${index + 1}`

  let type: BenchmarkStepType | null = null
  if (typeof raw.type !== 'string' || !STEP_TYPES.includes(raw.type as BenchmarkStepType)) {
    errors.push(`${path}.type must be one of ${STEP_TYPES.join(', ')}`)
  } else {
    type = raw.type as BenchmarkStepType
  }

  let timeoutMs: number | undefined
  if (raw.timeoutMs !== undefined) {
    if (!isPositiveMs(raw.timeoutMs)) {
      errors.push(`${path}.timeoutMs must be a finite number > 0`)
    } else {
      timeoutMs = Math.trunc(raw.timeoutMs)
    }
  }

  let onFailure: BenchmarkFailureAction | undefined
  if (raw.onFailure !== undefined) {
    if (!hasAllowedFailureAction(raw.onFailure)) {
      errors.push(`${path}.onFailure must be one of abort, continue, retry`)
    } else {
      onFailure = raw.onFailure
    }
  }

  const retry = validateRetryPolicy(raw.retry, `${path}.retry`, errors)

  let metadata: Record<string, unknown> | undefined
  if (raw.metadata !== undefined) {
    if (!isObject(raw.metadata)) {
      errors.push(`${path}.metadata must be an object when provided`)
    } else {
      metadata = raw.metadata
    }
  }

  return {
    id,
    type,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(onFailure !== undefined ? { onFailure } : {}),
    ...(retry !== undefined ? { retry } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  }
}

function validateStep(raw: unknown, index: number, errors: string[]): BenchmarkStep | null {
  const path = `steps[${index}]`
  if (!isObject(raw)) {
    errors.push(`${path} must be an object`)
    return null
  }

  const base = validateBaseStep(raw, index, errors)
  if (!base.type) return null

  switch (base.type) {
    case 'wait': {
      if (!isPositiveMs(raw.durationMs)) {
        errors.push(`${path}.durationMs must be a finite number > 0`)
        return null
      }
      return {
        ...base,
        type: 'wait',
        durationMs: Math.trunc(raw.durationMs),
      }
    }

    case 'keyboard.typeText': {
      if (typeof raw.text !== 'string') {
        errors.push(`${path}.text must be a string`)
        return null
      }
      let interKeyDelayMs: number | undefined
      if (raw.interKeyDelayMs !== undefined) {
        if (!isNonNegativeMs(raw.interKeyDelayMs)) {
          errors.push(`${path}.interKeyDelayMs must be a finite number >= 0`)
        } else {
          interKeyDelayMs = Math.trunc(raw.interKeyDelayMs)
        }
      }
      return {
        ...base,
        type: 'keyboard.typeText',
        text: raw.text,
        ...(interKeyDelayMs !== undefined ? { interKeyDelayMs } : {}),
      }
    }

    case 'keyboard.key': {
      const key = readString(raw, 'key')
      if (!key) {
        errors.push(`${path}.key must be a non-empty string`)
        return null
      }
      const actionRaw = raw.action
      let action: 'press' | 'hold' | 'release' | undefined
      if (actionRaw !== undefined) {
        if (actionRaw !== 'press' && actionRaw !== 'hold' && actionRaw !== 'release') {
          errors.push(`${path}.action must be press, hold, or release when provided`)
        } else {
          action = actionRaw
        }
      }
      return {
        ...base,
        type: 'keyboard.key',
        key,
        ...(action !== undefined ? { action } : {}),
      }
    }

    case 'keyboard.hotkey': {
      if (!Array.isArray(raw.keys) || raw.keys.length === 0) {
        errors.push(`${path}.keys must be a non-empty string array`)
        return null
      }
      const keys = raw.keys
        .map((k) => (typeof k === 'string' ? k.trim() : ''))
        .filter(Boolean)
      if (keys.length !== raw.keys.length || keys.length === 0) {
        errors.push(`${path}.keys must contain only non-empty strings`)
        return null
      }

      let interKeyDelayMs: number | undefined
      if (raw.interKeyDelayMs !== undefined) {
        if (!isNonNegativeMs(raw.interKeyDelayMs)) {
          errors.push(`${path}.interKeyDelayMs must be a finite number >= 0`)
        } else {
          interKeyDelayMs = Math.trunc(raw.interKeyDelayMs)
        }
      }

      return {
        ...base,
        type: 'keyboard.hotkey',
        keys,
        ...(interKeyDelayMs !== undefined ? { interKeyDelayMs } : {}),
      }
    }

    case 'screen.waitForImageMatch': {
      const referenceImage = readString(raw, 'referenceImage')
      if (!referenceImage) {
        errors.push(`${path}.referenceImage must be a non-empty string`)
        return null
      }

      const thresholdRaw = raw.threshold ?? 0.9
      if (!isThreshold(thresholdRaw)) {
        errors.push(`${path}.threshold must be a finite number from 0 to 1`)
        return null
      }

      const timeoutRaw = raw.timeoutMs ?? 30_000
      if (!isPositiveMs(timeoutRaw)) {
        errors.push(`${path}.timeoutMs must be a finite number > 0`)
        return null
      }

      let pollIntervalMs: number | undefined
      if (raw.pollIntervalMs !== undefined) {
        if (!isPositiveMs(raw.pollIntervalMs)) {
          errors.push(`${path}.pollIntervalMs must be a finite number > 0`)
        } else {
          pollIntervalMs = Math.trunc(raw.pollIntervalMs)
        }
      }

      return {
        ...base,
        type: 'screen.waitForImageMatch',
        referenceImage,
        threshold: thresholdRaw,
        timeoutMs: Math.trunc(timeoutRaw),
        ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
      }
    }

    case 'screen.waitForStatic': {
      if (!isPositiveMs(raw.stableDurationMs)) {
        errors.push(`${path}.stableDurationMs must be a finite number > 0`)
        return null
      }

      const differenceThresholdRaw = raw.differenceThreshold ?? 0.03
      if (!isThreshold(differenceThresholdRaw)) {
        errors.push(`${path}.differenceThreshold must be a finite number from 0 to 1`)
        return null
      }

      const timeoutRaw = raw.timeoutMs ?? 30_000
      if (!isPositiveMs(timeoutRaw)) {
        errors.push(`${path}.timeoutMs must be a finite number > 0`)
        return null
      }

      let pollIntervalMs: number | undefined
      if (raw.pollIntervalMs !== undefined) {
        if (!isPositiveMs(raw.pollIntervalMs)) {
          errors.push(`${path}.pollIntervalMs must be a finite number > 0`)
        } else {
          pollIntervalMs = Math.trunc(raw.pollIntervalMs)
        }
      }

      return {
        ...base,
        type: 'screen.waitForStatic',
        stableDurationMs: Math.trunc(raw.stableDurationMs),
        differenceThreshold: differenceThresholdRaw,
        timeoutMs: Math.trunc(timeoutRaw),
        ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
      }
    }
  }
}

export function validateBenchmarkRecipe(input: unknown): BenchmarkValidationResult {
  const errors: string[] = []

  if (!isObject(input)) {
    return { ok: false, errors: ['recipe must be an object'] }
  }

  if (input.schemaVersion !== BENCHMARK_RECIPE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${BENCHMARK_RECIPE_SCHEMA_VERSION}`)
  }

  const id = readString(input, 'id')
  if (!id) errors.push('id must be a non-empty string')

  const name = readString(input, 'name')
  if (!name) errors.push('name must be a non-empty string')

  let description: string | undefined
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') {
      errors.push('description must be a string when provided')
    } else if (input.description.trim()) {
      description = input.description.trim()
    }
  }

  const defaults = validateDefaults(input.defaults, errors)

  let metadata: Record<string, unknown> | undefined
  if (input.metadata !== undefined) {
    if (!isObject(input.metadata)) {
      errors.push('metadata must be an object when provided')
    } else {
      metadata = input.metadata
    }
  }

  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    errors.push('steps must be a non-empty array')
  }

  const steps: BenchmarkStep[] = []
  if (Array.isArray(input.steps)) {
    const seenStepIds = new Set<string>()
    input.steps.forEach((rawStep, index) => {
      const step = validateStep(rawStep, index, errors)
      if (!step) return
      if (seenStepIds.has(step.id)) {
        errors.push(`steps[${index}].id duplicates another step id: ${step.id}`)
      }
      seenStepIds.add(step.id)
      steps.push(step)
    })
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    recipe: {
      schemaVersion: BENCHMARK_RECIPE_SCHEMA_VERSION,
      id: id!,
      name: name!,
      ...(description !== undefined ? { description } : {}),
      ...(defaults !== undefined ? { defaults } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      steps,
    },
  }
}
