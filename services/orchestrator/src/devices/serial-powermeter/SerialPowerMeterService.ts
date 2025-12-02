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
                : 10

        // ---- Failure window ms (env override with heuristic fallback) -----
        const windowRaw = process.env.SERIAL_PM_PARSE_FAILURE_WINDOW_MS
        const windowNum = windowRaw !== undefined ? Number(windowRaw) : NaN

        if (Number.isFinite(windowNum) && windowNum > 0) {
            this.parseFailureWindowMs = windowNum
        } else {
            // Heuristic: ~2x the time it would take to see
            // maxConsecutiveParseFailures samples, clamped to [10s, 60s].
            const heuristic = intervalSec * 1000 * this.maxConsecutiveParseFailures * 2
            this.parseFailureWindowMs = Math.max(10_000, Math.min(60_000, heuristic))
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
        await this.closePort('explicit-close')
        this.state = { phase: 'disconnected' }
        this.deviceId = null
        this.devicePath = null
        this.consecutiveParseFailures = 0
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

    /**
     * Called by orchestrator / discovery layer when a compatible power meter
     * is identified.
     */
    public async onDeviceIdentified(args: {
        id: string
        path: string
        baudRate?: number
    }): Promise<void> {
        this.deviceId = args.id

        // On macOS, SerialPort.list() typically returns /dev/tty.*,
        // but the recommended node for outgoing serial use is /dev/cu.*.
        // To mimic the working MJS probe, we translate tty → cu here.
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

        // If we are already connected to this exact path, do nothing.
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

    /**
     * Called by orchestrator / discovery layer when a previously identified
     * power meter is lost (USB unplug, etc.).
     */
    public async onDeviceLost(args: { id: string }): Promise<void> {
        if (this.deviceId !== args.id) {
            // Not our current device; ignore.
            return
        }

        this.clearReconnectTimer()
        await this.closePort('device-lost')

        this.state = { phase: 'disconnected' }
        this.consecutiveParseFailures = 0

        this.deps.events.publish({
            kind: 'meter-device-lost',
            at: Date.now(),
            id: args.id,
        })
    }

    /* ---------------------------------------------------------------------- */
    /*  Recording API                                                         */
    /* ---------------------------------------------------------------------- */

    /**
     * Begin a new recording keyed by recorderId.
     * This is intentionally generic: benchmark runs, UI sessions, or
     * any future windowed spans can all be recorders.
     */
    public beginRecording(recorderId: string, options?: PowerRecorderOptions): void {
        if (this.recorders.has(recorderId)) {
            // Idempotent-ish; we could also choose to throw here.
            return
        }

        const now = Date.now()
        const inst = createRecorder(recorderId, options)
        this.recorders.set(recorderId, inst)

        this.deps.events.publish({
            kind: 'recording-started',
            at: now,
            recorderId,
            options,
        })
    }

    /**
     * End an existing recording and return its summary.
     * Returns null if no such recorder existed.
     */
    public endRecording(recorderId: string): PowerRecordingSummary | null {
        const inst = this.recorders.get(recorderId)
        if (!inst) return null

        this.recorders.delete(recorderId)

        const summary = inst.finish()
        const now = Date.now()

        this.deps.events.publish({
            kind: 'recording-finished',
            at: now,
            recorderId,
            summary,
        })

        return summary
    }

    /** Cancel a recording without generating a summary. */
    public cancelRecording(recorderId: string, reason: string): void {
        const inst = this.recorders.get(recorderId)
        if (!inst) return

        this.recorders.delete(recorderId)

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

                // Attach data/error/close handlers only after successful open
                port.on('data', (chunk: Buffer) => {
                    this.handleData(chunk.toString('ascii'))
                })

                port.on('error', (err: Error) => {
                    void this.handlePortError(err)
                })

                // Observe port close events (e.g., USB unplug)
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
            // Try to send stop-logging command on graceful paths
            if (reason === 'explicit-close' || reason === 'unknown') {
                try {
                    await this.writeCommand('#L,W,0;')
                } catch {
                    // Non-fatal; we are closing anyway.
                }
            }

            await new Promise<void>((resolve) => {
                port.close(() => resolve())
            })
        }

        // At this point the port is definitely not open.
        this.state = { phase: 'disconnected' }

        // Always emit a disconnect event if we previously had a port,
        // regardless of whether the OS closed it first.
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
        // Align with the reference Python implementation:
        // 1) Version query
        // 2) Set INTERNAL mode ("I") with configured interval
        // 3) Set output handling (default FULLHANDLING = 2)
        //
        // We keep small sleeps between commands to avoid overrunning the device.
        await this.writeCommand('#V,3;')
        await this.sleep(200)

        const intervalSec = this.config.samplingIntervalSec ?? 1

        // Python example: #L,W,3,I,,<interval>;
        const internalModeChar = 'I'
        const modeCmd = `#L,W,3,${internalModeChar},,${intervalSec};`
        await this.writeCommand(modeCmd)
        await this.sleep(200)

        // Python example uses FULLHANDLING = 2
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
                if (err) {
                    reject(err)
                } else {
                    resolve()
                }
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

        this.readBuffer += chunk
        this.stats.bytesReceived += chunk.length

        const lines = this.readBuffer.split(/\r?\n/)
        this.readBuffer = lines.pop() ?? ''

        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue

            if (trimmed.startsWith('#d')) {
                this.handleDataFrame(trimmed)
            } else if (trimmed.startsWith('#')) {
                this.deps.events.publish({
                    kind: 'meter-control-line',
                    at: Date.now(),
                    line: trimmed,
                })
            } else {
                // Attempt to detect and recover "headerless" WattsUp data frames.
                //
                // The device sometimes appears to output CSV bodies that look
                // like valid #d payloads but without the leading "#d,".
                // When a line:
                //   - is comma-separated
                //   - has at least a handful of fields
                //   - each field is numeric / "_" / "-" (optionally ending with ';')
                // we treat it as a candidate frame body and synthesize a #d header.
                const csvParts = trimmed.split(',')
                const enoughFields = csvParts.length >= 5

                const looksNumericOrPlaceholder = csvParts.every(part => {
                    const withoutTerminator = part.replace(/;$/, '')
                    if (!withoutTerminator) return true // allow empty
                    if (withoutTerminator === '_' || withoutTerminator === '-') return true
                    return /^-?\d+(\.\d+)?$/.test(withoutTerminator)
                })

                if (enoughFields && looksNumericOrPlaceholder && trimmed.endsWith(';')) {
                    const synthetic = `#d,${trimmed}`
                    try {
                        this.handleDataFrame(synthetic)
                        // Treat as successfully handled data; no unknown-line noise.
                        continue
                    } catch {
                        // Fall through to unknown-line handling below.
                    }
                }

                // Unknown/non-# line from the meter:
                //  - Still emit the structured meter-unknown-line event
                //  - Also emit a recoverable-error so downstream logging can
                //    treat this as warning-level noise.
                const now = Date.now()

                this.deps.events.publish({
                    kind: 'meter-unknown-line',
                    at: now,
                    line: trimmed,
                })

                this.deps.events.publish({
                    kind: 'recoverable-error',
                    at: now,
                    error: `Unknown line from power meter: "${trimmed}"`,
                })
            }
        }
    }

    private handleDataFrame(line: string): void {
        const now = Date.now()
        const sample = parseWattsUpFrame(line)

        if (!sample) {
            this.consecutiveParseFailures += 1

            // Strongly worded message so it stands out in logs
            this.stats.lastErrorAt = now
            this.deps.events.publish({
                kind: 'recoverable-error',
                at: now,
                error: `Failed to parse WattsUp data frame (consecutiveFailures=${this.consecutiveParseFailures})`,
            })

            // If we've gone too long without a good sample, or the consecutive
            // failures are excessive, treat this as an effective disconnect and
            // let normal reconnect logic take over.
            const lastSampleAt = this.stats.lastSampleAt
            const tooLongSinceGoodSample =
                lastSampleAt != null && now - lastSampleAt > this.parseFailureWindowMs

            if (
                this.consecutiveParseFailures >= this.maxConsecutiveParseFailures ||
                tooLongSinceGoodSample
            ) {
                this.deps.events.publish({
                    kind: 'recoverable-error',
                    at: now,
                    error: 'Too many invalid WattsUp frames; treating meter as disconnected',
                })

                // This will emit another recoverable-error + meter-device-disconnected
                // and schedule reconnect if enabled.
                void this.handlePortError(
                    new Error('Too many invalid WattsUp data frames (soft disconnect)')
                )
            }

            return
        }

        // ✅ Good sample: reset failure counter.
        this.consecutiveParseFailures = 0

        // --- TEMPORARY DEBUG LOG FOR WATTS / VOLTS / AMPS ---
        try {
            // Adjust these property names if your PowerSample uses different ones.
            // This will safely no-op if sample has extra fields.
            const debugWatts = (sample as any).watts
            const debugVolts = (sample as any).volts
            const debugAmps = (sample as any).amps

            console.log(
                '[powermeter:debug] sample parsed →',
                `watts=${debugWatts}  volts=${debugVolts}  amps=${debugAmps}`
            )
        } catch (err) {
            console.log('[powermeter:debug] failed to inspect PowerSample', err)
        }
        // ------------------------------------------------------

        const nowSample = now
        this.stats.totalSamples += 1
        this.stats.lastSampleAt = nowSample

        // Maintain bounded recent sample buffer
        this.recentSamples.push(sample)
        if (this.recentSamples.length > this.config.maxRecentSamples) {
            this.recentSamples.splice(0, this.recentSamples.length - this.config.maxRecentSamples)
        }

        // Feed all active recorders
        for (const inst of this.recorders.values()) {
            inst.addSample(sample)
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

    // Handle the port closing (e.g., device unplug) even if there was no explicit error
    private async handlePortClose(): Promise<void> {
        // Avoid double-handling if we already marked an error / disconnect
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

    /**
     * Schedule a reconnect attempt with exponential backoff.
     *
     * NOTE: When reconnect.enabled === true, retries are effectively infinite
     * for the lifetime of the process. maxAttempts is ignored for exhaustion
     * purposes and only used indirectly to shape logging / expectations if
     * you want, but we never transition to a "reconnect exhausted" fatal state.
     */
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
            // openPort already published errors and may schedule further reconnect attempts.
        }
    }

    /**
     * Exponential backoff:
     *   delay = baseDelayMs * 2^(attempt - 1), clamped between baseDelayMs and maxDelayMs.
     */
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

    /* ---------------------------------------------------------------------- */
    /*  Small helpers                                                         */
    /* ---------------------------------------------------------------------- */

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}