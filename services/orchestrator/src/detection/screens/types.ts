// services/orchestrator/src/detection/screens/types.ts

export type ScreenMatchingErrorCode =
  | 'CaptureFrameUnavailable'
  | 'InvalidThreshold'
  | 'InvalidReferenceImage'
  | 'ReferenceImageNotFound'
  | 'ReferenceDirectoryUnavailable'
  | 'UnsupportedImageFormat'
  | 'ImageNormalizationFailed'
  | 'ScreenComparisonFailed'

export class ScreenMatchingError extends Error {
  readonly code: ScreenMatchingErrorCode
  readonly statusCode: number
  readonly detail?: Record<string, unknown>

  constructor(
    code: ScreenMatchingErrorCode,
    message: string,
    statusCode = 500,
    detail?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'ScreenMatchingError'
    this.code = code
    this.statusCode = statusCode
    this.detail = detail
  }
}

export type ScreenFrame = {
  buffer: Buffer
  contentType: string
  capturedAt: number
  ageMs?: number
}

export type CurrentFrameProvider = {
  captureFrame(signal?: AbortSignal): Promise<ScreenFrame>
}

export type ScreenFrameProvider = CurrentFrameProvider

export type ScreenImageDimensions = {
  width: number
  height: number
  sourceWidth?: number
  sourceHeight?: number
  resizedToCurrent?: boolean
}

export type ScreenMatchNormalization = {
  current: ScreenImageDimensions
  comparison: ScreenImageDimensions
  reference?: ScreenImageDimensions
}

export type ScreenMatchingPublicConfig = {
  staticThreshold: number
  defaultReferenceThreshold: number
  referenceDir: string
}

export type StaticScreenCheckResult = {
  isStatic: boolean
  score: number | null
  threshold: number
  previousFrameAvailable: boolean
  checkedAt: string
  method: 'ssim.js'
  currentFrameCapturedAt?: string
  currentFrameAgeMs?: number
  normalization?: ScreenMatchNormalization
}

export type ReferenceImageEntry = {
  name: string
  sizeBytes: number
  modifiedAt: string
}

export type ReferenceImageListItem = ReferenceImageEntry

export type ReferenceScreenMatchResult = {
  matched: boolean
  score: number
  threshold: number
  referenceImage: string
  checkedAt: string
  method: 'ssim.js'
  currentFrameCapturedAt?: string
  currentFrameAgeMs?: number
  normalization: ScreenMatchNormalization
}
