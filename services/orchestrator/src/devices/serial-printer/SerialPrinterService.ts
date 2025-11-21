// services/orchestrator/src/core/devices/serial-printer/SerialPrinterService.ts

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

    constructor(config: SerialPrinterConfig, deps: SerialPrinterServiceDeps) {
        this.config = config
        this.deps = deps
    }

    /* ---------------------------------------------------------------------- */
    /*  Public API                                                            */
    /* ---------------------------------------------------------------------- */

    public async start(): Promise<void> {
        // Initial connect; errors here are considered recoverable if reconnect is enabled.
        await this.openPort()
    }

    public async stop(): Promise<void> {
        this.clearIdleTimer()
        this.clearReconnectTimer()
        await this.closePort('explicit-close')
        this.state = 'disconnected'
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
    /*  SerialPort wiring                                                     */
    /* ---------------------------------------------------------------------- */

    private async openPort(): Promise<void> {
        const { portPath, baudRate } = this.config

        return new Promise<void>((resolve, reject) => {
            const port = new SerialPort({
                path: portPath,
                baudRate,
                autoOpen: false,
                dataBits: 8,
                parity: 'none',
                stopBits: 1,
                xon: true,
                xoff: true,
            })

            const onOpen = () => {
                this.port = port
                this.state = 'idle'
                this.reconnectAttempts = 0

                this.deps.events.publish({
                    kind: 'device-connected',
                    at: Date.now(),
                    portPath,
                })

                // Attach data/error handlers only after successful open
                port.on('data', (chunk: Buffer) => {
                    this.handleData(chunk.toString('utf8'))
                })

                port.on('error', (err: Error) => {
                    this.handlePortError(err)
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
            portPath: this.config.portPath,
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

        if (this.state === 'idle') {
            this.state = 'receiving'
        }

        this.buffer += chunk
        this.stats.bytesReceived += chunk.length

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
            }
            return
        }

        const now = Date.now()
        const jobId = this.nextJobId++

        const rawNormalized = this.config.lineEnding === '\n'
            ? this.buffer
            : this.buffer.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')

        const preview = buildPreview(rawNormalized, DEFAULT_PREVIEW_CHARS)

        const job: SerialPrinterJob = {
            id: jobId,
            createdAt: now,
            completedAt: now,
            raw: rawNormalized,
            preview,
        }

        this.buffer = ''

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

        if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
            this.deps.events.publish({
                kind: 'fatal-error',
                at: Date.now(),
                error: 'Serial printer reconnect attempts exhausted',
            })
            this.state = 'error'
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