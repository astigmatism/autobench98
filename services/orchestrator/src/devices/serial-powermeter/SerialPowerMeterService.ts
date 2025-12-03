/* eslint-disable no-console */
import { SerialPort } from 'serialport'
import {
    type PowerMeterConfig,
    type PowerMeterEventSink,
    type PowerMeterState,
    type PowerMeterStats,
    type PowerSample,
    type PowerRecordingSummary,
    type PowerRecorderOptions,
} from './types.js'
import {
    parseWattsUpFrame,
    createRecorder,
    type RecorderInstance,
} from './utils.js'

interface SerialPowerMeterServiceDeps {
    events: PowerMeterEventSink
}

/**
 * Internal per-recorder quality tracking.
 *
 * This lives alongside RecorderInstance rather than inside it so we
 * don’t change the recorder contract or utils.ts patterns.
 */
interface RecorderQualityStats {
    /** When this recorder was started (ms since epoch). */
    startedAt: number
    /** When this recorder was ended (ms since epoch), set at endRecording. */
    endedAt: number | null
    /** Number of successfully parsed samples while this recorder was active. */
    goodSamples: number
    /** Number of parse failures / bad frames while this recorder was active. */
    badFrames: number
    /** Timestamp of last good sample routed to this recorder. */
    lastGoodSampleAt: number | null
    /** Largest gap between successive good samples while active (ms). */
    maxGapMs: number
}

/**
 * SerialPowerMeterService
 *
 * - Attaches to a WattsUp? PRO serial device when a compatible path is discovered.
 * - Sends the standard command sequence to start logging at the configured interval.
 * - Parses "#d,..." frames into PowerSample objects.
 * - Maintains a rolling buffer of recent samples.
 * - Supports multiple independent recorders keyed by ID (benchmark, UI, etc).
 *
 * Discovery is handled externally via SerialDiscoveryService. The orchestrator
 * is expected to:
 *   - Call onDeviceIdentified(...) when a power meter is detected.
 *   - Call onDeviceLost(...) when that device disappears.
 */
export class SerialPowerMeterService {
    private readonly config: PowerMeterConfig
    private readonly deps: SerialPowerMeterServiceDeps

    private state: PowerMeterState = { phase: 'disconnected' }
    private stats: PowerMeterStats = {
        totalSamples: 0,
        bytesReceived: 0,
        lastSampleAt: null,
        lastErrorAt: null,
    }

    private deviceId: string | null = null
    private devicePath: string | null = null
    private deviceBaudRate = 115200

    private port: SerialPort | null = null
    private reconnectAttempts = 0
    private reconnectTimer: NodeJS.Timeout | null = null

    private readBuffer = ''
    private recentSamples: PowerSample[] = []

    /** Multiple concurrent recorders (benchmark, UI, other spans). */
    private recorders = new Map<string, RecorderInstance>()

    /**
     * Per-recorder quality metadata keyed by recorderId.
     * This is intentionally separate from RecorderInstance to respect
     * the utils.ts / types.ts separation.
     */
    private recorderQuality = new Map<string, RecorderQualityStats>()

    /**
     * Guardrails for unparseable data:
     *
     * - We treat repeated invalid frames as a sign that the device is unhealthy
     *   (or the link is corrupted), even if bytes are still flowing.
     * - After a threshold of consecutive failures, we behave as if the device
     *   were disconnected and let normal reconnect logic take over.
     *
     * These are intentionally conservative defaults and can be tuned via env:
     *   - SERIAL_PM_MAX_PARSE_FAILURES
     *   - SERIAL_PM_PARSE_FAILURE_WINDOW_MS
     */
    private consecutiveParseFailures = 0
    private readonly maxConsecutiveParseFailures: number
    private readonly parseFailureWindowMs: number

    /**
     * Count of invalid frames seen since the last successfully parsed
     * sample. This helps distinguish "no data at all" from "lots of junk"
     * when the guardrail based on lastSampleAt fires.
     */
    private invalidFramesSinceLastGoodSample = 0

    /**
     * Whether to actually perform a "soft disconnect" (close + reconnect)
     * when guardrails for invalid frames are tripped.
     *
     * Controlled by SERIAL_PM_ENABLE_SOFT_DISCONNECT; defaults to false so
     * benchmarks rely on per-run quality rather than port churn.
     */
    private readonly enableSoftDisconnect: boolean

    constructor(config: PowerMeterConfig, deps: SerialPowerMeterServiceDeps) {
        this.config = config
        this.deps = deps

        const intervalSec = this.config.samplingIntervalSec ?? 1

        // ---- Max consecutive failures (env override with sane default) ----
        const maxFailRaw = process.env.SERIAL_PM_MAX_PARSE_FAILURES
        const maxFailNum = maxFailRaw !== undefined ? Number(maxFailRaw) : NaN
        this.maxConsecutiveParseFailures =
            Number.isFinite(maxFailNum) && maxFailNum > 0
                ? maxFailNum
                : 30 // was 10; relax to be less sensitive to short bursts

        // ---- Failure window ms (env override with heuristic fallback) -----
        const windowRaw = process.env.SERIAL_PM_PARSE_FAILURE_WINDOW_MS
        const windowNum = windowRaw !== undefined ? Number(windowRaw) : NaN

        if (Number.isFinite(windowNum) && windowNum > 0) {
            this.parseFailureWindowMs = windowNum
        } else {
            // Heuristic (relaxed): ~3x the time it would take to see
            // maxConsecutiveParseFailures samples, clamped to [60s, 300s].
            const heuristic = intervalSec * 1000 * this.maxConsecutiveParseFailures * 3
            this.parseFailureWindowMs = Math.max(60_000, Math.min(300_000, heuristic))
        }

        // ---- Soft disconnect enable flag ----------------------------------
        const softRaw = process.env.SERIAL_PM_ENABLE_SOFT_DISCONNECT
        if (softRaw == null || softRaw === '') {
            this.enableSoftDisconnect = false
        } else {
            const v = softRaw.toLowerCase()
            this.enableSoftDisconnect = v === 'true' || v === '1' || v === 'yes'
        }
    }

    /* ---------------------------------------------------------------------- */
    /*  Public API                                                            */
    /* ---------------------------------------------------------------------- */

    /** For symmetry with other services; may remain a no-op. */
    public async start(): Promise<void> {
        // Intentionally empty for now; device attach is driven by discovery.
        // We could add background health tasks here later.
    }

    public async stop(): Promise<void> {
        this.clearReconnectTimer()
        this.recorders.clear()
        this.recorderQuality.clear()
        await this.closePort('explicit-close')
        this.state = { phase: 'disconnected' }
        this.deviceId = null
        this.devicePath = null
        this.consecutiveParseFailures = 0
        this.invalidFramesSinceLastGoodSample = 0
    }

    /** Current high-level state. */
    public getState(): PowerMeterState {
        return { ...this.state }
    }

    /** Lightweight stats for dashboards/logs. */
    public getStats(): PowerMeterStats {
        return { ...this.stats }
    }

    /** Last sample (if any). */
    public getLastSample(): PowerSample | null {
        const len = this.recentSamples.length
        return len > 0 ? { ...this.recentSamples[len - 1] } : null
    }

    /** Snapshot of recent samples (copy, bounded). */
    public getRecentSamples(): PowerSample[] {
        return this.recentSamples.map(s => ({ ...s }))
    }

    /* ---------------------------------------------------------------------- */
    /*  Discovery-driven lifecycle                                            */
    /* ---------------------------------------------------------------------- */

    public async onDeviceIdentified(args: {
        id: string
        path: string
        baudRate?: number
    }): Promise<void> {
        this.deviceId = args.id

        // On macOS, SerialPort.list() typically returns /dev/tty.*,
        // but the recommended node for outgoing serial use is /dev/cu.*.
        let effectivePath = args.path
        if (effectivePath.startsWith('/dev/tty.')) {
            const cuPath = '/dev/cu.' + effectivePath.slice('/dev/tty.'.length)
            effectivePath = cuPath
        }

        this.devicePath = effectivePath
        this.deviceBaudRate = args.baudRate ?? 115200

        this.deps.events.publish({
            kind: 'meter-device-identified',
            at: Date.now(),
            id: args.id,
            path: this.devicePath,
            baudRate: this.deviceBaudRate,
        })

        if (
            this.port &&
            this.port.isOpen &&
            this.state.phase === 'streaming' &&
            this.devicePath === effectivePath
        ) {
            return
        }

        await this.openPort()
    }

    public async onDeviceLost(args: { id: string }): Promise<void> {
        if (this.deviceId !== args.id) return

        this.clearReconnectTimer()
        await this.closePort('device-lost')

        this.state = { phase: 'disconnected' }
        this.consecutiveParseFailures = 0
        this.invalidFramesSinceLastGoodSample = 0

        this.deps.events.publish({
            kind: 'meter-device-lost',
            at: Date.now(),
            id: args.id,
        })
    }

    /* ---------------------------------------------------------------------- */
    /*  Recording API                                                         */
    /* ---------------------------------------------------------------------- */

    public beginRecording(recorderId: string, options?: PowerRecorderOptions): void {
        if (this.recorders.has(recorderId)) {
            return
        }

        const now = Date.now()
        const inst = createRecorder(recorderId, options)
        this.recorders.set(recorderId, inst)

        const quality: RecorderQualityStats = {
            startedAt: now,
            endedAt: null,
            goodSamples: 0,
            badFrames: 0,
            lastGoodSampleAt: null,
            maxGapMs: 0,
        }
        this.recorderQuality.set(recorderId, quality)

        this.deps.events.publish({
            kind: 'recording-started',
            at: now,
            recorderId,
            options,
        })
    }

    public endRecording(recorderId: string): PowerRecordingSummary | null {
        const inst = this.recorders.get(recorderId)
        const quality = this.recorderQuality.get(recorderId)
        if (!inst) return null

        this.recorders.delete(recorderId)
        this.recorderQuality.delete(recorderId)

        const now = Date.now()
        if (quality) {
            quality.endedAt = now
        }

        const summary = inst.finish()

        // If we have quality stats, attach a derived quality block
        if (quality) {
            const intervalSec = this.config.samplingIntervalSec ?? 1
            const intervalMs = Math.max(1, intervalSec * 1000)

            const startedAt = quality.startedAt
            const endedAt = quality.endedAt ?? now
            const durationMs = Math.max(0, endedAt - startedAt)

            const expectedSamples = Math.max(1, Math.round(durationMs / intervalMs))
            const goodSamples = quality.goodSamples
            const badFrames = quality.badFrames

            const goodSampleRatio = goodSamples / expectedSamples
            const badFrameRatio = badFrames / expectedSamples
            const maxGapMs = quality.maxGapMs

            // Simple heuristic verdict:
            //  - good:     dense stream, low bad frame ratio, small gaps
            //  - degraded: usable but noticeable gaps or errors
            //  - poor:     too many gaps or bad frames to trust
            let verdict: 'good' | 'degraded' | 'poor' = 'good'

            if (goodSampleRatio < 0.9 || badFrameRatio > 0.1 || maxGapMs > 10_000) {
                verdict = 'poor'
            } else if (goodSampleRatio < 0.98 || badFrameRatio > 0.02 || maxGapMs > 3_000) {
                verdict = 'degraded'
            }

            ;(summary as any).quality = {
                startedAt,
                endedAt,
                durationMs,
                expectedSamples,
                goodSamples,
                badFrames,
                goodSampleRatio,
                badFrameRatio,
                maxGapMs,
                verdict,
            }
        }

        this.deps.events.publish({
            kind: 'recording-finished',
            at: now,
            recorderId,
            summary,
        })

        return summary
    }

    public cancelRecording(recorderId: string, reason: string): void {
        const inst = this.recorders.get(recorderId)
        if (!inst) return

        this.recorders.delete(recorderId)
        this.recorderQuality.delete(recorderId)

        this.deps.events.publish({
            kind: 'recording-cancelled',
            at: Date.now(),
            recorderId,
            reason,
        })
    }

    /* ---------------------------------------------------------------------- */
    /*  SerialPort wiring                                                     */
    /* ---------------------------------------------------------------------- */

    private async openPort(): Promise<void> {
        if (!this.devicePath) {
            this.deps.events.publish({
                kind: 'recoverable-error',
                at: Date.now(),
                error: 'openPort called without devicePath',
            })
            return
        }

        const path = this.devicePath
        const baudRate = this.deviceBaudRate

        this.state = { phase: 'connecting' }
        this.consecutiveParseFailures = 0
        this.invalidFramesSinceLastGoodSample = 0

        return new Promise<void>((resolve, reject) => {
            const port = new SerialPort({
                path,
                baudRate,
                autoOpen: false,
                dataBits: 8,
                parity: 'none',
                stopBits: 1,
            })

            const onOpen = async () => {
                this.port = port
                this.reconnectAttempts = 0

                this.deps.events.publish({
                    kind: 'meter-device-connected',
                    at: Date.now(),
                    path,
                    baudRate,
                })

                port.on('data', (chunk: Buffer) => {
                    this.handleData(chunk.toString('ascii'))
                })

                port.on('error', (err: Error) => {
                    void this.handlePortError(err)
                })

                port.on('close', () => {
                    void this.handlePortClose()
                })

                try {
                    await this.initializeWattsUpDevice()
                    this.state = { phase: 'streaming' }
                    this.deps.events.publish({
                        kind: 'meter-streaming-started',
                        at: Date.now(),
                    })
                    resolve()
                } catch (err: any) {
                    await this.handlePortError(err instanceof Error ? err : new Error(String(err)))
                    reject(err)
                }
            }

            const onError = async (err: Error) => {
                port.off('open', onOpen)
                port.off('error', onError)
                await this.handlePortOpenError(err)
                reject(err)
            }

            port.once('open', onOpen)
            port.once('error', onError)

            port.open()
        })
    }

    private async closePort(
        reason: 'io-error' | 'explicit-close' | 'unknown' | 'device-lost'
    ): Promise<void> {
        const port = this.port
        this.port = null

        const hadPort = !!port

        if (port && port.isOpen) {
            if (reason === 'explicit-close' || reason === 'unknown') {
                try {
                    await this.writeCommand('#L,W,0;')
                } catch {
                    // ignore
                }
            }

            await new Promise<void>((resolve) => {
                port.close(() => resolve())
            })
        }

        this.state = { phase: 'disconnected' }

        if (hadPort) {
            this.deps.events.publish({
                kind: 'meter-device-disconnected',
                at: Date.now(),
                path: this.devicePath ?? 'unknown',
                reason,
            })
        }
    }

    private async initializeWattsUpDevice(): Promise<void> {
        // 1) Version query
        // 2) Set EXTERNAL (E) logging mode with configured interval (stream frames to host)
        // 3) Set output handling (FULLHANDLING = 2 by default)
        await this.writeCommand('#V,3;')
        await this.sleep(200)

        const intervalSec = this.config.samplingIntervalSec ?? 1

        // IMPORTANT: use "E" (external streaming) so the meter actually sends #d frames.
        const externalModeChar = 'E'
        const modeCmd = `#L,W,3,${externalModeChar},,${intervalSec};`
        await this.writeCommand(modeCmd)
        await this.sleep(200)

        const fullHandling = this.config.fullHandling ?? 2
        const outCmd = `#O,W,1,${fullHandling};`
        await this.writeCommand(outCmd)
        await this.sleep(200)
    }

    private async writeCommand(cmd: string): Promise<void> {
        const port = this.port
        if (!port || !port.isOpen) throw new Error('writeCommand: port not open')

        const wire = cmd + '\r\n'

        await new Promise<void>((resolve, reject) => {
            port.write(wire, (err) => {
                if (err) reject(err)
                else resolve()
            })
        })
    }

    /* ---------------------------------------------------------------------- */
    /*  Data handling                                                         */
    /* ---------------------------------------------------------------------- */

    private handleData(chunk: string): void {
        if (this.state.phase === 'disconnected' || this.state.phase === 'error') {
            this.deps.events.publish({
                kind: 'recoverable-error',
                at: Date.now(),
                error: 'Received data while in invalid state',
            })
            return
        }

        // Debug: log chunk for visibility when enabled
        if (process.env.SERIAL_PM_DEBUG_FRAMES === 'true') {
            console.log('[powermeter:debug] chunk', chunk)
        }

        // Strip NULs at the chunk level so they don't poison splitting/parsing.
        const cleanedChunk = chunk.replace(/\u0000+/g, '')

        this.readBuffer += cleanedChunk
        this.stats.bytesReceived += cleanedChunk.length

        const lines = this.readBuffer.split(/\r?\n/)
        this.readBuffer = lines.pop() ?? ''

        for (const line of lines) {
            // Also strip any trailing NULs that slipped through and then trim.
            const sanitized = line.replace(/\u0000+$/g, '')
            const trimmed = sanitized.trim()
            if (!trimmed) continue

            if (trimmed.startsWith('#d')) {
                // Canonical WattsUp frame:
                //   "#d,-,18,610,1186,545,45,_,_,_,610,_,_,_,_,_,94,_,_,_,_;"
                this.handleDataFrame(trimmed)
            } else {
                const csvParts = trimmed.split(',')

                // Helper: strict "integer-ish" check used for key numeric fields.
                const isIntLike = (value: string | undefined): boolean => {
                    if (value == null) return false
                    const withoutTerminator = value.replace(/;$/, '')
                    if (withoutTerminator === '' || withoutTerminator === '_' || withoutTerminator === '-') {
                        return false
                    }
                    return /^-?\d+$/.test(withoutTerminator)
                }

                const looksLikeBareWattsUpRow = (() => {
                    // A valid frame example:
                    //   "-,18,610,1186,545,45,_,_,_,610,_,_,_,_,_,94,_,_,_,_;"
                    //
                    // When headerless, we expect:
                    //   - A trailing ';'
                    //   - At least ~20 fields
                    //   - Numeric index at [1]
                    //   - Numeric watts/volts/amps at [2],[3],[4] after header injection
                    //     (i.e., original positions [2],[3],[4],[5] in the bare row)
                    if (!trimmed.endsWith(';')) return false
                    if (csvParts.length < 18) return false

                    // index, watts_raw, volts_raw, amps_raw should all be integer-like
                    return (
                        isIntLike(csvParts[1]) && // sample index
                        isIntLike(csvParts[2]) && // watts_raw
                        isIntLike(csvParts[3]) && // volts_raw
                        isIntLike(csvParts[4])    // amps_raw
                    )
                })()

                if (looksLikeBareWattsUpRow) {
                    // Promote a bare data row to a synthetic "#d,..." frame.
                    const synthetic = `#d,${trimmed}`

                    try {
                        this.handleDataFrame(synthetic)
                        continue
                    } catch {
                        // If parsing still fails, fall through and treat as junk.
                    }
                }

                const now = Date.now()

                // Treat very small junk lines as harmless "noise":
                // - still emit meter-unknown-line for observability
                // - but do NOT emit a recoverable-error.
                const isTinyJunk = trimmed.length < 8 || csvParts.length <= 3

                this.deps.events.publish({
                    kind: 'meter-unknown-line',
                    at: now,
                    line: trimmed,
                })

                if (!isTinyJunk) {
                    this.deps.events.publish({
                        kind: 'recoverable-error',
                        at: now,
                        error: `Unknown line from power meter: "${trimmed}"`,
                    })
                }
            }
        }
    }

    private handleDataFrame(line: string): void {
        const now = Date.now()
        const sample = parseWattsUpFrame(line)

        if (!sample) {
            this.consecutiveParseFailures += 1
            this.invalidFramesSinceLastGoodSample += 1

            // Count this as a bad frame for all active recorders
            for (const stats of this.recorderQuality.values()) {
                stats.badFrames += 1
            }

            this.stats.lastErrorAt = now
            this.deps.events.publish({
                kind: 'recoverable-error',
                at: now,
                error: `Failed to parse WattsUp data frame (consecutiveFailures=${this.consecutiveParseFailures})`,
            })

            const lastSampleAt = this.stats.lastSampleAt
            const tooLongSinceGoodSample =
                lastSampleAt != null && now - lastSampleAt > this.parseFailureWindowMs

            const hitConsecutiveThreshold =
                this.consecutiveParseFailures >= this.maxConsecutiveParseFailures

            if (hitConsecutiveThreshold || tooLongSinceGoodSample) {
                const deltaMs = lastSampleAt != null ? now - lastSampleAt : null

                const parts: string[] = []

                if (hitConsecutiveThreshold) {
                    parts.push(
                        `consecutiveFailures=${this.consecutiveParseFailures} >= maxConsecutiveParseFailures=${this.maxConsecutiveParseFailures}`
                    )
                }

                if (tooLongSinceGoodSample && deltaMs != null) {
                    parts.push(
                        `tooLongSinceGoodSample: deltaMs=${deltaMs} > parseFailureWindowMs=${this.parseFailureWindowMs}, invalidFramesSinceLastGoodSample=${this.invalidFramesSinceLastGoodSample}`
                    )
                }

                const reason = parts.join('; ')

                if (this.enableSoftDisconnect) {
                    this.deps.events.publish({
                        kind: 'recoverable-error',
                        at: now,
                        error: `Invalid WattsUp data guardrail tripped (${reason}); treating meter as disconnected (soft disconnect enabled)`,
                    })

                    void this.handlePortError(
                        new Error('Too many invalid WattsUp data frames (soft disconnect)')
                    )
                } else {
                    // Log that we hit guardrails but are intentionally *not* bouncing the port.
                    this.deps.events.publish({
                        kind: 'recoverable-error',
                        at: now,
                        error: `Invalid WattsUp data guardrail tripped (${reason}); soft disconnect disabled, keeping port open`,
                    })
                }
            }

            return
        }

        // ✅ Successfully parsed sample
        this.consecutiveParseFailures = 0
        this.invalidFramesSinceLastGoodSample = 0

        const nowSample = now
        this.stats.totalSamples += 1
        this.stats.lastSampleAt = nowSample

        // Maintain bounded recent sample buffer
        this.recentSamples.push(sample)
        if (this.recentSamples.length > this.config.maxRecentSamples) {
            this.recentSamples.splice(0, this.recentSamples.length - this.config.maxRecentSamples)
        }

        // Feed all active recorders and update their quality stats
        for (const [recorderId, inst] of this.recorders.entries()) {
            inst.addSample(sample)

            const stats = this.recorderQuality.get(recorderId)
            if (!stats) continue

            stats.goodSamples += 1

            if (stats.lastGoodSampleAt != null) {
                const gap = nowSample - stats.lastGoodSampleAt
                if (gap > stats.maxGapMs) {
                    stats.maxGapMs = gap
                }
            }

            stats.lastGoodSampleAt = nowSample
        }

        this.deps.events.publish({
            kind: 'meter-sample',
            at: nowSample,
            sample,
        })
    }

    /* ---------------------------------------------------------------------- */
    /*  Error + reconnect handling                                            */
    /* ---------------------------------------------------------------------- */

    private async handlePortError(err: Error): Promise<void> {
        this.stats.lastErrorAt = Date.now()

        this.deps.events.publish({
            kind: 'recoverable-error',
            at: this.stats.lastErrorAt,
            error: `Serial power meter port error: ${err.message}`,
        })

        await this.closePort('io-error')
        this.state = { phase: 'disconnected' }
        this.consecutiveParseFailures = 0
        this.invalidFramesSinceLastGoodSample = 0

        if (this.config.reconnect.enabled) {
            this.scheduleReconnect()
        } else {
            this.deps.events.publish({
                kind: 'fatal-error',
                at: Date.now(),
                error: 'Serial power meter error and reconnect disabled',
            })
            this.state = { phase: 'error', message: 'Reconnect disabled after IO error' }
        }
    }

    private async handlePortClose(): Promise<void> {
        if (this.state.phase === 'disconnected' || this.state.phase === 'error') return

        this.stats.lastErrorAt = Date.now()

        this.deps.events.publish({
            kind: 'recoverable-error',
            at: this.stats.lastErrorAt,
            error: 'Serial power meter port closed unexpectedly',
        })

        await this.closePort('io-error')
        this.state = { phase: 'disconnected' }
        this.consecutiveParseFailures = 0
        this.invalidFramesSinceLastGoodSample = 0

        if (this.config.reconnect.enabled) {
            this.scheduleReconnect()
        } else {
            this.deps.events.publish({
                kind: 'fatal-error',
                at: Date.now(),
                error: 'Serial power meter port closed and reconnect disabled',
            })
            this.state = { phase: 'error', message: 'Reconnect disabled after port close' }
        }
    }

    private async handlePortOpenError(err: Error): Promise<void> {
        this.stats.lastErrorAt = Date.now()

        this.deps.events.publish({
            kind: 'recoverable-error',
            at: this.stats.lastErrorAt,
            error: `Failed to open power meter serial port: ${err.message}`,
        })

        if (this.config.reconnect.enabled) {
            this.scheduleReconnect()
        } else {
            this.deps.events.publish({
                kind: 'fatal-error',
                at: Date.now(),
                error: 'Failed to open power meter serial port and reconnect disabled',
            })
            this.state = { phase: 'error', message: 'Reconnect disabled after open failure' }
        }
    }

    private scheduleReconnect(): void {
        this.clearReconnectTimer()

        const { baseDelayMs, maxDelayMs } = this.config.reconnect

        this.reconnectAttempts += 1

        const delay = this.computeReconnectDelay(baseDelayMs, maxDelayMs, this.reconnectAttempts)

        this.reconnectTimer = setTimeout(() => {
            void this.tryReconnect()
        }, delay)
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
    }

    private async tryReconnect(): Promise<void> {
        if (this.state.phase === 'error') return
        if (!this.devicePath) return

        try {
            await this.openPort()
        } catch {
            // already logged
        }
    }

    private computeReconnectDelay(
        baseDelayMs: number,
        maxDelayMs: number,
        attempt: number
    ): number {
        if (baseDelayMs <= 0) baseDelayMs = 1000
        if (maxDelayMs < baseDelayMs) maxDelayMs = baseDelayMs

        const exp = Math.pow(2, Math.max(0, attempt - 1))
        let candidate = baseDelayMs * exp

        if (candidate > maxDelayMs) candidate = maxDelayMs
        if (candidate < baseDelayMs) candidate = baseDelayMs

        return candidate
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}