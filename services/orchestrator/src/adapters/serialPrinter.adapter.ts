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
 *  - Server-side bounded full-text history for refresh/new clients
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
                    // Leave stats, history, and recentJobs intact
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
                    // History is preserved across disconnects so clients can still
                    // see the tape when reconnecting.
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
                    // History stays as-is; we only append on completion.
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

                // 🔁 Just append — no length cap on the in-flight buffer.
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

                // --- DEBUG: log lengths as seen by the adapter -----------------
                try {
                    const currentTextLen = prev.currentJob?.text.length ?? 0
                    const lastJobFullLen = prev.lastJobFullText?.length ?? 0
                    // eslint-disable-next-line no-console
                    console.log(
                        [
                            'SERIAL PRINTER STATE JOB DEBUG',
                            `jobId=${job.id}`,
                            `evtRawLen=${job.raw.length}`,
                            `previewLen=${job.preview.length}`,
                            `currentJobTextLen=${currentTextLen}`,
                            `prevLastJobFullTextLen=${lastJobFullLen}`,
                            `historyEntries=${prev.history.length}`,
                        ].join(' ')
                    )
                } catch {
                    // Avoid ever throwing from debug logging
                }
                // ----------------------------------------------------------------

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

                updateSerialPrinterSnapshot({
                    phase: 'connected', // idle/ready state after completion
                    message: undefined,
                    currentJob: null,
                    lastJob: summary,
                    // 🔐 canonical, full backend copy of the most recent job
                    lastJobFullText: job.raw,
                    recentJobs,
                    history,
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
                    // Preserve history so it survives transient failures.
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
                    // Preserve history here as well; restart can decide to reset.
                })
                return
            }
        }
    }
}