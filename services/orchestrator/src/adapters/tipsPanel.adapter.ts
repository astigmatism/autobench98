// services/orchestrator/src/adapters/tipsPanel.adapter.ts
import { getSnapshot, updateTipsPanelSnapshot } from '../core/state.js'
import type { TipsPanelEvent } from '../core/tips-panel/types.js'

/**
 * TipsPanelStateAdapter
 *
 * Mirrors TipsPanelEvent objects into AppState.tipsPanel using updateTipsPanelSnapshot.
 * Stateless by design; always trusts the latest event payload.
 *
 * SAFETY / COMPATIBILITY NOTES:
 * - The canonical event union (core/tips-panel/types.ts) currently does NOT include 'tips-disabled'.
 * - Older codepaths may still emit a legacy 'tips-disabled' event. We support it via runtime
 *   narrowing without expanding the shared type union here (keeps changes localized).
 * - We do NOT assume message/reason fields exist unless verified for that event kind.
 */

type LegacyTipsDisabledEvent = {
    kind: 'tips-disabled'
    at: number
    reason?: string
}

function isLegacyTipsDisabledEvent(x: unknown): x is LegacyTipsDisabledEvent {
    if (!x || typeof x !== 'object') return false
    const o = x as any
    return o.kind === 'tips-disabled' && typeof o.at === 'number'
}

export class TipsPanelStateAdapter {
    handle(evt: TipsPanelEvent | unknown): void {
        // Common stats update: increment totalEvents and bump lastEventAt.
        const snap = getSnapshot()
        const prevStats = snap.tipsPanel.stats

        const baseStats = {
            totalEvents: (prevStats?.totalEvents ?? 0) + 1,
            lastEventAt: isLegacyTipsDisabledEvent(evt)
                ? evt.at
                : (evt as any)?.at ?? Date.now()
        }

        // Legacy support (non-breaking)
        if (isLegacyTipsDisabledEvent(evt)) {
            updateTipsPanelSnapshot({
                phase: 'disabled',
                message: typeof evt.reason === 'string' && evt.reason.trim() ? evt.reason.trim() : 'Tips disabled',
                current: null,
                eligibleCategories: [],
                stats: {
                    ...baseStats
                }
            })
            return
        }

        // Canonical event handling (per core/tips-panel/types.ts)
        const e = evt as TipsPanelEvent

        switch (e.kind) {
            case 'tips-loading': {
                updateTipsPanelSnapshot({
                    phase: 'loading',
                    message: e.message ?? 'Loading tips…',
                    stats: {
                        ...baseStats
                    }
                })
                return
            }

            case 'tips-ready': {
                updateTipsPanelSnapshot({
                    phase: 'ready',
                    message: e.message,
                    stats: {
                        ...baseStats
                        // NOTE: we intentionally do not clear lastErrorAt here.
                    }
                })
                return
            }

            case 'tips-refreshed': {
                // NOTE: canonical event has no message field (verified).
                updateTipsPanelSnapshot({
                    phase: snap.tipsPanel.phase === 'disabled' ? 'disabled' : 'ready',
                    message: undefined,
                    stats: {
                        ...baseStats,
                        lastRefreshAt: e.at,
                        totalTips: e.totalTips,
                        totalCategories: e.totalCategories
                    }
                })
                return
            }

            case 'tips-eligible-categories': {
                updateTipsPanelSnapshot({
                    eligibleCategories: e.categories,
                    stats: {
                        ...baseStats
                    }
                })
                return
            }

            case 'tips-current': {
                updateTipsPanelSnapshot({
                    phase: snap.tipsPanel.phase === 'disabled' ? 'disabled' : 'ready',
                    current: e.current,
                    stats: {
                        ...baseStats
                    }
                })
                return
            }

            case 'tips-error': {
                updateTipsPanelSnapshot({
                    phase: snap.tipsPanel.phase === 'disabled' ? 'disabled' : 'error',
                    message: e.error,
                    stats: {
                        ...baseStats,
                        lastErrorAt: e.at
                    }
                })
                return
            }

            default: {
                // Safety fence: ignore unknown event kinds rather than throwing.
                return
            }
        }
    }
}
