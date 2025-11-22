// services/orchestrator/src/core/devices/serial-power-meter/utils.ts

import {
    type PowerSample,
    type PowerRecordingSummary,
    type PowerRecorderOptions,
    type PowerMeterConfig,
} from './types.js'

/* -------------------------------------------------------------------------- */
/*  Frame parsing                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Parse a WattsUp "#d,..." data frame into a PowerSample.
 *
 * Expected layout (from wattsup.py + observed data):
 *   0: "#d"
 *   1: "-"
 *   2: sample index
 *   3: watts_raw   (W = raw / 10)
 *   4: volts_raw   (V = raw / 10)
 *   5: amps_raw    (A = raw / 1000)
 *   6: whRaw       (cumulative energy - semantics TBD)
 *  10: wattsAltRaw (additional W-ish value)
 *  16: powerFactorRaw (PF * 100)
 */
export function parseWattsUpFrame(line: string): PowerSample | null {
    const fields = line.split(',')

    if (fields.length < 6) {
        return null
    }

    const wattsRaw = Number(fields[3])
    const voltsRaw = Number(fields[4])
    const ampsRaw = Number(fields[5])

    if (Number.isNaN(wattsRaw) || Number.isNaN(voltsRaw) || Number.isNaN(ampsRaw)) {
        return null
    }

    const watts = wattsRaw / 10
    const volts = voltsRaw / 10
    const amps = ampsRaw / 1000

    const whRaw = safeNumber(fields[6])
    const wattsAltRaw = safeNumber(fields[10])
    const pfRaw = safeNumber(fields[16])

    const ts = new Date().toISOString()

    return {
        ts,
        watts,
        volts,
        amps,
        whRaw,
        wattsAltRaw,
        powerFactorRaw: pfRaw,
        rawLine: line,
    }
}

function safeNumber(value: string | undefined): number | null {
    if (value == null || value === '' || value === '_' || value === '-') return null
    const n = Number(value)
    return Number.isNaN(n) ? null : n
}

/* -------------------------------------------------------------------------- */
/*  Recorder implementation                                                   */
/* -------------------------------------------------------------------------- */

export interface RecorderInstance {
    addSample(sample: PowerSample): void
    finish(): PowerRecordingSummary
}

export function createRecorder(
    recorderId: string,
    options?: PowerRecorderOptions
): RecorderInstance {
    const startedAt = new Date().toISOString()

    let sampleCount = 0

    let sumWatts = 0
    let minWatts: number | null = null
    let maxWatts: number | null = null

    let sumVolts = 0
    let minVolts: number | null = null
    let maxVolts: number | null = null

    let sumAmps = 0
    let minAmps: number | null = null
    let maxAmps: number | null = null

    // For simple energy approximation: sum of watts * dt
    // We assume roughly constant 1-second intervals; this can be refined later.
    let wattSecondsSum = 0

    let lastSampleTs: number | null = null
    let missingIntervals = 0

    return {
        addSample(sample: PowerSample) {
            const now = Date.parse(sample.ts) || Date.now()

            if (lastSampleTs != null) {
                const dtSec = Math.max(0, (now - lastSampleTs) / 1000)
                if (dtSec > 0 && dtSec < 10_000) {
                    wattSecondsSum += sample.watts * dtSec
                    // Basic gap detection; treat intervals larger than 1.5x as missing.
                    if (dtSec > 1.5) {
                        missingIntervals += 1
                    }
                }
            }

            lastSampleTs = now

            sampleCount += 1

            sumWatts += sample.watts
            minWatts = minWatts == null ? sample.watts : Math.min(minWatts, sample.watts)
            maxWatts = maxWatts == null ? sample.watts : Math.max(maxWatts, sample.watts)

            sumVolts += sample.volts
            minVolts = minVolts == null ? sample.volts : Math.min(minVolts, sample.volts)
            maxVolts = maxVolts == null ? sample.volts : Math.max(maxVolts, sample.volts)

            sumAmps += sample.amps
            minAmps = minAmps == null ? sample.amps : Math.min(minAmps, sample.amps)
            maxAmps = maxAmps == null ? sample.amps : Math.max(maxAmps, sample.amps)
        },

        finish(): PowerRecordingSummary {
            const endedAt = new Date().toISOString()

            const avgWatts = sampleCount > 0 ? sumWatts / sampleCount : null
            const avgVolts = sampleCount > 0 ? sumVolts / sampleCount : null
            const avgAmps = sampleCount > 0 ? sumAmps / sampleCount : null

            const wattHoursApprox = wattSecondsSum > 0 ? wattSecondsSum / 3600 : null

            return {
                recorderId,
                startedAt,
                endedAt,
                sampleCount,

                avgWatts,
                minWatts,
                maxWatts,

                avgVolts,
                minVolts,
                maxVolts,

                avgAmps,
                minAmps,
                maxAmps,

                wattSeconds: wattSecondsSum || null,
                wattHoursApprox,
                missingIntervals: missingIntervals || 0,
                meta: options?.meta ?? {},
            }
        },
    }
}

/* -------------------------------------------------------------------------- */
/*  Config builder from environment                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build a PowerMeterConfig from process.env-style input.
 *
 * Expected env vars (see .env.example):
 *   - SERIAL_PM_SAMPLING_INTERVAL_SEC
 *   - SERIAL_PM_MAX_RECENT_SAMPLES
 *   - SERIAL_PM_FULL_HANDLING
 *   - SERIAL_PM_RECONNECT_ENABLED
 *   - SERIAL_PM_RECONNECT_MAX_ATTEMPTS
 *   - SERIAL_PM_RECONNECT_BASE_DELAY_MS
 *   - SERIAL_PM_RECONNECT_MAX_DELAY_MS
 */
export function buildPowerMeterConfigFromEnv(env: NodeJS.ProcessEnv): PowerMeterConfig {
    const samplingIntervalSec = parseIntSafe(env.SERIAL_PM_SAMPLING_INTERVAL_SEC, 1)
    const maxRecentSamples = parseIntSafe(env.SERIAL_PM_MAX_RECENT_SAMPLES, 120)
    const fullHandling = parseIntSafe(env.SERIAL_PM_FULL_HANDLING, 3)

    const reconnectEnabled = parseBoolSafe(env.SERIAL_PM_RECONNECT_ENABLED, true)
    const reconnectMaxAttempts = parseIntSafe(env.SERIAL_PM_RECONNECT_MAX_ATTEMPTS, 5)
    const reconnectBaseDelayMs = parseIntSafe(env.SERIAL_PM_RECONNECT_BASE_DELAY_MS, 1000)
    const reconnectMaxDelayMs = parseIntSafe(env.SERIAL_PM_RECONNECT_MAX_DELAY_MS, 10_000)

    return {
        maxRecentSamples,
        samplingIntervalSec,
        fullHandling,
        reconnect: {
            enabled: reconnectEnabled,
            maxAttempts: reconnectMaxAttempts,
            baseDelayMs: reconnectBaseDelayMs,
            maxDelayMs: reconnectMaxDelayMs,
        },
    }
}

function parseIntSafe(value: string | undefined, fallback: number): number {
    if (!value) return fallback
    const n = Number.parseInt(value, 10)
    return Number.isNaN(n) ? fallback : n
}

function parseBoolSafe(value: string | undefined, fallback: boolean): boolean {
    if (value == null || value === '') return fallback
    const v = value.toLowerCase()
    if (v === 'true' || v === '1' || v === 'yes') return true
    if (v === 'false' || v === '0' || v === 'no') return false
    return fallback
}