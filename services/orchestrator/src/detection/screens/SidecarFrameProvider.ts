// services/orchestrator/src/detection/screens/SidecarFrameProvider.ts
import { request } from 'undici'

import { ScreenMatchingError, type CurrentFrameProvider, type ScreenFrame } from './types.js'

function headerAsString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.find((v): v is string => typeof v === 'string')
  return undefined
}

export class SidecarFrameProvider implements CurrentFrameProvider {
  private readonly baseUrl: string

  constructor(opts: { baseUrl: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
  }

  async captureFrame(signal?: AbortSignal): Promise<ScreenFrame> {
    if (signal?.aborted) {
      throw new ScreenMatchingError('CaptureFrameUnavailable', 'capture frame request was cancelled', 503)
    }

    const url = `${this.baseUrl}/screenshot`
    const capturedAt = Date.now()

    let res: Awaited<ReturnType<typeof request>>
    try {
      res = await request(url, {
        method: 'GET',
        headers: { accept: 'image/jpeg,image/png,image/*' },
        signal,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ScreenMatchingError(
        'CaptureFrameUnavailable',
        `Unable to reach sidecar screenshot endpoint: ${message}`,
        503,
        { baseUrl: this.baseUrl }
      )
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      const text = await res.body.text().catch(() => '')
      throw new ScreenMatchingError(
        'CaptureFrameUnavailable',
        `No captured frame is currently available from the sidecar screenshot endpoint`,
        503,
        { statusCode: res.statusCode, bodyPreview: text.slice(0, 200) }
      )
    }

    const arrayBuffer = await res.body.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    if (buffer.length === 0) {
      throw new ScreenMatchingError('CaptureFrameUnavailable', 'sidecar screenshot response was empty', 503)
    }

    const contentType = headerAsString((res.headers as any)['content-type']) ?? 'application/octet-stream'
    const ageHeader = headerAsString((res.headers as any)['x-frame-age-ms'])
    const ageMs = ageHeader !== undefined && Number.isFinite(Number(ageHeader)) ? Number(ageHeader) : undefined

    return {
      buffer,
      contentType,
      capturedAt,
      ...(ageMs !== undefined ? { ageMs } : {}),
    }
  }
}
