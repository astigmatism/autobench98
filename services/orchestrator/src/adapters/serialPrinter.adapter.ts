// services/orchestrator/src/core/adapters/serial-printer/SerialPrinterStateAdapter.ts
import { getSnapshot, updateSerialPrinterSnapshot } from '../core/state.js'
import { SerialPrinterEvent } from '../devices/serial-printer/types.js'

/**
 * SerialPrinterStateAdapter
 *
 * Mirrors SerialPrinterService events into AppState.serialPrinter.
 *
 * Supports:
 *  - Phase transitions (connected / receiving / disconnected / error)
 *  - Rolling recentJobs and lastJob
 *  - Canonical full-text for last completed job (lastJobFullText)
 *  - Server-side bounded full-text history for refresh/new clients
 *
 * Note: live streaming of in-progress job text has been removed. The only
 * job-related events we react to are "job-started" (for state) and
 * "job-completed" (for full text).
 */
export class SerialPrinterStateAdapter {
    handle(evt: SerialPrinterEvent): void {
        switch (evt.kind) {
            /* ------------------------------------------------------------------ */
            /* JOB STARTED                                                        */
            /* ------------------------------------------------------------------ */
            case 'job-started': {
                updateSerialPrinterSnapshot({
                    phase: 'receiving',
                    message: undefined,
                    currentJob: {
                        id: evt.jobId,
                        startedAt: evt.startedAt,
                    },
                })
                return
            }

            /* ------------------------------------------------------------------ */
            /* DEVICE CONNECTED                                                   */
            /* ------------------------------------------------------------------ */
            case 'device-connected': {
                updateSerialPrinterSnapshot({
                    phase: 'connected',
                    message: undefined,
                    currentJob: null,
                    // Stats, history, and last-job info are left intact.
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
                    lastJobFullText: null,
                    currentJob: null,
                    stats: {
                        ...stats,
                    },
                    // History is preserved across disconnects so clients can still
                    // see the tape when reconnecting.
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

                // Maintain lightweight recentJobs for quick summaries
                const recentJobs = [...prev.recentJobs, summary]
                const maxRecentJobs = prev.maxRecentJobs
                if (recentJobs.length > maxRecentJobs) {
                    recentJobs.splice(0, recentJobs.length - maxRecentJobs)
                }

                // Maintain full-text history for refresh/new clients.
                const historyLimit = prev.historyLimit || 0
                let history = [...prev.history]

                if (historyLimit > 0) {
                    history.push({
                        id: job.id,
                        createdAt: job.createdAt,
                        completedAt: job.completedAt,
                        text: job.raw,
                    })
                    if (history.length > historyLimit) {
                        history.splice(0, history.length - historyLimit)
                    }
                }

                const jobBytes = job.raw.length

                updateSerialPrinterSnapshot({
                    phase: 'connected', // idle/ready state after completion
                    message: undefined,
                    lastJob: summary,
                    currentJob: null,
                    // Canonical, full backend copy of the most recent job
                    lastJobFullText: job.raw,
                    recentJobs,
                    history,
                    stats: {
                        ...stats,
                        totalJobs: stats.totalJobs + 1,
                        bytesReceived: stats.bytesReceived + jobBytes,
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
                    lastJobFullText: null,
                    currentJob: null,
                    stats: {
                        ...stats,
                        lastErrorAt: evt.at,
                    },
                })
                return
            }

            /* ------------------------------------------------------------------ */
            /* FATAL ERROR                                                        */
            /* ------------------------------------------------------------------ */
            case 'fatal-error': {
                const snap = getSnapshot()
                const stats = snap.serialPrinter.stats
                updateSerialPrinterSnapshot({
                    phase: 'error',
                    message: evt.error,
                    lastJobFullText: null,
                    currentJob: null,
                    stats: {
                        ...stats,
                        lastErrorAt: evt.at,
                    },
                    // History is preserved; restart can decide to reset.
                })
                return
            }
        }
    }
}