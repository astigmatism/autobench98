// services/orchestrator/src/core/devices/serial-power-meter/types.ts

/* -------------------------------------------------------------------------- */
/*  Core configuration                                                        */
/* -------------------------------------------------------------------------- */

export interface PowerMeterConfig {
    /** Maximum number of recent samples retained in memory for introspection. */
    maxRecentSamples: number

    /** Desired sampling interval in seconds (default 1). */
    samplingIntervalSec: number

    /** WattsUp full handling option; typically 3 (not used by wattsup CLI, but kept). */
    fullHandling?: number

    reconnect: {
        /** Whether to attempt automatic reconnect on IO/open errors. */
        enabled: boolean
        /** Base delay in ms used for backoff. */
        baseDelayMs: number
        /** Max delay in ms for backoff. */
        maxDelayMs: number
        /**
         * Maximum reconnect attempts. 0 or negative means "unbounded".
         * Note: discovery-driven device-lost events should still be respected.
         */
        maxAttempts: number
    }
}

/* -------------------------------------------------------------------------- */
/*  State + Stats                                                             */
/* -------------------------------------------------------------------------- */

export type PowerMeterState =
    | { phase: 'disconnected' }
    | { phase: 'connecting' }
    | { phase: 'streaming' }
    | { phase: 'error'; message: string }

export interface PowerMeterStats {
    totalSamples: number
    bytesReceived: number
    lastSampleAt: number | null
    lastErrorAt: number | null
}

/* -------------------------------------------------------------------------- */
/*  Core sample + recording types                                            */
/* -------------------------------------------------------------------------- */

/**
 * Logical power sample as seen by the orchestrator.
 *
 * NOTE: Right now we only surface a subset of the wattsup CSV fields as
 * explicit properties plus one “raw” block. We can expand this interface
 * later to include all fields if you want to plumb them through.
 */
export interface PowerSample {
    /** ISO timestamp when *we* observed the row. */
    ts: string

    /** Instantaneous measurements. */
    watts: number
    volts: number
    amps: number

    /** Raw watt-hours counter (WH column). */
    whRaw?: number | null

    /**
     * Additional W-ish value. For the wattsup CLI rows we currently map this
     * to Wmax (peak watts), but the name is kept for compatibility.
     */
    wattsAltRaw?: number | null

    /** Power factor * 100 (PF column), kept as a numeric raw value. */
    powerFactorRaw?: number | null

    /** Original CSV line for debugging. */
    rawLine?: string
}

/** Configuration/options for a recorder instance. */
export interface PowerRecorderOptions {
    /** Optional metadata; runId, UI session, category, etc. */
    meta?: Record<string, unknown>
}

/**
 * Per-recording quality metrics, computed at endRecording.
 */
export interface PowerRecordingQuality {
    startedAt: number
    endedAt: number
    /** Duration of the recording in milliseconds. */
    durationMs: number
    /**
     * Expected samples based on configured samplingIntervalSec and duration.
     * Always >= 1.
     */
    expectedSamples: number
    /** Number of successfully parsed samples during this recording. */
    goodSamples: number
    /** Number of bad frames / parse failures during this recording. */
    badFrames: number
    /** goodSamples / expectedSamples, in [0, 1]. */
    goodSampleRatio: number
    /** badFrames / expectedSamples, in [0, 1]. */
    badFrameRatio: number
    /** Largest observed gap between successive good samples, in ms. */
    maxGapMs: number
    /** High-level verdict for this recording. */
    verdict: 'good' | 'degraded' | 'poor'
}

export interface PowerRecordingSummary {
    recorderId: string
    startedAt: string
    endedAt: string
    sampleCount: number

    avgWatts: number | null
    minWatts: number | null
    maxWatts: number | null

    avgVolts: number | null
    minVolts: number | null
    maxVolts: number | null

    avgAmps: number | null
    minAmps: number | null
    maxAmps: number | null

    /** Approximate energy in watt-seconds. */
    wattSeconds?: number | null
    /** Approximate energy in watt-hours. */
    wattHoursApprox?: number | null

    /** Number of missing intervals / detected gaps, if tracked. */
    missingIntervals?: number

    meta?: Record<string, unknown>

    /**
     * Optional per-recording quality metrics. Populated by
     * SerialPowerMeterService.endRecording when available.
     */
    quality?: PowerRecordingQuality
}

/* -------------------------------------------------------------------------- */
/*  Event sink + event union                                                 */
/* -------------------------------------------------------------------------- */

export interface PowerMeterEventSink {
    publish(evt: PowerMeterEvent): void
}

export type PowerMeterEvent =
    | {
        kind: 'meter-device-identified'
        at: number
        id: string
        path: string
        baudRate: number
    }
    | {
        kind: 'meter-device-connected'
        at: number
        path: string
        baudRate: number
    }
    | {
        kind: 'meter-device-disconnected'
        at: number
        path: string
        reason: 'io-error' | 'explicit-close' | 'unknown' | 'device-lost'
    }
    | {
        kind: 'meter-device-lost'
        at: number
        id: string
    }
    | {
        kind: 'meter-streaming-started'
        at: number
    }
    | {
        kind: 'meter-sample'
        at: number
        sample: PowerSample
    }
    | {
        kind: 'meter-control-line'
        at: number
        line: string
    }
    | {
        kind: 'meter-unknown-line'
        at: number
        line: string
    }
    | {
        kind: 'recording-started'
        at: number
        recorderId: string
        options?: PowerRecorderOptions
    }
    | {
        kind: 'recording-finished'
        at: number
        recorderId: string
        summary: PowerRecordingSummary
    }
    | {
        kind: 'recording-cancelled'
        at: number
        recorderId: string
        reason: string
    }
    | {
        kind: 'recoverable-error'
        at: number
        error: string
    }
    | {
        kind: 'fatal-error'
        at: number
        error: string
    }

/* -------------------------------------------------------------------------- */
/*  External runner contracts (child process / wattsup binary)               */
/* -------------------------------------------------------------------------- */

/**
 * Options handed to the external wattsup runner.
 *
 * These are intentionally generic so the concrete implementation can
 * decide how to turn them into CLI args, env vars, etc.
 */
export interface WattsUpRunnerOptions {
    /** Device path determined by discovery, e.g. /dev/ttyUSB0. */
    devicePath: string
    /** Desired sampling interval (seconds). */
    samplingIntervalSec: number
    /** Optional path to the wattsup binary, if not on $PATH. */
    binaryPath?: string
}

/**
 * Minimal contract the SerialPowerMeterService expects from the external
 * reader that owns the actual serial/binary interaction.
 *
 * Concrete implementations live elsewhere (e.g. a wattsup-runner package).
 */
export interface WattsUpRunner {
    /** Start streaming lines. Should resolve once the process is “ready”. */
    start(): Promise<void>
    /** Stop streaming and tear down any underlying resources. */
    stop(): Promise<void>

    /** Register a callback for each logical data/control line from the meter. */
    onLine(cb: (line: string) => void): void
    /** Register a callback for non-fatal / recoverable errors. */
    onError(cb: (err: Error) => void): void
    /**
     * Called when the underlying process exits or the stream ends.
     * exitCode/signal are implementation-defined.
     */
    onExit(cb: (exitCode: number | null, signal: string | null) => void): void
}