// services/orchestrator/src/core/devices/serial-printer/types.ts

export type SerialPrinterState =
    | 'idle'          // Port open, no active job
    | 'receiving'     // Currently accumulating bytes for a job
    | 'queued'        // Jobs queued, waiting for consumption
    | 'disconnected'  // Device is not available; reconnect may be in progress
    | 'error'         // Fatal error; manual intervention required

export interface SerialPrinterJob {
    /** Monotonic ID for jobs within this process */
    id: number
    /** When the job was first seen (ms since epoch) */
    createdAt: number
    /** When the job was finalized and enqueued (ms since epoch) */
    completedAt: number
    /** Raw bytes as decoded text (we assume printer sends text for now) */
    raw: string
    /** Human-readable preview (truncated) */
    preview: string
    /** Optional per-job metadata we might add later (page count, etc.) */
    meta?: Record<string, string>
}

export interface SerialPrinterReconnectPolicy {
    enabled: boolean
    /** 0 => unlimited attempts */
    maxAttempts: number
    /** Base delay in ms (will be used directly; no jitter yet) */
    baseDelayMs: number
    /** Maximum delay in ms between attempts */
    maxDelayMs: number
}

export type SerialPrinterFlowControl =
    | 'none'       // No flow control
    | 'software'   // XON/XOFF
    | 'hardware'   // RTS/CTS

export interface SerialPrinterConfig {
    /** OS device path (e.g., /dev/ttyUSB0 or /dev/tty.usbserial-XXXX) */
    portPath: string
    /** Baud rate configured on both ends (Win98 + adapter) */
    baudRate: number
    /** How we interpret line endings for previews and optional parsing */
    lineEnding: '\n' | '\r\n'
    /** Idle time (ms) with no data → consider the job complete */
    idleFlushMs: number
    /** Maximum number of queued jobs (FIFO). Oldest jobs are dropped. */
    maxQueuedJobs: number
    /** Reconnection policy when the device disappears or open fails */
    reconnect: SerialPrinterReconnectPolicy
    /** Flow control mode for the serial port (must match Win98 side) */
    flowControl: SerialPrinterFlowControl
}

export interface SerialPrinterStats {
    totalJobs: number
    bytesReceived: number
    lastJobAt: number | null
    lastErrorAt: number | null
}

/**
 * Higher-level error semantics that the service will emit.
 * The main application loop can decide how to react (retry, abort run, etc.).
 */
export type SerialPrinterEventKind =
    | 'job-started'
    | 'job-chunk'
    | 'job-completed'
    | 'device-connected'
    | 'device-disconnected'
    | 'fatal-error'
    | 'recoverable-error'

export interface SerialPrinterEventBase {
    kind: SerialPrinterEventKind
    at: number
}

export interface SerialPrinterJobStartedEvent extends SerialPrinterEventBase {
    kind: 'job-started'
    /** Logical job id for this print (matches SerialPrinterJob.id later) */
    jobId: number
    /** When the first byte for this job was seen (ms since epoch) */
    createdAt: number
}

export interface SerialPrinterJobChunkEvent extends SerialPrinterEventBase {
    kind: 'job-chunk'
    /** Logical job id for this print */
    jobId: number
    /** Text for this chunk (decoded) */
    text: string
    /** Number of bytes in this chunk */
    bytes: number
}

export interface SerialPrinterJobCompletedEvent extends SerialPrinterEventBase {
    kind: 'job-completed'
    job: SerialPrinterJob
}

export interface SerialPrinterDeviceConnectedEvent extends SerialPrinterEventBase {
    kind: 'device-connected'
    portPath: string
}

export interface SerialPrinterDeviceDisconnectedEvent extends SerialPrinterEventBase {
    kind: 'device-disconnected'
    portPath: string
    reason: 'io-error' | 'explicit-close' | 'unknown'
}

export interface SerialPrinterFatalErrorEvent extends SerialPrinterEventBase {
    kind: 'fatal-error'
    error: string
}

export interface SerialPrinterRecoverableErrorEvent extends SerialPrinterEventBase {
    kind: 'recoverable-error'
    error: string
}

export type SerialPrinterEvent =
    | SerialPrinterJobStartedEvent
    | SerialPrinterJobChunkEvent
    | SerialPrinterJobCompletedEvent
    | SerialPrinterDeviceConnectedEvent
    | SerialPrinterDeviceDisconnectedEvent
    | SerialPrinterFatalErrorEvent
    | SerialPrinterRecoverableErrorEvent

/**
 * Abstraction for how the SerialPrinterService talks to the rest of the app.
 * The concrete implementation can be an event bus, a message router, or
 * just a simple orchestrator-owned callback.
 */
export interface SerialPrinterEventSink {
    publish(event: SerialPrinterEvent): void
}