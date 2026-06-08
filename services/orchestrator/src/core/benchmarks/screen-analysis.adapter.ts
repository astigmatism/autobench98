// services/orchestrator/src/core/benchmarks/screen-analysis.adapter.ts

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { request } from 'undici'
import type {
  BenchmarkScreenAnalysisAdapter,
  ScreenFrame,
  ScreenMatchResult,
  StaticScreenResult,
} from './types.js'

type LoggerLike = {
  warn(msg: string, extra?: Record<string, unknown>): void
  debug(msg: string, extra?: Record<string, unknown>): void
}

const noopLogger: LoggerLike = {
  warn: () => undefined,
  debug: () => undefined,
}

const IMAGE_COMPARE_METHOD = 'encoded-byte-similarity-placeholder-v1'
const STATIC_COMPARE_METHOD = 'encoded-byte-difference-placeholder-v1'

function now(): number {
  return Date.now()
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const delay = Math.max(0, Math.trunc(ms))
  if (delay <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(new Error('operation cancelled'))

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, delay)

    const onAbort = () => {
      cleanup()
      reject(new Error('operation cancelled'))
    }

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('operation cancelled')
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/**
 * Placeholder encoded-image comparison.
 *
 * This intentionally avoids pulling an image decoder into the scaffold. It is
 * suitable for exercising orchestration flow, but it is not SSIM/template
 * matching. A future adapter should decode frames to pixels and compare
 * regions/masks using a real computer-vision implementation.
 */
function compareEncodedBuffers(a: Buffer, b: Buffer): { score: number; difference: number } {
  if (a.length === 0 || b.length === 0) return { score: 0, difference: 1 }

  const minLen = Math.min(a.length, b.length)
  const maxLen = Math.max(a.length, b.length)
  const samples = Math.min(8192, minLen)
  const stride = Math.max(1, Math.floor(minLen / samples))

  let compared = 0
  let sum = 0

  for (let i = 0; i < minLen; i += stride) {
    sum += Math.abs(a[i] - b[i]) / 255
    compared++
  }

  const byteDifference = compared > 0 ? sum / compared : 1
  const lengthPenalty = maxLen > 0 ? Math.abs(a.length - b.length) / maxLen : 1
  const difference = clamp01(byteDifference * 0.85 + lengthPenalty * 0.15)
  return { difference, score: clamp01(1 - difference) }
}

function headerAsString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.find((v): v is string => typeof v === 'string')
  return undefined
}

export class SidecarScreenAnalysisAdapter implements BenchmarkScreenAnalysisAdapter {
  private readonly baseUrl: string
  private readonly assetRoot: string
  private readonly log: LoggerLike

  constructor(opts: { baseUrl: string; assetRoot: string; logger?: LoggerLike }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.assetRoot = opts.assetRoot
    this.log = opts.logger ?? noopLogger
  }

  async captureFrame(signal?: AbortSignal): Promise<ScreenFrame> {
    assertNotAborted(signal)

    const url = `${this.baseUrl}/screenshot`
    const capturedAt = now()
    const res = await request(url, {
      method: 'GET',
      headers: { accept: 'image/jpeg' },
      signal,
    })

    if (res.statusCode < 200 || res.statusCode >= 300) {
      const text = await res.body.text().catch(() => '')
      throw new Error(`sidecar screenshot unavailable status=${res.statusCode} body=${text.slice(0, 200)}`)
    }

    const arrayBuffer = await res.body.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    const contentType = headerAsString((res.headers as any)['content-type']) ?? 'image/jpeg'
    const ageHeader = headerAsString((res.headers as any)['x-frame-age-ms'])
    const ageMs = ageHeader !== undefined && Number.isFinite(Number(ageHeader)) ? Number(ageHeader) : undefined

    return {
      buffer,
      contentType,
      capturedAt,
      ...(ageMs !== undefined ? { ageMs } : {}),
    }
  }

  async waitForImageMatch(opts: {
    referenceImage: string
    threshold: number
    timeoutMs: number
    pollIntervalMs?: number
    signal?: AbortSignal
  }): Promise<ScreenMatchResult> {
    const startedAt = now()
    const deadline = startedAt + Math.max(1, Math.trunc(opts.timeoutMs))
    const pollIntervalMs = Math.max(100, Math.trunc(opts.pollIntervalMs ?? 500))
    const threshold = clamp01(opts.threshold)
    const referencePath = this.resolveReferencePath(opts.referenceImage)
    const reference = await fs.readFile(referencePath)

    let attempts = 0
    let lastScore: number | null = null

    while (now() <= deadline) {
      assertNotAborted(opts.signal)
      attempts++

      try {
        const frame = await this.captureFrame(opts.signal)
        const cmp = compareEncodedBuffers(frame.buffer, reference)
        lastScore = cmp.score

        if (cmp.score >= threshold) {
          return {
            matched: true,
            score: cmp.score,
            threshold,
            referenceImage: opts.referenceImage,
            method: IMAGE_COMPARE_METHOD,
            attempts,
            elapsedMs: now() - startedAt,
          }
        }
      } catch (err) {
        this.log.debug('screen image match poll failed', {
          err: err instanceof Error ? err.message : String(err),
        })
      }

      const remaining = deadline - now()
      if (remaining <= 0) break
      await sleep(Math.min(pollIntervalMs, remaining), opts.signal)
    }

    return {
      matched: false,
      score: lastScore,
      threshold,
      referenceImage: opts.referenceImage,
      method: IMAGE_COMPARE_METHOD,
      attempts,
      elapsedMs: now() - startedAt,
    }
  }

  async waitForStatic(opts: {
    stableDurationMs: number
    differenceThreshold: number
    timeoutMs: number
    pollIntervalMs?: number
    signal?: AbortSignal
  }): Promise<StaticScreenResult> {
    const startedAt = now()
    const deadline = startedAt + Math.max(1, Math.trunc(opts.timeoutMs))
    const stableDurationMs = Math.max(1, Math.trunc(opts.stableDurationMs))
    const differenceThreshold = clamp01(opts.differenceThreshold)
    const pollIntervalMs = Math.max(100, Math.trunc(opts.pollIntervalMs ?? 500))

    let attempts = 0
    let previous: Buffer | null = null
    let stableSince: number | null = null
    let observedStableMs = 0
    let lastDifference: number | null = null

    while (now() <= deadline) {
      assertNotAborted(opts.signal)
      attempts++

      try {
        const frame = await this.captureFrame(opts.signal)
        if (previous) {
          const cmp = compareEncodedBuffers(frame.buffer, previous)
          lastDifference = cmp.difference

          if (cmp.difference <= differenceThreshold) {
            stableSince = stableSince ?? now()
            observedStableMs = now() - stableSince

            if (observedStableMs >= stableDurationMs) {
              return {
                becameStatic: true,
                stableDurationMs,
                observedStableMs,
                differenceThreshold,
                lastDifference,
                method: STATIC_COMPARE_METHOD,
                attempts,
                elapsedMs: now() - startedAt,
              }
            }
          } else {
            stableSince = null
            observedStableMs = 0
          }
        }

        previous = frame.buffer
      } catch (err) {
        this.log.debug('screen static poll failed', {
          err: err instanceof Error ? err.message : String(err),
        })
        stableSince = null
        observedStableMs = 0
      }

      const remaining = deadline - now()
      if (remaining <= 0) break
      await sleep(Math.min(pollIntervalMs, remaining), opts.signal)
    }

    return {
      becameStatic: false,
      stableDurationMs,
      observedStableMs,
      differenceThreshold,
      lastDifference,
      method: STATIC_COMPARE_METHOD,
      attempts,
      elapsedMs: now() - startedAt,
    }
  }

  private resolveReferencePath(referenceImage: string): string {
    const raw = referenceImage.trim()
    if (!raw) throw new Error('referenceImage is required')

    const resolved = path.isAbsolute(raw) ? raw : path.resolve(this.assetRoot, raw)
    this.log.debug('resolved benchmark reference image', {
      referenceImage,
      resolved,
      assetRoot: this.assetRoot,
    })
    return resolved
  }
}
