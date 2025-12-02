// services/orchestrator/src/core/adapters/serial-printer/SerialPrinterService.ts

import { SerialPort } from 'serialport'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
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

    /**
     * Per-job diagnostics to help understand corruption / truncation:
     * - bytesReceived snapshot at job start
     * - how many chunks we saw for the job
     */
    private currentJobBytesReceivedAtStart: number | null = null
    private currentJobChunkCount = 0

    /**
     * Global chunk index so we can reason about ordering and gaps.
     */
    private globalChunkIndex = 0

    /**
     * Verbose debug logging can be enabled with:
     *   SERIAL_PRINTER_DEBUG=1
     */
    private readonly debugEnabled =
        process.env.SERIAL_PRINTER_DEBUG === '1' ||
        process.env.SERIAL_PRINTER_DEBUG === 'true'

    constructor(config: SerialPrinterConfig, deps: SerialPrinterServiceDeps) {
        this.config = config
        this.deps = deps
        // Use config baud as default; discovery may override per-device
        this.deviceBaudRate = config.baudRate
    }

    /* ---------------------------------------------------------------------- */
    /*  Debug helpers                                                         */
    /* ---------------------------------------------------------------------- */

    private debug(msg: string, meta: Record<string, unknown> = {}): void {
        if (!this.debugEnabled) return

        const safeMeta = {
            state: this.state,
            devicePath: this.devicePath,
            baudRate: this.deviceBaudRate,
            bufferLen: this.buffer.length,
            currentJobId: this.currentJobId,
            queueLen: this.queue.length,
            bytesReceived: this.stats.bytesReceived,
            ...meta,
        }

        // eslint-disable-next-line no-console
        console.log(
            '[SerialPrinterService DEBUG]',
            msg,
            JSON.stringify(safeMeta)
        )
    }

    /** Simple deterministic hash for job content diagnostics (DJB2). */
    private computeHash(text: string): number {
        let hash = 5381
        for (let i = 0; i < text.length; i += 1) {
            // hash * 33 + charCode
            hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
        }
        // Keep as unsigned 32-bit for readability
        return hash >>> 0
    }

    /* ---------------------------------------------------------------------- */
    /*  Public API                                                            */
    /* ---------------------------------------------------------------------- */

    /**
     * For symmetry with other services; actual attach is discovery-driven.
     */
    public async start(): Promise<void> {
        // No-op: we connect only when onDeviceIdentified is called.
        this.debug('start() called (no-op)')
    }

    public async stop(): Promise<void> {
        this.debug('stop() called; tearing down')
        this.clearIdleTimer()
        this.clearReconnectTimer()

        // If a job is in-flight when stop() is called, finalize it instead of dropping.
        if (this.buffer.length > 0 && this.currentJobId != null) {
            this.debug('stop(): finalizing in-flight job before close', {
                currentJobId: this.currentJobId,
                bufferLen: this.buffer.length,
            })
            this.finalizeJob()
        }

        await this.closePort('explicit-close')
        this.state = 'disconnected'
        this.deviceId = null
        this.devicePath = null
        this.currentJobId = null
        this.currentJobStartedAt = null
        this.currentJobBytesReceivedAtStart = null
        this.currentJobChunkCount = 0
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
            this.debug('getNextJob(): queue empty, transitioning queued → idle', {
                dequeuedJobId: job.id,
            })
            this.state = 'idle'
        } else {
            this.debug('getNextJob(): dequeued job', {
                dequeuedJobId: job.id,
            })
        }
        return job
    }

    /** Clear all pending jobs (e.g., when resetting the bench run). */
    public clearQueue(): void {
        this.debug('clearQueue() called', {
            previousQueueLen: this.queue.length,
        })
        this.queue = []
        if (this.state === 'queued') {
            this.debug('clearQueue(): transitioning queued → idle')
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
        this.debug('onDeviceIdentified() called', {
            id: args.id,
            path: args.path,
            baudRate: args.baudRate ?? this.config.baudRate,
        })

        this.deviceId = args.id

        let effectivePath = args.path
        if (effectivePath.startsWith('/dev/tty.')) {
            const cuPath = '/dev/cu.' + effectivePath.slice('/dev/tty.'.length)
            this.debug('Translating macOS tty.* → cu.*', {
                originalPath: effectivePath,
                translatedPath: cuPath,
            })
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
            this.debug('onDeviceIdentified(): already connected; ignoring')
            return
        }

        await this.openPort()
    }

    /**
     * Called by orchestrator / discovery layer when a previously identified
     * printer is lost (USB unplug, etc.).
     */
    public async onDeviceLost(args: { id: string }): Promise<void> {
        this.debug('onDeviceLost() called', { id: args.id })

        if (this.deviceId !== args.id) {
            // Not our current device; ignore.
            this.debug('onDeviceLost(): deviceId mismatch; ignoring', {
                currentDeviceId: this.deviceId,
            })
            return
        }

        this.clearReconnectTimer()

        // If we lose the device while a job is in-flight, finalize that job
        // instead of dropping the buffer on the floor.
        if (this.buffer.length > 0 && this.currentJobId != null) {
            this.debug('onDeviceLost(): finalizing in-flight job before disconnect', {
                currentJobId: this.currentJobId,
                bufferLen: this.buffer.length,
            })
            this.finalizeJob()
        }

        await this.closePort('unknown')

        this.state = 'disconnected'
        this.deviceId = null
        this.devicePath = null
        this.currentJobId = null
        this.currentJobStartedAt = null
        this.currentJobBytesReceivedAtStart = null
        this.currentJobChunkCount = 0
        this.debug('onDeviceLost(): state reset to disconnected')
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
            this.debug('openPort(): no path available; staying disconnected')
            return
        }

        const baudRate = this.deviceBaudRate || this.config.baudRate

        this.debug('openPort(): attempting to open port', {
            path,
            baudRate,
        })

        return new Promise<void>((resolve, reject) => {
            const port = new SerialPort({
                path,
                baudRate,
                autoOpen: false,
                dataBits: 8,
                parity: 'none',
                stopBits: 1,
                // ❌ Do NOT enable software flow control unless both sides agree.
                // Win98 COM ports for printers are typically configured with no
                // XON/XOFF. Enabling it here can cause data bytes to be treated
                // as flow-control and dropped by the stack/driver.
                xon: false,
                xoff: false,
            })

            const onOpen = () => {
                this.port = port
                this.state = 'idle'
                this.reconnectAttempts = 0

                this.debug('openPort(): port opened successfully', {
                    path,
                    baudRate,
                })

                this.deps.events.publish({
                    kind: 'device-connected',
                    at: Date.now(),
                    portPath: path,
                })

                // Attach data/error handlers only after successful open
                port.on('data', (chunk: Buffer) => {
                    this.globalChunkIndex += 1
                    this.debug('data event received from serial port', {
                        chunkLength: chunk.length,
                        chunkIndex: this.globalChunkIndex,
                    })
                    // Preserve 8-bit values as-is; latin1 is a 1:1 mapping for
                    // bytes 0x00–0xFF into Unicode code points. This avoids the
                    // lossy behavior of 'ascii' and surprises of 'utf8' on
                    // arbitrary RAW/text print streams from Win98.
                    this.handleData(chunk.toString('latin1'), this.globalChunkIndex)
                })

                port.on('error', (err: Error) => {
                    this.debug('SerialPort error event', { error: err.message })
                    void this.handlePortError(err)
                })

                // 🔌 Explicit handler for unexpected close (USB yank, etc.)
                port.on('close', () => {
                    this.debug('SerialPort close event received')
                    void this.handlePortClose()
                })

                resolve()
            }

            const onError = (err: Error) => {
                port.off('open', onOpen)
                port.off('error', onError)
                this.debug('openPort(): error during open', { error: err.message })
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

        this.debug('closePort() called', {
            reason,
            hadPort: !!port,
            portIsOpen: port?.isOpen ?? false,
        })

        if (!port || !port.isOpen) {
            this.state = 'disconnected'
            this.debug('closePort(): no open port; state → disconnected')
            return
        }

        await new Promise<void>((resolve) => {
            port.close(() => resolve())
        })

        this.state = 'disconnected'

        this.debug('closePort(): port closed', { reason })

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

    private handleData(chunk: string, chunkIndex: number): void {
        if (this.state === 'disconnected' || this.state === 'error') {
            // Data while in these states is unexpected; treat as recoverable error.
            this.deps.events.publish({
                kind: 'recoverable-error',
                at: Date.now(),
                error: 'Received data while in invalid state',
            })
            this.debug('handleData(): data received in invalid state', {
                chunkLength: chunk.length,
                chunkIndex,
            })
            return
        }

        const now = Date.now()
        const size = chunk.length

        this.debug('handleData(): entering', {
            chunkLength: size,
            chunkIndex,
            state: this.state,
            currentJobId: this.currentJobId,
            bufferLenBefore: this.buffer.length,
        })

        // First byte for a new job: allocate id + mark start, emit job-started.
        // IMPORTANT: treat both 'idle' and 'queued' as "ready for a new job"
        // because the physical printer can start printing again even if we
        // still have completed jobs sitting in our queue.
        if (this.state === 'idle' || this.state === 'queued') {
            const jobId = this.nextJobId++

            this.state = 'receiving'
            this.currentJobId = jobId
            this.currentJobStartedAt = now
            this.currentJobBytesReceivedAtStart = this.stats.bytesReceived
            this.currentJobChunkCount = 0

            this.debug('handleData(): starting new job from idle/queued', {
                jobId,
                firstChunkIndex: chunkIndex,
                bytesReceivedAtStart: this.currentJobBytesReceivedAtStart,
            })

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
            this.currentJobBytesReceivedAtStart = this.stats.bytesReceived
            this.currentJobChunkCount = 0

            this.debug('handleData(): recovery path, created job in receiving state', {
                jobId,
                chunkIndex,
                bytesReceivedAtStart: this.currentJobBytesReceivedAtStart,
            })

            this.deps.events.publish({
                kind: 'job-started',
                at: now,
                jobId,
                createdAt: now,
            })
        }

        this.buffer += chunk
        this.stats.bytesReceived += size
        if (this.state === 'receiving' && size > 0) {
            this.currentJobChunkCount += 1
        }

        this.debug('handleData(): after appending chunk', {
            addedBytes: size,
            chunkIndex,
            newBufferLen: this.buffer.length,
            currentJobChunkCount: this.currentJobChunkCount,
            statsBytesReceived: this.stats.bytesReceived,
        })

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
        if (!this.config.idleFlushMs || this.config.idleFlushMs <= 0) {
            this.debug('scheduleIdleFlush(): idleFlushMs disabled or <= 0')
            return
        }

        const delay = this.config.idleFlushMs

        this.debug('scheduleIdleFlush(): scheduling idle flush', {
            idleFlushMs: delay,
            currentJobId: this.currentJobId,
            state: this.state,
        })

        this.idleTimer = setTimeout(() => {
            this.debug('idleFlush timer fired; finalizing job', {
                currentJobId: this.currentJobId,
                bufferLenAtFlush: this.buffer.length,
                stateAtFlush: this.state,
            })
            this.finalizeJob()
        }, delay)
    }

    private clearIdleTimer(): void {
        if (this.idleTimer) {
            this.debug('clearIdleTimer(): clearing existing idle timer')
            clearTimeout(this.idleTimer)
            this.idleTimer = null
        }
    }

    private finalizeJob(): void {
        this.clearIdleTimer()
        if (this.buffer.length === 0) {
            this.debug('finalizeJob(): buffer empty, nothing to finalize', {
                state: this.state,
            })
            // Nothing accumulated; if we were in receiving, go back to idle.
            if (this.state === 'receiving') {
                this.debug(
                    'finalizeJob(): buffer empty but state=receiving; transitioning to idle and clearing job metadata',
                    {
                        currentJobId: this.currentJobId,
                    }
                )
                this.state = 'idle'
                this.currentJobId = null
                this.currentJobStartedAt = null
                this.currentJobBytesReceivedAtStart = null
                this.currentJobChunkCount = 0
            }
            return
        }

        const now = Date.now()

        // If somehow we never saw a job-start (shouldn’t happen), fall back.
        const jobId = this.currentJobId ?? this.nextJobId++
        const createdAt = this.currentJobStartedAt ?? now

        const bufferLenBeforeNormalize = this.buffer.length

        // Basic control-character stats for diagnostics.
        const formFeedCount = (this.buffer.match(/\f/g) ?? []).length
        const crCount = (this.buffer.match(/\r/g) ?? []).length
        const lfCount = (this.buffer.match(/\n/g) ?? []).length

        this.debug('finalizeJob(): normalizing and completing job', {
            jobId,
            createdAt,
            bufferLenBeforeNormalize,
            state: this.state,
            currentJobChunkCount: this.currentJobChunkCount,
            formFeedCount,
            crCount,
            lfCount,
        })

        const rawNormalized =
            this.config.lineEnding === '\n'
                ? this.buffer
                : this.buffer
                      .replace(/\r\n/g, '\n')
                      .replace(/\r/g, '\n')
                      .replace(/\n/g, '\r\n')

        const rawLen = rawNormalized.length
        const hash = this.computeHash(rawNormalized)

        const preview = buildPreview(rawNormalized, DEFAULT_PREVIEW_CHARS)

        const job: SerialPrinterJob = {
            id: jobId,
            createdAt,
            completedAt: now,
            raw: rawNormalized,
            preview,
        }

        /* ------------------------------------------------------------------ */
        /*  DEBUG: dump full job to disk for offline inspection               */
        /* ------------------------------------------------------------------ */
        try {
            const dumpDir = process.env.SERIAL_PRINTER_DEBUG_DUMP_DIR || '/tmp'
            mkdirSync(dumpDir, { recursive: true })
            const dumpPath = join(dumpDir, `serial-printer-job-${jobId}.txt`)

            // Use latin1 to preserve 0x00–0xFF one-to-one.
            writeFileSync(dumpPath, job.raw, { encoding: 'latin1' })

            console.log(
                [
                    'SERIAL PRINTER JOB DUMP',
                    `jobId=${jobId}`,
                    `path=${dumpPath}`,
                    `sizeChars=${job.raw.length}`,
                    `hash=${hash}`,
                ].join(' ')
            )
        } catch (err) {
            console.warn(
                'SERIAL PRINTER JOB DUMP FAILED',
                (err as Error).message
            )
        }
        /* ------------------------------------------------------------------ */

        // --- DEBUG DIAGNOSTICS (safe to leave in while we track corruption) ---
        const bytesStart =
            this.currentJobBytesReceivedAtStart ?? this.stats.bytesReceived
        const bytesForJob = this.stats.bytesReceived - bytesStart
        const durationMs = now - createdAt
        const platform = process.platform
        const idleFlushMs = this.config.idleFlushMs ?? 0

        console.log(
            [
                'SERIAL PRINTER JOB DEBUG',
                `jobId=${jobId}`,
                `platform=${platform}`,
                `idleFlushMs=${idleFlushMs}`,
                `durationMs=${durationMs}`,
                `chunks=${this.currentJobChunkCount}`,
                `bufferLen=${bufferLenBeforeNormalize}`,
                `rawLen=${rawLen}`,
                `bytesForJob=${bytesForJob}`,
                `bytesTotal=${this.stats.bytesReceived}`,
                `hash=${hash}`,
                `formFeedCount=${formFeedCount}`,
                `crCount=${crCount}`,
                `lfCount=${lfCount}`,
            ].join(' ')
        )
        // ----------------------------------------------------------------------

        this.debug('finalizeJob(): enqueueing job and resetting state', {
            jobId,
            queueLenBefore: this.queue.length,
        })

        this.buffer = ''
        this.currentJobId = null
        this.currentJobStartedAt = null
        this.currentJobBytesReceivedAtStart = null
        this.currentJobChunkCount = 0

        // Enqueue with bounded capacity
        this.queue.push(job)
        if (this.queue.length > this.config.maxQueuedJobs) {
            const dropped = this.queue.shift()
            this.debug('finalizeJob(): queue over capacity, dropped oldest job', {
                droppedJobId: dropped?.id,
            })
        }

        this.stats.totalJobs += 1
        this.stats.lastJobAt = now
        this.state = this.queue.length > 0 ? 'queued' : 'idle'

        this.debug('finalizeJob(): job completed', {
            jobId,
            queueLenAfter: this.queue.length,
            stateAfter: this.state,
        })

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
        this.debug('handlePortClose(): unexpected port close', {
            stateAtClose: this.state,
            bufferLen: this.buffer.length,
            currentJobId: this.currentJobId,
        })

        // If we're already in a terminal state from our own close(), ignore.
        if (this.state === 'disconnected' || this.state === 'error') {
            this.debug(
                'handlePortClose(): already in disconnected/error state; ignoring'
            )
            return
        }

        this.stats.lastErrorAt = Date.now()

        // If the port closes while a job is in progress, finalize whatever we have.
        if (this.buffer.length > 0 && this.currentJobId != null) {
            this.debug('handlePortClose(): finalizing in-flight job on close', {
                currentJobId: this.currentJobId,
                bufferLen: this.buffer.length,
            })
            this.finalizeJob()
        }

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
        this.currentJobBytesReceivedAtStart = null
        this.currentJobChunkCount = 0
        this.buffer = ''

        this.debug('handlePortClose(): state reset; considering reconnect', {
            reconnectEnabled: this.config.reconnect.enabled,
        })

        if (this.config.reconnect.enabled) {
            this.scheduleReconnect()
        } else {
            this.deps.events.publish({
                kind: 'fatal-error',
                at: Date.now(),
                error: 'Serial printer port closed and reconnect disabled',
            })
            this.state = 'error'
            this.debug(
                'handlePortClose(): reconnect disabled, transitioning to error state'
            )
        }
    }

    private async handlePortError(err: Error): Promise<void> {
        this.stats.lastErrorAt = Date.now()

        this.deps.events.publish({
            kind: 'recoverable-error',
            at: this.stats.lastErrorAt,
            error: `Serial port error: ${err.message}`,
        })

        this.debug('handlePortError(): serial port error encountered', {
            error: err.message,
            bufferLen: this.buffer.length,
            currentJobId: this.currentJobId,
        })

        // If an error happens mid-job, finalize what we have instead of dropping it.
        if (this.buffer.length > 0 && this.currentJobId != null) {
            this.debug('handlePortError(): finalizing in-flight job on error', {
                currentJobId: this.currentJobId,
                bufferLen: this.buffer.length,
            })
            this.finalizeJob()
        }

        // Close and attempt reconnect if configured.
        await this.closePort('io-error')
        this.state = 'disconnected'
        this.currentJobId = null
        this.currentJobStartedAt = null
        this.currentJobBytesReceivedAtStart = null
        this.currentJobChunkCount = 0
        this.buffer = ''

        this.debug('handlePortError(): state reset; considering reconnect', {
            reconnectEnabled: this.config.reconnect.enabled,
        })

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
            this.debug(
                'handlePortError(): reconnect disabled, transitioning to error state'
            )
        }
    }

    private handlePortOpenError(err: Error): void {
        this.stats.lastErrorAt = Date.now()

        this.deps.events.publish({
            kind: 'recoverable-error',
            at: this.stats.lastErrorAt,
            error: `Failed to open serial port: ${err.message}`,
        })

        this.debug('handlePortOpenError(): failed to open port', {
            error: err.message,
            reconnectEnabled: this.config.reconnect.enabled,
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
            this.debug(
                'handlePortOpenError(): reconnect disabled, transitioning to error state'
            )
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

        this.debug('scheduleReconnect(): scheduling reconnect attempt', {
            attempt: this.reconnectAttempts,
            delayMs: delay,
            maxAttempts,
        })

        this.reconnectTimer = setTimeout(() => {
            this.debug('scheduleReconnect(): reconnect timer fired', {
                attempt: this.reconnectAttempts,
            })
            void this.tryReconnect()
        }, delay)
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            this.debug('clearReconnectTimer(): clearing reconnect timer')
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
    }

    private async tryReconnect(): Promise<void> {
        if (this.state === 'error') {
            this.debug(
                'tryReconnect(): current state is error; will not attempt reconnect'
            )
            return
        }

        this.debug('tryReconnect(): attempting to reopen port', {
            attempt: this.reconnectAttempts,
        })

        try {
            await this.openPort()
        } catch {
            // openPort already emitted errors and scheduled further reconnect if appropriate
            this.debug(
                'tryReconnect(): openPort threw; relying on openPort error handling'
            )
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
