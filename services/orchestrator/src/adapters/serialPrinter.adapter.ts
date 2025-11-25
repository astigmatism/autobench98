// services/orchestrator/src/core/adapters/serialPrinter.adapter.ts

import { getSnapshot, updateSerialPrinterSnapshot } from '../core/state.js'
import { SerialPrinterEvent } from '../devices/serial-printer/types.js'

/**
 * SerialPrinterStateAdapter
 *
 * Mirrors SerialPrinterService events into AppState.serialPrinter.
 *
 * Supports:
 *  - Live streaming text via currentJob
 *  - Clearing currentJob on completion/error/disconnect
 *  - Correct phase transitions
 *  - Rolling recentJobs and lastJob
 *  - Canonical full-text for last completed job (lastJobFullText)
 */
export class SerialPrinterStateAdapter {
    handle(evt: SerialPrinterEvent): void {
        switch (evt.kind) {
            /* ------------------------------------------------------------------ */
            /* DEVICE CONNECTED                                                   */
            /* ------------------------------------------------------------------ */
            case 'device-connected': {
                updateSerialPrinterSnapshot({
                    // If we already had a job in progress (rare), remain receiving.
                    phase: 'connected',
                    message: undefined,
                    // Leave stats and recentJobs intact
                })
                return
            }

            /* ------------------------------------------------------------------ */
            /* DEVICE DISCONNECTED                                                */
            /* ------------------------------------------------------------------ */
            case 'device-disconnected': {
                const snap = getSnapshot()
                const stats = snap.serialPrinter.stats

                updateSerialPrinterSnapshot({
                    phase: 'disconnected',
                    message: `Disconnected (${evt.reason})`,
                    currentJob: null,
                    lastJobFullText: null,
                    stats: {
                        ...stats,
                    },
                })
                return
            }

            /* ------------------------------------------------------------------ */
            /* JOB STARTED                                                        */
            /* ------------------------------------------------------------------ */
            case 'job-started': {
                const snap = getSnapshot()
                const stats = snap.serialPrinter.stats

                updateSerialPrinterSnapshot({
                    phase: 'receiving',
                    message: undefined,
                    currentJob: {
                        id: evt.jobId,
                        startedAt: evt.createdAt,
                        text: '',
                    },
                    // We're now in a new job; clear any leftover canonical text.
                    lastJobFullText: null,
                    stats: {
                        ...stats,
                    },
                })
                return
            }

            /* ------------------------------------------------------------------ */
            /* JOB CHUNK (streaming text)                                         */
            /* ------------------------------------------------------------------ */
            case 'job-chunk': {
                const snap = getSnapshot()
                const prev = snap.serialPrinter
                const stats = prev.stats
                const current = prev.currentJob

                if (!current || current.id !== evt.jobId) {
                    // Out-of-order or missing start—ignore silently
                    return
                }

                // 🔁 Just append — no length cap. The frontend can decide how to display it.
                const combined = current.text + evt.text

                updateSerialPrinterSnapshot({
                    phase: 'receiving',
                    currentJob: {
                        ...current,
                        text: combined,
                    },
                    stats: {
                        ...stats,
                        bytesReceived: stats.bytesReceived + evt.bytes,
                    },
                })
                return
            }

            /* ------------------------------------------------------------------ */
            /* JOB COMPLETED                                                      */
            /* ------------------------------------------------------------------ */
            case 'job-completed': {
                const snap = getSnapshot()
                const prev = snap.serialPrinter
                const stats = prev.stats

                const job = evt.job
                const now = evt.at

                const summary = {
                    id: job.id,
                    createdAt: job.createdAt,
                    completedAt: job.completedAt,
                    preview: job.preview,
                }

                const recentJobs = [...prev.recentJobs, summary]
                const maxRecentJobs = prev.maxRecentJobs
                if (recentJobs.length > maxRecentJobs) {
                    recentJobs.splice(0, recentJobs.length - maxRecentJobs)
                }

                updateSerialPrinterSnapshot({
                    phase: 'connected', // idle/ready state after completion
                    message: undefined,
                    currentJob: null,
                    lastJob: summary,
                    // 🔐 canonical, full backend copy of the most recent job
                    lastJobFullText: job.raw,
                    recentJobs,
                    stats: {
                        ...stats,
                        totalJobs: stats.totalJobs + 1,
                        lastJobAt: now,
                    },
                })
                return
            }

            /* ------------------------------------------------------------------ */
            /* RECOVERABLE ERROR                                                  */
            /* ------------------------------------------------------------------ */
            case 'recoverable-error': {
                const snap = getSnapshot()
                const stats = snap.serialPrinter.stats
                updateSerialPrinterSnapshot({
                    phase: 'disconnected',
                    message: evt.error,
                    currentJob: null,
                    lastJobFullText: null,
                    stats: {
                        ...stats,
                        lastErrorAt: evt.at,
                    },
                })
                return
            }

            /* ------------------------------------------------------------------ */
            /* FATAL ERROR                                                       */
            /* ------------------------------------------------------------------ */
            case 'fatal-error': {
                const snap = getSnapshot()
                const stats = snap.serialPrinter.stats
                updateSerialPrinterSnapshot({
                    phase: 'error',
                    message: evt.error,
                    currentJob: null,
                    lastJobFullText: null,
                    stats: {
                        ...stats,
                        lastErrorAt: evt.at,
                    },
                })
                return
            }
        }
    }
}