// services/orchestrator/src/core/adapters/serial-printer/SerialPrinterService.ts

import { SerialPort } from 'serialport'
import {
    type SerialPrinterConfig,
    type SerialPrinterEventSink,
    type SerialPrinterJob,
    type SerialPrinterStats,
    type SerialPrinterState,
} from './types.js'
import {
    buildPreview,
    DEFAULT_PREVIEW_CHARS,
} from './utils.js'

interface SerialPrinterServiceDeps {
    events: SerialPrinterEventSink
    // Optionally add logger or metrics later without tying to specific libs
    // log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void
}

/**
 * SerialPrinterService
 *
 * Discovery is driven externally (SerialDiscoveryService via serial plugin).
 * The orchestrator is expected to:
 *   - Call onDeviceIdentified(...) when a serial printer is detected.
 *   - Call onDeviceLost(...) when that device disappears.
 *
 * This mirrors the lifecycle of SerialPowerMeterService and works on both macOS
 * and Linux. On macOS, we translate /dev/tty.* → /dev/cu.* for outgoing use.
 */
export class SerialPrinterService {
    private readonly config: SerialPrinterConfig
    private readonly deps: SerialPrinterServiceDeps

    private state: SerialPrinterState = 'disconnected'
    private stats: SerialPrinterStats = {
        totalJobs: 0,
        bytesReceived: 0,
        lastJobAt: null,
        lastErrorAt: null,
    }

    private port: SerialPort | null = null
    private buffer = ''
    private idleTimer: NodeJS.Timeout | null = null

    private queue: SerialPrinterJob[] = []
    private nextJobId = 1

    private reconnectAttempts = 0
    private reconnectTimer: NodeJS.Timeout | null = null

    /** Discovery-driven device identity */
    private deviceId: string | null = null
    private devicePath: string | null = null
    private deviceBaudRate: number

    /** Tracks the in-progress job (from first byte until idle flush). */
    private currentJobId: number | null = null
    private currentJobStartedAt: number | null = null

    constructor(config: SerialPrinterConfig, deps: SerialPrinterServiceDeps) {
        this.config = config
        this.deps = deps
        // Use config baud as default; discovery may override per-device
        this.deviceBaudRate = config.baudRate
    }

    /* ---------------------------------------------------------------------- */
    /*  Public API                                                            */
    /* ---------------------------------------------------------------------- */

    /**
     * For symmetry with other services; actual attach is discovery-driven.
     */
    public async start(): Promise<void> {
        // No-op: we connect only when onDeviceIdentified is called.
    }

    public async stop(): Promise<void> {
        this.clearIdleTimer()
        this.clearReconnectTimer()
        await this.closePort('explicit-close')
        this.state = 'disconnected'
        this.deviceId = null
        this.devicePath = null
        this.currentJobId = null
        this.currentJobStartedAt = null
    }

    /** Current state for observability. */
    public getState(): SerialPrinterState {
        return this.state
    }

    /** Lightweight stats for dashboards/logs. */
    public getStats(): SerialPrinterStats {
        return { ...this.stats }
    }

    /** Snapshot of current queue (copy). */
    public getQueue(): SerialPrinterJob[] {
        return this.queue.map(job => ({ ...job }))
    }

    /** FIFO dequeue: returns next job or null if none. */
    public getNextJob(): SerialPrinterJob | null {
        if (this.queue.length === 0) return null
        const job = this.queue.shift()
        if (!job) return null
        if (this.queue.length === 0 && this.state === 'queued') {
            this.state = 'idle'
        }
        return job
    }

    /** Clear all pending jobs (e.g., when resetting the bench run). */
    public clearQueue(): void {
        this.queue = []
        if (this.state === 'queued') {
            this.state = 'idle'
        }
    }

    /* ---------------------------------------------------------------------- */
    /*  Discovery-driven lifecycle                                            */
    /* ---------------------------------------------------------------------- */

    /**
     * Called by orchestrator / discovery layer when a compatible printer
     * is identified (kind === "serial.printer").
     *
     * Cross-platform note:
     *  - On macOS, SerialPort.list() typically returns /dev/tty.*, but the
     *    recommended node for outgoing use is /dev/cu.*. We mirror the
     *    power-meter service behavior by translating tty → cu.
     *  - On Linux, we leave the path as-is (e.g. /dev/ttyUSB0).
     */
    public async onDeviceIdentified(args: {
        id: string
        path: string
        baudRate?: number
    }): Promise<void> {
        this.deviceId = args.id

        let effectivePath = args.path
        if (effectivePath.startsWith('/dev/tty.')) {
            const cuPath = '/dev/cu.' + effectivePath.slice('/dev/tty.'.length)
            effectivePath = cuPath
        }

        this.devicePath = effectivePath
        this.deviceBaudRate = args.baudRate ?? this.config.baudRate

        // If we are already connected to this exact path and in a healthy state, do nothing.
        if (
            this.port &&
            this.port.isOpen &&
            this.devicePath === effectivePath &&
            this.state !== 'disconnected' &&
            this.state !== 'error'
        ) {
            return
        }

        await this.openPort()
    }

    /**
     * Called by orchestrator / discovery layer when a previously identified
     * printer is lost (USB unplug, etc.).
     */
    public async onDeviceLost(args: { id: string }): Promise<void> {
        if (this.deviceId !== args.id) {
            // Not our current device; ignore.
            return
        }

        this.clearReconnectTimer()
        await this.closePort('unknown')

        this.state = 'disconnected'
        this.deviceId = null
        this.devicePath = null
        this.currentJobId = null
        this.currentJobStartedAt = null
    }

    /* ---------------------------------------------------------------------- */
    /*  SerialPort wiring                                                     */
    /* ---------------------------------------------------------------------- */

    private async openPort(): Promise<void> {
        const pathFromDiscovery = this.devicePath
        const fallbackPath = this.config.portPath
        const path = pathFromDiscovery || fallbackPath

        if (!path) {
            this.deps.events.publish({
                kind: 'recoverable-error',
                at: Date.now(),
                error:
                    'openPort called without devicePath (no discovery path and no configured portPath)',
            })
            this.state = 'disconnected'
            return
        }

        const baudRate = this.deviceBaudRate || this.config.baudRate

        // Basic cross-platform heuristics:
        // - macOS has historically behaved well with software flow control enabled.
        // - On Linux/others, we disable XON/XOFF to avoid driver-specific
        //   line-discipline quirks that can affect buffering/burst shape.
        const isMac = process.platform === 'darwin'

        return new Promise<void>((resolve, reject) => {
            const port = new SerialPort({
                path,
                baudRate,
                autoOpen: false,
                dataBits: 8,
                parity: 'none',
                stopBits: 1,
                xon: isMac,
                xoff: isMac,
            })

            const onOpen = () => {
                this.port = port
                this.state = 'idle'
                this.reconnectAttempts = 0

                this.deps.events.publish({
                    kind: 'device-connected',
                    at: Date.now(),
                    portPath: path,
                })

                // Attach data/error handlers only after successful open
                port.on('data', (chunk: Buffer) => {
                    // Win9x RAW/text output is byte-oriented; use ASCII to avoid
                    // any multibyte UTF-8 surprises and to mirror the power meter.
                    this.handleData(chunk.toString('ascii'))
                })

                port.on('error', (err: Error) => {
                    void this.handlePortError(err)
                })

                // 🔌 Explicit handler for unexpected close (USB yank, etc.)
                port.on('close', () => {
                    void this.handlePortClose()
                })

                resolve()
            }

            const onError = (err: Error) => {
                port.off('open', onOpen)
                port.off('error', onError)
                this.handlePortOpenError(err)
                reject(err)
            }

            port.once('open', onOpen)
            port.once('error', onError)

            port.open()
        })
    }

    private async closePort(
        reason: 'io-error' | 'explicit-close' | 'unknown'
    ): Promise<void> {
        const port = this.port
        this.port = null

        if (!port || !port.isOpen) {
            this.state = 'disconnected'
            return
        }

        await new Promise<void>((resolve) => {
            port.close(() => resolve())
        })

        this.state = 'disconnected'

        this.deps.events.publish({
            kind: 'device-disconnected',
            at: Date.now(),
            portPath: this.devicePath ?? this.config.portPath,
            reason,
        })
    }

    /* ---------------------------------------------------------------------- */
    /*  Data & job lifecycle                                                  */
    /* ---------------------------------------------------------------------- */

    private handleData(chunk: string): void {
        if (this.state === 'disconnected' || this.state === 'error') {
            // Data while in these states is unexpected; treat as recoverable error.
            this.deps.events.publish({
                kind: 'recoverable-error',
                at: Date.now(),
                error: 'Received data while in invalid state',
            })
            return
        }

        const now = Date.now()

        // First byte for a new job: allocate id + mark start, emit job-started.
        // IMPORTANT: treat both 'idle' and 'queued' as "ready for a new job"
        // because the physical printer can start printing again even if we
        // still have completed jobs sitting in our queue.
        if (this.state === 'idle' || this.state === 'queued') {
            const jobId = this.nextJobId++

            this.state = 'receiving'
            this.currentJobId = jobId
            this.currentJobStartedAt = now

            this.deps.events.publish({
                kind: 'job-started',
                at: now,
                jobId,
                createdAt: now,
            })
        }

        // Failsafe: if we somehow ended up in receiving without a jobId, create one.
        if (this.state === 'receiving' && this.currentJobId == null) {
            const jobId = this.nextJobId++
            this.currentJobId = jobId
            this.currentJobStartedAt = now

            this.deps.events.publish({
                kind: 'job-started',
                at: now,
                jobId,
                createdAt: now,
            })
        }

        this.buffer += chunk
        const size = chunk.length
        this.stats.bytesReceived += size

        // Emit streaming chunk for live UI.
        if (this.currentJobId != null && size > 0) {
            this.deps.events.publish({
                kind: 'job-chunk',
                at: now,
                jobId: this.currentJobId,
                text: chunk,
                bytes: size,
            })
        }

        // Reset idle timer: any new data extends the job
        this.scheduleIdleFlush()
    }

    private scheduleIdleFlush(): void {
        this.clearIdleTimer()
        if (!this.config.idleFlushMs || this.config.idleFlushMs <= 0) return

        this.idleTimer = setTimeout(() => {
            this.finalizeJob()
        }, this.config.idleFlushMs)
    }

    private clearIdleTimer(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer)
            this.idleTimer = null
        }
    }

    private finalizeJob(): void {
        this.clearIdleTimer()
        if (this.buffer.length === 0) {
            // Nothing accumulated; if we were in receiving, go back to idle.
            if (this.state === 'receiving') {
                this.state = 'idle'
                this.currentJobId = null
                this.currentJobStartedAt = null
            }
            return
        }

        const now = Date.now()

        // If somehow we never saw a job-start (shouldn’t happen), fall back.
        const jobId = this.currentJobId ?? this.nextJobId++
        const createdAt = this.currentJobStartedAt ?? now

        const rawNormalized =
            this.config.lineEnding === '\n'
                ? this.buffer
                : this.buffer.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')

        const preview = buildPreview(rawNormalized, DEFAULT_PREVIEW_CHARS)

        const job: SerialPrinterJob = {
            id: jobId,
            createdAt,
            completedAt: now,
            raw: rawNormalized,
            preview,
        }

        // 🔍 DEBUG: log the full raw job so we can verify completeness.
        // This will be noisy, but it's intentionally "messy" for debugging.
        // You can search for "SERIAL PRINTER JOB RAW" in the orchestrator logs.
        // Length check helps compare with what Windows 98 sends.
        // If this matches your Notepad doc, backend capture is good.
        // console.log('================= SERIAL PRINTER JOB RAW START =================')
        // console.log(`Job ID: ${jobId}`)
        // console.log(`Raw length (chars): ${job.raw.length}`)
        // console.log(job.raw)
        // console.log('================== SERIAL PRINTER JOB RAW END ==================')

        this.buffer = ''
        this.currentJobId = null
        this.currentJobStartedAt = null

        // Enqueue with bounded capacity
        this.queue.push(job)
        if (this.queue.length > this.config.maxQueuedJobs) {
            this.queue.shift()
        }

        this.stats.totalJobs += 1
        this.stats.lastJobAt = now
        this.state = this.queue.length > 0 ? 'queued' : 'idle'

        this.deps.events.publish({
            kind: 'job-completed',
            at: now,
            job,
        })
    }

    /* ---------------------------------------------------------------------- */
    /*  Error + reconnect handling                                            */
    /* ---------------------------------------------------------------------- */

    /** Handle unexpected port close (e.g., device unplugged) */
    private async handlePortClose(): Promise<void> {
        // If we're already in a terminal state from our own close(), ignore.
        if (this.state === 'disconnected' || this.state === 'error') {
            return
        }

        this.stats.lastErrorAt = Date.now()

        this.deps.events.publish({
            kind: 'recoverable-error',
            at: this.stats.lastErrorAt,
            error: 'Serial printer port closed unexpectedly',
        })

        // Treat as I/O failure and attempt reconnect if enabled.
        await this.closePort('io-error')
        this.state = 'disconnected'
        this.currentJobId = null
        this.currentJobStartedAt = null
        this.buffer = ''

        if (this.config.reconnect.enabled) {
            this.scheduleReconnect()
        } else {
            this.deps.events.publish({
                kind: 'fatal-error',
                at: Date.now(),
                error: 'Serial printer port closed and reconnect disabled',
            })
            this.state = 'error'
        }
    }

    private async handlePortError(err: Error): Promise<void> {
        this.stats.lastErrorAt = Date.now()

        this.deps.events.publish({
            kind: 'recoverable-error',
            at: this.stats.lastErrorAt,
            error: `Serial port error: ${err.message}`,
        })

        // Close and attempt reconnect if configured.
        await this.closePort('io-error')
        this.state = 'disconnected'
        this.currentJobId = null
        this.currentJobStartedAt = null
        this.buffer = ''

        if (this.config.reconnect.enabled) {
            this.scheduleReconnect()
        } else {
            // Reconnect disabled => escalate to fatal.
            this.deps.events.publish({
                kind: 'fatal-error',
                at: Date.now(),
                error: 'Serial port error and reconnect disabled',
            })
            this.state = 'error'
        }
    }

    private handlePortOpenError(err: Error): void {
        this.stats.lastErrorAt = Date.now()

        this.deps.events.publish({
            kind: 'recoverable-error',
            at: this.stats.lastErrorAt,
            error: `Failed to open serial port: ${err.message}`,
        })

        if (this.config.reconnect.enabled) {
            this.scheduleReconnect()
        } else {
            this.deps.events.publish({
                kind: 'fatal-error',
                at: Date.now(),
                error: 'Failed to open serial port and reconnect disabled',
            })
            this.state = 'error'
        }
    }

    private scheduleReconnect(): void {
        this.clearReconnectTimer()

        const { maxAttempts, baseDelayMs, maxDelayMs } = this.config.reconnect

        // NOTE:
        // Per requirements, the serial printer is critical only *during*
        // benchmarking. Until benchmark state is wired in here, we treat
        // printer disconnects as *always recoverable* and keep retrying
        // indefinitely whenever reconnect.enabled=true.
        //
        // So:
        //   - maxAttempts is *ignored* for now (acts as infinite retry)
        //   - we never escalate to fatal here based on attempts alone
        //
        // Once benchmark wiring exists, this is the hook where we can
        // differentiate:
        //   - non-benchmarking: infinite retry
        //   - benchmarking: emit "benchmark invalidated" and possibly stop.
        this.reconnectAttempts += 1

        const delay = this.computeReconnectDelay(
            baseDelayMs,
            maxDelayMs,
            this.reconnectAttempts
        )

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
        if (this.state === 'error') return

        try {
            await this.openPort()
        } catch {
            // openPort already emitted errors and scheduled further reconnect if appropriate
        }
    }

    private computeReconnectDelay(
        baseDelayMs: number,
        maxDelayMs: number,
        attempt: number
    ): number {
        // Simple linear-ish backoff; we can refine to exponential w/ jitter later.
        const candidate = baseDelayMs * attempt
        if (candidate > maxDelayMs) return maxDelayMs
        if (candidate < baseDelayMs) return baseDelayMs
        return candidate
    }
}