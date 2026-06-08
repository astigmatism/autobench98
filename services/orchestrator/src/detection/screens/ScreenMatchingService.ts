import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import ssim from 'ssim.js'
import type { ScreenMatchingConfig } from '../../config/screenMatching.js'
import {
  ScreenMatchingError,
  type ReferenceImageEntry,
  type ReferenceScreenMatchResult,
  type ScreenFrame,
  type ScreenFrameProvider,
  type ScreenMatchNormalization,
  type ScreenMatchingPublicConfig,
  type StaticScreenCheckResult,
} from './types.js'

const SUPPORTED_REFERENCE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp'])
const MAX_REFERENCE_LIST_ITEMS = 1000
const MAX_INPUT_PIXELS = 64 * 1024 * 1024
const DEFAULT_REFERENCE_READ_LIMIT_BYTES = 25 * 1024 * 1024

type ScreenMatchingLogger = {
  debug: (message: string, extra?: Record<string, unknown>) => void
  info: (message: string, extra?: Record<string, unknown>) => void
  warn: (message: string, extra?: Record<string, unknown>) => void
}

type ImageSize = {
  width: number
  height: number
}

type NormalizedImage = ImageSize & {
  data: Uint8ClampedArray
  sourceWidth: number
  sourceHeight: number
  resized: boolean
}

type SsimImageData = {
  data: Uint8ClampedArray
  width: number
  height: number
}

function dateIso(ms: number): string {
  return new Date(ms).toISOString()
}

function nowIso(): string {
  return new Date().toISOString()
}

function validateThreshold(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string' && value.trim() === '') return fallback

  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numberValue) || numberValue < 0 || numberValue > 1) {
    throw new ScreenMatchingError(
      'InvalidThreshold',
      `${label} must be a number between 0 and 1.`,
      400,
      { value }
    )
  }

  return numberValue
}

function toSsimImage(image: NormalizedImage): SsimImageData {
  return {
    data: image.data,
    width: image.width,
    height: image.height,
  }
}

function buildNormalization(
  current: NormalizedImage,
  comparison: NormalizedImage,
  reference?: NormalizedImage
): ScreenMatchNormalization {
  return {
    current: {
      width: current.width,
      height: current.height,
      sourceWidth: current.sourceWidth,
      sourceHeight: current.sourceHeight,
      resizedToCurrent: current.resized,
    },
    comparison: {
      width: comparison.width,
      height: comparison.height,
      sourceWidth: comparison.sourceWidth,
      sourceHeight: comparison.sourceHeight,
      resizedToCurrent: comparison.resized,
    },
    ...(reference
      ? {
          reference: {
            width: reference.width,
            height: reference.height,
            sourceWidth: reference.sourceWidth,
            sourceHeight: reference.sourceHeight,
            resizedToCurrent: reference.resized,
          },
        }
      : {}),
  }
}

function formatRelativeReferencePath(absPath: string, rootDir: string): string {
  return path.relative(rootDir, absPath).split(path.sep).join('/')
}

export class ScreenMatchingService {
  private previousFrame: ScreenFrame | null = null
  private readonly frameProvider: ScreenFrameProvider
  private readonly config: ScreenMatchingConfig
  private readonly logger: ScreenMatchingLogger

  constructor(opts: {
    frameProvider: ScreenFrameProvider
    config: ScreenMatchingConfig
    logger: ScreenMatchingLogger
  }) {
    this.frameProvider = opts.frameProvider
    this.config = opts.config
    this.logger = opts.logger
  }

  getPublicConfig(): ScreenMatchingPublicConfig {
    return {
      staticThreshold: this.config.staticThreshold,
      defaultReferenceThreshold: this.config.defaultReferenceThreshold,
      referenceDir: this.config.referenceDir,
    }
  }

  async checkStatic(signal?: AbortSignal): Promise<StaticScreenCheckResult> {
    const currentFrame = await this.frameProvider.captureFrame(signal)
    const checkedAt = nowIso()
    const previousFrame = this.previousFrame

    this.previousFrame = currentFrame

    if (!previousFrame) {
      return {
        isStatic: false,
        score: null,
        threshold: this.config.staticThreshold,
        previousFrameAvailable: false,
        currentFrameCapturedAt: dateIso(currentFrame.capturedAt),
        ...(currentFrame.ageMs !== undefined ? { currentFrameAgeMs: currentFrame.ageMs } : {}),
        checkedAt,
        method: 'ssim.js',
      }
    }

    const current = await this.normalizeImage(currentFrame.buffer, {
      label: 'current frame',
    })
    const previous = await this.normalizeImage(previousFrame.buffer, {
      label: 'previous frame',
      target: current,
    })
    const score = this.compareNormalizedImages(current, previous)

    return {
      isStatic: score >= this.config.staticThreshold,
      score,
      threshold: this.config.staticThreshold,
      previousFrameAvailable: true,
      currentFrameCapturedAt: dateIso(currentFrame.capturedAt),
      ...(currentFrame.ageMs !== undefined ? { currentFrameAgeMs: currentFrame.ageMs } : {}),
      checkedAt,
      method: 'ssim.js',
      normalization: buildNormalization(current, previous),
    }
  }

  async compareCurrentFrameToReference(
    referenceImage: string,
    threshold?: unknown,
    signal?: AbortSignal
  ): Promise<ReferenceScreenMatchResult> {
    const resolvedThreshold = validateThreshold(
      threshold,
      this.config.defaultReferenceThreshold,
      'Reference image threshold'
    )
    const { absolutePath, relativePath } = await this.resolveReferenceImage(referenceImage)
    const [currentFrame, referenceBuffer] = await Promise.all([
      this.frameProvider.captureFrame(signal),
      fs.readFile(absolutePath),
    ])

    if (referenceBuffer.length > DEFAULT_REFERENCE_READ_LIMIT_BYTES) {
      throw new ScreenMatchingError(
        'UnsupportedImageFormat',
        'Reference image is too large for screen matching.',
        413,
        {
          referenceImage: relativePath,
          sizeBytes: referenceBuffer.length,
          limitBytes: DEFAULT_REFERENCE_READ_LIMIT_BYTES,
        }
      )
    }

    const current = await this.normalizeImage(currentFrame.buffer, {
      label: 'current frame',
    })
    const reference = await this.normalizeImage(referenceBuffer, {
      label: `reference image ${relativePath}`,
      target: current,
    })
    const score = this.compareNormalizedImages(current, reference)

    return {
      matched: score >= resolvedThreshold,
      score,
      threshold: resolvedThreshold,
      referenceImage: relativePath,
      currentFrameCapturedAt: dateIso(currentFrame.capturedAt),
      ...(currentFrame.ageMs !== undefined ? { currentFrameAgeMs: currentFrame.ageMs } : {}),
      checkedAt: nowIso(),
      method: 'ssim.js',
      normalization: buildNormalization(current, reference, reference),
    }
  }

  async listReferenceImages(): Promise<ReferenceImageEntry[]> {
    await this.ensureReferenceDir()

    const items: ReferenceImageEntry[] = []
    await this.walkReferenceDir(this.config.referenceDir, items)
    items.sort((a, b) => a.name.localeCompare(b.name))
    return items
  }

  resetStaticHistory(): void {
    this.previousFrame = null
  }

  private compareNormalizedImages(a: NormalizedImage, b: NormalizedImage): number {
    if (a.width !== b.width || a.height !== b.height) {
      throw new ScreenMatchingError(
        'ImageNormalizationFailed',
        'Cannot compare images because normalized dimensions do not match.',
        500,
        {
          current: { width: a.width, height: a.height },
          comparison: { width: b.width, height: b.height },
        }
      )
    }

    try {
      const result = ssim(toSsimImage(a), toSsimImage(b))
      return result.mssim
    } catch (err) {
      throw new ScreenMatchingError(
        'ScreenComparisonFailed',
        'SSIM comparison failed.',
        500,
        { cause: err instanceof Error ? err.message : String(err) }
      )
    }
  }

  private async normalizeImage(
    buffer: Buffer,
    opts: {
      label: string
      target?: ImageSize
    }
  ): Promise<NormalizedImage> {
    try {
      const metadata = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .metadata()

      if (!metadata.width || !metadata.height) {
        throw new ScreenMatchingError(
          'UnsupportedImageFormat',
          `Unable to determine dimensions for ${opts.label}.`,
          415
        )
      }

      const target = opts.target
      const shouldResize = Boolean(
        target && (metadata.width !== target.width || metadata.height !== target.height)
      )

      let pipeline = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).rotate()
      if (target && shouldResize) {
        pipeline = pipeline.resize(target.width, target.height, {
          fit: 'fill',
          kernel: 'lanczos3',
        })
      }

      const { data, info } = await pipeline
        .flatten({ background: { r: 0, g: 0, b: 0 } })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })

      if (!info.width || !info.height || info.channels !== 4) {
        throw new ScreenMatchingError(
          'ImageNormalizationFailed',
          `Unable to normalize ${opts.label} to RGBA image data.`,
          500,
          { width: info.width, height: info.height, channels: info.channels }
        )
      }

      return {
        data: new Uint8ClampedArray(data),
        width: info.width,
        height: info.height,
        sourceWidth: metadata.width,
        sourceHeight: metadata.height,
        resized: shouldResize,
      }
    } catch (err) {
      if (err instanceof ScreenMatchingError) throw err

      throw new ScreenMatchingError(
        'ImageNormalizationFailed',
        `Unable to decode or normalize ${opts.label}.`,
        415,
        { cause: err instanceof Error ? err.message : String(err) }
      )
    }
  }

  private async ensureReferenceDir(): Promise<void> {
    try {
      await fs.mkdir(this.config.referenceDir, { recursive: true })
    } catch (err) {
      throw new ScreenMatchingError(
        'ReferenceDirectoryUnavailable',
        'Unable to create or access the screen reference image directory.',
        500,
        {
          referenceDir: this.config.referenceDir,
          cause: err instanceof Error ? err.message : String(err),
        }
      )
    }
  }

  private async walkReferenceDir(dir: string, items: ReferenceImageEntry[]): Promise<void> {
    if (items.length >= MAX_REFERENCE_LIST_ITEMS) return

    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      throw new ScreenMatchingError(
        'ReferenceDirectoryUnavailable',
        'Unable to read the screen reference image directory.',
        500,
        {
          referenceDir: dir,
          cause: err instanceof Error ? err.message : String(err),
        }
      )
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (items.length >= MAX_REFERENCE_LIST_ITEMS) {
        this.logger.warn('Screen reference image list truncated.', {
          limit: MAX_REFERENCE_LIST_ITEMS,
          referenceDir: this.config.referenceDir,
        })
        return
      }

      const absolutePath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await this.walkReferenceDir(absolutePath, items)
        continue
      }

      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!SUPPORTED_REFERENCE_EXTENSIONS.has(ext)) continue

      const stat = await fs.stat(absolutePath)
      items.push({
        name: formatRelativeReferencePath(absolutePath, this.config.referenceDir),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      })
    }
  }

  private async resolveReferenceImage(referenceImage: string): Promise<{
    absolutePath: string
    relativePath: string
  }> {
    const input = String(referenceImage ?? '').trim()
    if (!input) {
      throw new ScreenMatchingError(
        'InvalidReferenceImage',
        'A reference image name is required.',
        400
      )
    }

    const looksLikeWindowsAbsolutePath = /^[A-Za-z]:[\\/]/.test(input)
    if (input.includes('\0') || path.isAbsolute(input) || looksLikeWindowsAbsolutePath) {
      throw new ScreenMatchingError(
        'InvalidReferenceImage',
        'Reference image must be a relative path inside the configured reference directory.',
        400
      )
    }

    const normalizedInput = input.replace(/\\/g, '/')
    const containsDotDotSegment = normalizedInput
      .split('/')
      .some((segment) => segment === '..')
    const normalizedRelative = path.posix.normalize(normalizedInput)
    if (
      containsDotDotSegment ||
      normalizedRelative === '.' ||
      normalizedRelative.startsWith('../') ||
      normalizedRelative === '..' ||
      normalizedRelative.includes('/../')
    ) {
      throw new ScreenMatchingError(
        'InvalidReferenceImage',
        'Reference image path traversal is not allowed.',
        400
      )
    }

    const ext = path.extname(normalizedRelative).toLowerCase()
    if (!SUPPORTED_REFERENCE_EXTENSIONS.has(ext)) {
      throw new ScreenMatchingError(
        'UnsupportedImageFormat',
        'Reference image must be PNG, JPEG, BMP, or WebP.',
        415,
        { referenceImage: normalizedRelative }
      )
    }

    await this.ensureReferenceDir()

    const root = path.resolve(this.config.referenceDir)
    const absolutePath = path.resolve(root, normalizedRelative)
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
      throw new ScreenMatchingError(
        'InvalidReferenceImage',
        'Reference image path resolves outside the configured reference directory.',
        400
      )
    }

    let stat: import('node:fs').Stats
    try {
      stat = await fs.stat(absolutePath)
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException
      if (nodeErr.code === 'ENOENT') {
        throw new ScreenMatchingError(
          'ReferenceImageNotFound',
          'Reference image was not found.',
          404,
          { referenceImage: normalizedRelative }
        )
      }

      throw new ScreenMatchingError(
        'ReferenceDirectoryUnavailable',
        'Unable to read reference image metadata.',
        500,
        {
          referenceImage: normalizedRelative,
          cause: err instanceof Error ? err.message : String(err),
        }
      )
    }

    if (!stat.isFile()) {
      throw new ScreenMatchingError(
        'ReferenceImageNotFound',
        'Reference image was not found.',
        404,
        { referenceImage: normalizedRelative }
      )
    }

    if (stat.size > DEFAULT_REFERENCE_READ_LIMIT_BYTES) {
      throw new ScreenMatchingError(
        'UnsupportedImageFormat',
        'Reference image is too large for screen matching.',
        413,
        {
          referenceImage: normalizedRelative,
          sizeBytes: stat.size,
          limitBytes: DEFAULT_REFERENCE_READ_LIMIT_BYTES,
        }
      )
    }

    return {
      absolutePath,
      relativePath: normalizedRelative,
    }
  }
}
