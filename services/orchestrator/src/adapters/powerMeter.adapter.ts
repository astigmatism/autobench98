// services/orchestrator/src/adapters/powerMeter.adapter.ts

import {
    getSnapshot,
    updatePowerMeterSnapshot,
} from '../core/state.js'
import {
    type PowerMeterEvent,
    type PowerSample
} from '../devices/serial-powermeter/types.js'

/**
 * PowerMeterStateAdapter
 *
 * This adapter listens to structured PowerMeterEvent objects emitted
 * by the SerialPowerMeterService via its PowerMeterEventSink.
 *
 * It translates those events into AppState.powerMeter changes using the
 * updatePowerMeterSnapshot helper.
 *
 * The adapter is intentionally stateless: it never stores its own copy
 * of phase, stats, or samples. It always trusts the events passed into it.
 */
export class PowerMeterStateAdapter {
    /** Simple counter so we can log every Nth sample (if desired). */
    private sampleCount = 0

    handle(evt: PowerMeterEvent): void {
        switch (evt.kind) {
            /* ------------------------------------------------------------------ */
            /*  DEVICE IDENTIFICATION + CONNECTION                                */
            /* ------------------------------------------------------------------ */

            case 'meter-device-identified': {
                updatePowerMeterSnapshot({
                    phase: 'connecting',
                    message: undefined,
                })
                return
            }

            case 'meter-device-connected': {
                updatePowerMeterSnapshot({
                    phase: 'connecting',
                    message: undefined,
                })
                return
            }

            case 'meter-streaming-started': {
                updatePowerMeterSnapshot({
                    phase: 'streaming',
                    message: undefined,
                })
                return
            }

            /* ------------------------------------------------------------------ */
            /*  SAMPLES (HIGH FREQUENCY)                                          */
            /* ------------------------------------------------------------------ */

            case 'meter-sample': {
                this.sampleCount += 1
                const sample: PowerSample = evt.sample

                const snap = getSnapshot()
                const stats = snap.powerMeter.stats

                updatePowerMeterSnapshot({
                    phase: 'streaming',
                    lastSample: {
                        ts: sample.ts,
                        watts: sample.watts,
                        volts: sample.volts,
                        amps: sample.amps,
                    },
                    stats: {
                        totalSamples: stats.totalSamples,       // keep as-is for now
                        bytesReceived: stats.bytesReceived,     // keep as-is for now
                        lastSampleAt: Date.now(),
                        lastErrorAt: stats.lastErrorAt,
                    }
                })

                return
            }

            /* ------------------------------------------------------------------ */
            /*  DEVICE LOST / DISCONNECTED                                        */
            /* ------------------------------------------------------------------ */

            case 'meter-device-disconnected': {
                updatePowerMeterSnapshot({
                    phase: 'disconnected',
                    message: `Disconnected (${evt.reason})`,
                })
                return
            }

            case 'meter-device-lost': {
                updatePowerMeterSnapshot({
                    phase: 'disconnected',
                    message: 'Device lost',
                })
                return
            }

            /* ------------------------------------------------------------------ */
            /*  ERRORS                                                             */
            /* ------------------------------------------------------------------ */

            case 'recoverable-error': {
                const snap = getSnapshot()
                const stats = snap.powerMeter.stats

                updatePowerMeterSnapshot({
                    phase: 'connecting', // still trying
                    message: evt.error,
                    stats: {
                        totalSamples: stats.totalSamples,
                        bytesReceived: stats.bytesReceived,
                        lastSampleAt: stats.lastSampleAt,
                        lastErrorAt: evt.at,
                    }
                })
                return
            }

            case 'fatal-error': {
                const snap = getSnapshot()
                const stats = snap.powerMeter.stats

                updatePowerMeterSnapshot({
                    phase: 'error',
                    message: evt.error,
                    stats: {
                        totalSamples: stats.totalSamples,
                        bytesReceived: stats.bytesReceived,
                        lastSampleAt: stats.lastSampleAt,
                        lastErrorAt: evt.at,
                    }
                })
                return
            }

            /* ------------------------------------------------------------------ */
            /*  RECORDINGS (UI/benchmark controls)                                 */
            /* ------------------------------------------------------------------ */

            case 'recording-started':
            case 'recording-finished':
            case 'recording-cancelled': {
                // These events do not affect the global powerMeter state.
                return
            }

            /* ------------------------------------------------------------------ */
            /*  CONTROL + UNKNOWN LINE EVENTS (ignore for state)                  */
            /* ------------------------------------------------------------------ */

            case 'meter-control-line':
            case 'meter-unknown-line': {
                // These do not alter AppState.powerMeter.
                return
            }
        }
    }
}