/* eslint-disable no-console */

import {
    spawn,
    type ChildProcessByStdio,
} from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

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
    createRecorder,
    type RecorderInstance,
    parseWattsUpCsvRow,
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
    /** Number of parse failures / bad rows while this recorder was active. */
    badFrames: number
    /** Timestamp of last good sample routed to this recorder. */
    lastGoodSampleAt: number | null
    /** Largest gap between successive good samples while active (ms). */
    maxGapMs: number
}

/**
 * SerialPowerMeterService (child-process / wattsup-backed)
 *
 * - Serial discovery is handled externally via SerialDiscoveryService.
 * - When a power meter device is identified, we start the `wattsup` binary
 *   as a child process, pointing it at the discovered device path.
 * - We parse CSV output lines into PowerSample objects.
 * - We maintain recent samples, stats, and recorder instances exactly as before.
 * - We do NOT talk to the serial port directly anymore.
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

    /** Child process running the wattsup binary. */
    private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null
    private reconnectAttempts = 0

    // Chunk → line buffering of stdout:
    private readBuffer = ''

    // For gap warnings (only warn once per gap episode):
    private gapWarningEmitted = false

    private reconnectTimer: NodeJS.Timeout | null = null

    private headerFields: string[] | null = null

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
     * Whether to perform a "soft restart" (stop + restart child) when
     * the gap-monitor watchdog observes a long absence of samples.
     *
     * Controlled by SERIAL_PM_ENABLE_SOFT_DISCONNECT; defaults to false so
     * benchmarks rely on per-run quality rather than process churn.
     */
    private readonly enableSoftRestart: boolean

    /**
     * Expected interval between samples in ms, derived from samplingIntervalSec.
     * Used for logging / observability and the gap-monitor thresholds.
     */
    private readonly expectedSampleIntervalMs: number

    /**
     * Background timer used to detect "missing" samples relative to the expected
     * interval and emit warning logs (when SERIAL_PM_DEBUG_FRAMES is enabled).
     */
    private gapMonitorTimer: NodeJS.Timeout | null = null

    /**
     * Path to the wattsup binary. Defaults to "wattsup" in PATH.
     * Can be overridden via SERIAL_PM_WATTSUP_PATH.
     */
    private readonly wattsupBinaryPath: string

    constructor(config: PowerMeterConfig, deps: SerialPowerMeterServiceDeps) {
        this.config = config
        this.deps = deps

        const intervalSec = this.config.samplingIntervalSec ?? 1
        this.expectedSampleIntervalMs = Math.max(1, intervalSec * 1000)

        // Soft restart enable flag (watchdog-based).
        const softRaw = process.env.SERIAL_PM_ENABLE_SOFT_DISCONNECT
        if (softRaw == null || softRaw === '') {
            this.enableSoftRestart = false
        } else {
            const v = softRaw.toLowerCase()
            this.enableSoftRestart = v === 'true' || v === '1' || v === 'yes'
        }

        this.wattsupBinaryPath =
            process.env.SERIAL_PM_WATTSUP_PATH && process.env.SERIAL_PM_WATTSUP_PATH.trim() !== ''
                ? process.env.SERIAL_PM_WATTSUP_PATH.trim()
                : 'wattsup'
    }

    /* ---------------------------------------------------------------------- */
    /*  Public API                                                            */
    /* ---------------------------------------------------------------------- */

    /** For symmetry with other services; may remain a no-op. */
    public async start(): Promise<void> {
        // Intentionally empty for now; device attach is driven by discovery.
    }

    public async stop(): Promise<void> {
        this.clearReconnectTimer()
        this.stopGapMonitor()
        this.recorders.clear()
        this.recorderQuality.clear()
        await this.stopChild('explicit-close')

        this.state = { phase: 'disconnected' }
        this.deviceId = null
        this.devicePath = null
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
        // baudRate is irrelevant here; wattsup handles serial details.
        this.deviceId = args.id
        this.devicePath = args.path

        this.deps.events.publish({
            kind: 'meter-device-identified',
            at: Date.now(),
            id: args.id,
            path: args.path,
            baudRate: args.baudRate ?? 115200,
        })

        // If we already have a running child for this path, do nothing.
        if (this.child && this.state.phase === 'streaming') {
            return
        }

        await this.startChild()
    }

    public async onDeviceLost(args: { id: string }): Promise<void> {
        if (this.deviceId !== args.id) return

        this.clearReconnectTimer()
        this.stopGapMonitor()
        await this.stopChild('device-lost')

        this.state = { phase: 'disconnected' }

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

        // Attach per-recording quality metrics when available.
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
    /*  Child-process wiring (wattsup binary)                                 */
    /* ---------------------------------------------------------------------- */

    private async startChild(): Promise<void> {
        if (!this.devicePath) {
            this.deps.events.publish({
                kind: 'recoverable-error',
                at: Date.now(),
                error: 'startChild called without devicePath',
            })
            return
        }

        if (this.child) {
            await this.stopChild('unknown')
        }

        this.state = { phase: 'connecting' }
        this.headerFields = null
        this.readBuffer = ''
        this.gapWarningEmitted = false

        const args = [
            this.devicePath,
            '-r',
            '-s',
        ]

        const child = spawn(this.wattsupBinaryPath, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
        })

        this.child = child

        const now = Date.now()
        this.deps.events.publish({
            kind: 'meter-device-connected',
            at: now,
            path: this.devicePath,
            baudRate: 0, // not meaningful here
        })

        child.stdout.on('data', (chunk: Buffer) => {
            // Track raw bytes received for stats/diagnostics.
            this.stats.bytesReceived += chunk.length
            this.handleStdoutData(chunk.toString('utf8'))
        })

        child.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8').trim()
            if (!text) return

            this.stats.lastErrorAt = Date.now()
            this.deps.events.publish({
                kind: 'recoverable-error',
                at: this.stats.lastErrorAt,
                error: `wattsup stderr: ${text}`,
            })
        })

        child.on('error', (err: Error) => {
            void this.handleChildError(err)
        })

        child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
            void this.handleChildExit(code, signal)
        })

        // Once child is started, we consider ourselves "streaming" (headers will come first).
        this.state = { phase: 'streaming' }
        this.deps.events.publish({
            kind: 'meter-streaming-started',
            at: Date.now(),
        })

        this.startGapMonitor()
    }

    private async stopChild(
        reason: 'io-error' | 'explicit-close' | 'unknown' | 'device-lost'
    ): Promise<void> {
        const child = this.child
        this.child = null

        const hadChild = !!child

        if (child) {
            try {
                child.removeAllListeners('exit')
                child.kill('SIGTERM')
            } catch {
                // ignore
            }
        }

        this.state = { phase: 'disconnected' }

        if (hadChild) {
            this.deps.events.publish({
                kind: 'meter-device-disconnected',
                at: Date.now(),
                path: this.devicePath ?? 'unknown',
                reason,
            })
        }
    }

    private async handleChildError(err: Error): Promise<void> {
        this.stats.lastErrorAt = Date.now()

        this.deps.events.publish({
            kind: 'recoverable-error',
            at: this.stats.lastErrorAt,
            error: `wattsup child error: ${err.message}`,
        })

        await this.stopChild('io-error')
        this.state = { phase: 'disconnected' }

        if (this.config.reconnect.enabled) {
            this.scheduleReconnect()
        } else {
            this.deps.events.publish({
                kind: 'fatal-error',
                at: Date.now(),
                error: 'wattsup child error and reconnect disabled',
            })
            this.state = { phase: 'error', message: 'Reconnect disabled after child error' }
        }
    }

    private async handleChildExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
        // If we already reset to disconnected or error, ignore duplicate exits.
        if (this.state.phase === 'disconnected' || this.state.phase === 'error') return

        this.stats.lastErrorAt = Date.now()

        this.deps.events.publish({
            kind: 'recoverable-error',
            at: this.stats.lastErrorAt,
            error: `wattsup child exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        })

        await this.stopChild('io-error')
        this.state = { phase: 'disconnected' }

        if (this.config.reconnect.enabled) {
            this.scheduleReconnect()
        } else {
            this.deps.events.publish({
                kind: 'fatal-error',
                at: Date.now(),
                error: 'wattsup child exited and reconnect disabled',
            })
            this.state = { phase: 'error', message: 'Reconnect disabled after child exit' }
        }
    }

    /* ---------------------------------------------------------------------- */
    /*  CSV data handling                                                     */
    /* ---------------------------------------------------------------------- */

    private handleStdoutData(chunk: string): void {
        // Child process should never be feeding us while "disconnected" or "error",
        // but if it does, treat that as a recoverable error and ignore.
        if (this.state.phase === 'disconnected' || this.state.phase === 'error') {
            this.deps.events.publish({
                kind: 'recoverable-error',
                at: Date.now(),
                error: 'Received wattsup stdout data while in invalid state',
            })
            return
        }

        // Accumulate into a simple line buffer.
        this.readBuffer += chunk
        const lines = this.readBuffer.split(/\r?\n/)
        this.readBuffer = lines.pop() ?? ''

        for (const rawLine of lines) {
            const trimmed = rawLine.trim()
            if (!trimmed) continue

            // Header line (first line from wattsup) – capture field order.
            // Example:
            //   W, V, A, WH, Cost, WH/Mo, Cost/Mo, Wmax, Vmax, Amax, ...
            if (/^\s*W\s*,\s*V\s*,\s*A\b/i.test(trimmed)) {
                this.headerFields = trimmed.split(',').map(h => h.trim())

                this.deps.events.publish({
                    kind: 'meter-control-line',
                    at: Date.now(),
                    line: trimmed,
                })

                continue
            }

            if (process.env.SERIAL_PM_DEBUG_FRAMES === 'true') {
                console.log(
                    `[powermeter:debug] ${new Date().toISOString()} csv row`,
                    JSON.stringify(trimmed)
                )
            }

            // Use the shared CSV parser from utils.ts, which matches the
            // wattsup CLI field ordering you showed:
            // W, V, A, WH, Cost, WH/Mo, Cost/Mo, Wmax, ...
            const sample = parseWattsUpCsvRow(trimmed)
            if (!sample) {
                // Single-row parse failure; logged for observability only.
                this.stats.lastErrorAt = Date.now()

                this.deps.events.publish({
                    kind: 'recoverable-error',
                    at: this.stats.lastErrorAt,
                    error: `Failed to parse wattsup CSV row: "${trimmed}"`,
                })

                this.deps.events.publish({
                    kind: 'meter-unknown-line',
                    at: this.stats.lastErrorAt,
                    line: trimmed,
                })

                // Count as a bad frame for any active recorders.
                for (const stats of this.recorderQuality.values()) {
                    stats.badFrames += 1
                }
                continue
            }

            // ✅ Successfully parsed sample – reset watchdog warning state.
            this.gapWarningEmitted = false

            const nowSample = Date.now()
            this.stats.totalSamples += 1
            this.stats.lastSampleAt = nowSample

            // Maintain bounded recent samples.
            this.recentSamples.push(sample)
            if (this.recentSamples.length > this.config.maxRecentSamples) {
                this.recentSamples.splice(
                    0,
                    this.recentSamples.length - this.config.maxRecentSamples
                )
            }

            // Feed all active recorders and update their quality stats.
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
    }

    /* ---------------------------------------------------------------------- */
    /*  Reconnect + gap monitor                                               */
    /* ---------------------------------------------------------------------- */

    private scheduleReconnect(): void {
        this.clearReconnectTimer()

        const { baseDelayMs, maxDelayMs, maxAttempts } = this.config.reconnect

        if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
            this.deps.events.publish({
                kind: 'fatal-error',
                at: Date.now(),
                error: 'wattsup child reconnect attempts exhausted',
            })
            this.state = {
                phase: 'error',
                message: 'Reconnect attempts exhausted',
            }
            return
        }

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
            await this.startChild()
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

    private startGapMonitor(): void {
        if (this.gapMonitorTimer) return

        const warnThresholdMs = 3_000  // 3 seconds
        const restartThresholdMs = 6_000 // 6 seconds

        // Check every ~1s, but not faster than 500ms.
        const tickMs = Math.max(500, this.expectedSampleIntervalMs)

        this.gapMonitorTimer = setInterval(() => {
            // Only emit logs when frame debug is enabled; you can relax this if you
            // want the warnings regardless of the debug flag.
            if (process.env.SERIAL_PM_DEBUG_FRAMES !== 'true') return

            // If we don't have any sample yet, there's nothing meaningful to say.
            const last = this.stats.lastSampleAt
            if (last == null) return

            const now = Date.now()
            const ageMs = now - last

            // Below warning threshold: all good.
            if (ageMs < warnThresholdMs) return

            // Between 3s and 6s: warn once per gap episode.
            if (ageMs >= warnThresholdMs && ageMs < restartThresholdMs) {
                if (!this.gapWarningEmitted) {
                    this.gapWarningEmitted = true

                    console.warn(
                        `[powermeter:warn] ${new Date().toISOString()} ` +
                            `no wattsup sample received for ${ageMs}ms (>= ${warnThresholdMs}ms); ` +
                            `expecting data approximately every ${this.expectedSampleIntervalMs}ms`
                    )

                    this.deps.events.publish({
                        kind: 'recoverable-error',
                        at: now,
                        error: `No wattsup sample received for ${ageMs}ms (>= ${warnThresholdMs}ms)`,
                    })
                }

                return
            }

            // ≥ 6s: trigger soft restart if enabled.
            if (ageMs >= restartThresholdMs && this.enableSoftRestart) {
                console.warn(
                    `[powermeter:warn] ${new Date().toISOString()} ` +
                        `no wattsup sample received for ${ageMs}ms (>= ${restartThresholdMs}ms); ` +
                        `triggering soft restart of wattsup child process`
                )

                // Let the existing child-error handler deal with restart semantics.
                void this.handleChildError(
                    new Error(
                        `No wattsup samples for ${ageMs}ms (>= ${restartThresholdMs}ms); soft restart`
                    )
                )
            }
        }, tickMs)
    }

    private stopGapMonitor(): void {
        if (this.gapMonitorTimer) {
            clearInterval(this.gapMonitorTimer)
            this.gapMonitorTimer = null
        }
    }
}