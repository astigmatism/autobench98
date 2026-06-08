// services/orchestrator/src/core/tips-panel/types.ts

import type { TipsPanelCurrent } from '../state.js'

/**
 * Option A schema:
 * - Each category is 3 columns: image | text | priority
 * - Priority defaults to 0 when blank/invalid (service enforces strict/warn policy)
 */
export type TipsTip = {
    category: string
    tipId: string
    imageUrl: string | null
    pages: string[]

    /** Higher numbers are shown earlier within the category; ties are randomized. */
    priority: number
}

export type TipsCatalog = {
    /** All categories discovered from the sheet header (categoryHeaderRow). */
    categories: string[]
    /** Categories eligible for rotation (stub/env/defaultCategories intersected against discovered categories). */
    eligibleCategories: string[]
    /** Tips loaded so far (lazy, per-category). Categories not yet loaded may be missing here. */
    byCategory: Record<string, TipsTip[]>
    /** Total tips loaded so far (lazy). This is NOT guaranteed to be the full sheet total until all eligible categories are loaded. */
    totalTips: number
}

export type CategoryMeta = {
    category: string

    // Column letters (1-based columns)
    imgColLetter: string
    txtColLetter: string
    priColLetter: string

    // Column numbers (1-based columns)
    imgColNumber: number
    txtColNumber: number
    priColNumber: number
}

export type CatalogMeta = {
    tab: string
    rowCount: number
    colCount: number
    endColLetter: string
    /** category -> meta */
    categories: Record<string, CategoryMeta>
}

export type CategoryCacheEntry = {
    tips: TipsTip[]
    fetchedAt: number
    ttlMs: number
}

export type ClientSession = {
    clientId: string
    lastSeenAt: number

    // Per-client rotation state: exhaust-before-repeat within each category
    rrCatIdx: number
    rrTipPos: Record<string, number>

    /**
     * Per-client randomized order of indices for each category’s *currently loaded* list.
     * Priority-aware ordering is encoded into this list.
     */
    rrOrder: Record<string, number[]>

    // Per-client current tip/page state
    currentTip: TipsTip | null
    currentPageIdx: number

    // Optional in-flight guard (prevents concurrent nextForClient calls from interleaving)
    inflight: Promise<TipsPanelCurrent | null> | null
}

export type TipsPanelEvent =
    | { kind: 'tips-loading'; at: number; message?: string }
    | { kind: 'tips-ready'; at: number; message?: string }
    | { kind: 'tips-error'; at: number; error: string }
    | { kind: 'tips-refreshed'; at: number; totalTips: number; totalCategories: number }
    | { kind: 'tips-eligible-categories'; at: number; categories: string[] }
    | { kind: 'tips-current'; at: number; current: TipsPanelCurrent }

export type TipsPanelEventSink = {
    publish(evt: TipsPanelEvent): void
}
