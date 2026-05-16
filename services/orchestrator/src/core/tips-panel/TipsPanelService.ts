import type { ChannelLogger } from '@autobench98/logging'
import type { SheetsGateway } from '../sheets/sheets.gateway.js'
import { columnNumberToLetter } from '../sheets/sheets.gateway.js'
import type { TipsPanelCurrent, TipsServerConfig } from '../state.js'
import type {
    CatalogMeta,
    CategoryCacheEntry,
    CategoryMeta,
    ClientSession,
    TipsCatalog,
    TipsPanelEventSink,
    TipsTip,
} from './types.js'

function bool01(x: unknown): '0' | '1' {
    return x ? '1' : '0'
}

function safeStr(x: unknown, fallback = ''): string {
    return typeof x === 'string' && x.trim() ? x.trim() : fallback
}

function safeNum(x: unknown, fallback = 0): number {
    const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN
    return Number.isFinite(n) ? n : fallback
}

function clampRow1(n: number, def: number): number {
    if (!Number.isFinite(n)) return def
    const i = Math.trunc(n)
    return i < 1 ? 1 : i
}

function safeClientId(x: unknown): string {
    if (typeof x !== 'string') return ''
    const s = x.trim()
    if (!s) return ''
    if (s.length > 128) return ''
    return s
}

function clampMs(raw: unknown, def: number, min: number): number {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    if (!Number.isFinite(n)) return def
    const i = Math.trunc(n)
    return i < min ? min : i
}

/**
 * Category properties blob parsed from the optional category props row.
 *
 * This is intentionally permissive:
 * - We keep the raw object so the system can evolve without schema churn.
 * - Frontend can pick fields it understands (e.g. title/color).
 */
type CategoryProps = Record<string, unknown>

type CategoryIntroCacheEntry = {
    intro: TipsTip | null
    fetchedAt: number
    ttlMs: number
}

/**
 * TipsPanelService
 *
 * Hybrid model (verification-first):
 * - On start: discover categories from the sheet header only (categoryHeaderRow).
 * - Tips are fetched lazily per category as rotation needs them.
 * - Per-category cache TTL allows sheet edits at runtime to be picked up without restart.
 *
 * Safety properties:
 * - All SheetsGateway operations run in mode='background' (non-blocking pool), per config.
 * - No tip text is logged; only counts/ids.
 *
 * Per-client behavior:
 * - nextForClient(clientId) returns the next tip/page for that client.
 * - Each client has independent exhaustion state.
 * - Inactive clients are pruned opportunistically (no background thread).
 *
 * Option A (priority):
 * - Each category is 3 columns: image | text | priority
 * - Priority defaults to 0 when blank/invalid (strict=true escalates on non-empty invalid)
 * - Ordering within a category: priority desc; within same priority => randomized; exhaust-before-repeat.
 * - On wrap: reshuffle within priority tiers.
 *
 * NEW: Intro ("I") rule:
 * - If the priority cell is exactly "I" (case-insensitive), that row is the category intro.
 * - If multiple intro rows exist, the one with the lowest sheet row number wins.
 * - Intro does NOT participate in rotation/exhaustion/order.
 * - When a rotational tip from that category is shown, the intro is injected as page 1,
 *   followed by the rotational tip's pages.
 */
export class TipsPanelService {
    private readonly cfg: TipsServerConfig
    private readonly sheets: SheetsGateway
    private readonly log: ChannelLogger
    private readonly events: TipsPanelEventSink

    private timer: NodeJS.Timeout | null = null
    private stopped = false

    /**
     * Monotonic lifecycle version.
     *
     * Safety contract:
     * - Incremented on each start attempt and each stop.
     * - Async work captures the current version and must verify it before mutating state
     *   or publishing lifecycle-visible events.
     */
    private lifecycleVersion = 0

    private catalog: TipsCatalog | null = null
    private meta: CatalogMeta | null = null

    // Category cache (lazy)
    private readonly categoryCache = new Map<string, CategoryCacheEntry>()
    private readonly categoryLoadInflight = new Map<string, Promise<TipsTip[]>>()

    // Category intro cache (lazy; kept separate so intro does not enter rotation list)
    private readonly categoryIntroCache = new Map<string, CategoryIntroCacheEntry>()

    // Rotation state (GLOBAL): exhaust-before-repeat within each category
    private rrCatIdx = 0
    private rrTipPos: Record<string, number> = {}

    // GLOBAL priority-aware order (category -> indices)
    private rrOrder: Record<string, number[]> = {}

    // Current tip/page state (GLOBAL)
    private currentTip: TipsTip | null = null
    private currentPageIdx = 0

    // Per-client sessions
    private readonly clients = new Map<string, ClientSession>()

    // OPTIONAL: category properties parsed from the sheet (categoryPropsRow)
    private categoryProps: Record<string, CategoryProps> = {}

    // IMPORTANT: align with ws.ts env name to avoid split-brain TTLs.
    private readonly clientInactiveMs = clampMs(process.env.TIPS_CLIENT_TTL_MS, 60_000, 5_000)

    constructor(opts: {
        config: TipsServerConfig
        sheets: SheetsGateway
        logger: ChannelLogger
        events: TipsPanelEventSink
    }) {
        this.cfg = opts.config
        this.sheets = opts.sheets
        this.log = opts.logger
        this.events = opts.events
    }

    async start(): Promise<void> {
        if (this.timer) {
            this.log.debug('tips kind=tips-service-start-skip reason=already-started')
            return
        }

        this.stopped = false
        const runId = ++this.lifecycleVersion

        // Config summary (non-sensitive)
        this.log.info(
            'tips kind=tips-service-start enabled=' +
                bool01(this.cfg.enabled) +
                ` intervalMs=${safeNum(this.cfg.intervalMs, 0)}` +
                ` tab=${safeStr(this.cfg.tab, '')}` +
                ` cacheTtlMs=${safeNum(this.cfg.cacheTtlMs, 0)}` +
                ` strict=${bool01(this.cfg.strict)}` +
                ` defaultCategoriesCount=${
                    Array.isArray(this.cfg.defaultCategories) ? this.cfg.defaultCategories.length : 0
                }` +
                ` maxTextChars=${safeNum(this.cfg.maxTextChars, 0)}` +
                ` maxPagesPerTip=${safeNum(this.cfg.maxPagesPerTip, 0)}` +
                ` categoryHeaderRow=${safeNum((this.cfg as any).categoryHeaderRow, 0)}` +
                ` tipsStartRow=${safeNum((this.cfg as any).tipsStartRow, 0)}` +
                ` categoryPropsRow=${safeNum((this.cfg as any).categoryPropsRow, 0)}` +
                ` clientInactiveMs=${this.clientInactiveMs}`
        )

        if (!this.cfg.enabled) {
            this.log.warn('tips kind=tips-service-disabled enabled=false action=emit-error')
            this.events.publish({
                kind: 'tips-error',
                at: Date.now(),
                error: 'tips disabled (TIPS_ENABLED=false)',
            })
            return
        }

        if (!this.isLifecycleActive(runId)) {
            this.log.info(
                `tips kind=tips-service-start-abort reason=inactive-before-loading runId=${runId} currentRunId=${this.lifecycleVersion}`
            )
            return
        }

        this.events.publish({ kind: 'tips-loading', at: Date.now(), message: 'Loading tips…' })

        // Ensure host workers are started (idempotent)
        const initStarted = Date.now()
        this.log.info('tips kind=tips-sheets-init-start')
        await this.sheets.init()

        if (!this.isLifecycleActive(runId)) {
            this.log.info(
                `tips kind=tips-service-start-abort reason=inactive-after-sheets-init runId=${runId} currentRunId=${this.lifecycleVersion}`
            )
            return
        }

        this.log.info(`tips kind=tips-sheets-init-ok ms=${Date.now() - initStarted}`)

        // Category discovery only (header row). No full tip prefetch.
        const discoverStarted = Date.now()
        this.log.info('tips kind=tips-discover-start source=header-only')
        await this.refresh(runId).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err)
            this.log.error(
                `tips kind=tips-discover-failed ms=${Date.now() - discoverStarted} error=${msg}`
            )

            if (this.isLifecycleActive(runId)) {
                this.events.publish({ kind: 'tips-error', at: Date.now(), error: msg })
            } else {
                this.log.info(
                    `tips kind=tips-discover-error-suppressed reason=inactive runId=${runId} currentRunId=${this.lifecycleVersion}`
                )
            }

            if (this.cfg.strict) throw err
        })

        if (!this.isLifecycleActive(runId)) {
            this.log.info(
                `tips kind=tips-service-start-abort reason=inactive-after-discover runId=${runId} currentRunId=${this.lifecycleVersion}`
            )
            return
        }

        if (!this.cfg.strict) {
            this.log.info(`tips kind=tips-discover-done ms=${Date.now() - discoverStarted}`)
        }

        // Begin rotation timer (legacy/global)
        const intervalMs = this.safeIntervalMs(this.cfg.intervalMs)
        this.timer = setInterval(() => {
            void this.tick(runId)
        }, intervalMs)

        if (!this.isLifecycleActive(runId)) {
            if (this.timer) {
                clearInterval(this.timer)
                this.timer = null
            }
            this.log.info(
                `tips kind=tips-service-start-abort reason=inactive-after-timer-start runId=${runId} currentRunId=${this.lifecycleVersion}`
            )
            return
        }

        this.log.info(`tips kind=tips-rotation-start intervalMs=${intervalMs}`)
        this.events.publish({ kind: 'tips-ready', at: Date.now(), message: 'Tips service started' })
    }

    async stop(): Promise<void> {
        this.stopped = true
        this.lifecycleVersion += 1

        const hadTimer = !!this.timer

        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }

        const clientCount = this.clients.size
        this.clients.clear()

        this.log.info(
            `tips kind=tips-service-stop hadTimer=${bool01(hadTimer)} clientsCleared=${clientCount}`
        )
    }

    async nextForClient(clientIdRaw: string): Promise<TipsPanelCurrent | null> {
        const clientId = safeClientId(clientIdRaw)
        if (!clientId) {
            throw new Error('tips nextForClient: invalid clientId')
        }

        const runId = this.lifecycleVersion
        await this.ensureDiscoveryReady(runId)

        if (!this.isLifecycleActive(runId)) {
            throw new Error('tips nextForClient aborted: service stopped during discovery')
        }

        this.pruneInactiveClients()

        const session = this.getOrCreateClientSession(clientId)
        session.lastSeenAt = Date.now()

        if (session.inflight) {
            return await session.inflight
        }

        session.inflight = (async () => {
            const catalog = this.catalog
            const meta = this.meta
            if (!catalog || !meta) return null

            // Advance page if multi-page tip (per-client)
            if (session.currentTip && session.currentTip.pages.length > 1) {
                if (session.currentPageIdx < session.currentTip.pages.length - 1) {
                    session.currentPageIdx += 1
                    const c = session.currentTip
                    this.log.debug(
                        `tips kind=tips-client-page-advance clientId=${clientId} category=${c.category} tipId=${c.tipId} priority=${this.safePri(
                            c
                        )} pageIndex=${session.currentPageIdx} pageCount=${c.pages.length}`
                    )
                    return this.makeCurrent(c, session.currentPageIdx)
                }
            }

            const nextTipRaw = await this.nextTipAsyncForSession(session, catalog, meta, runId)
            if (!this.isLifecycleActive(runId)) return null

            if (!nextTipRaw) {
                this.log.warn(
                    `tips kind=tips-client-nextTip-none clientId=${clientId} eligibleCategories=${catalog.eligibleCategories.length} totalCategories=${catalog.categories.length}`
                )
                session.currentTip = null
                session.currentPageIdx = 0
                return null
            }

            // NEW: inject intro (page 1) if category has an intro tip.
            const nextTip = this.applyIntroIfPresent(nextTipRaw.category, nextTipRaw)

            session.currentTip = nextTip
            session.currentPageIdx = 0

            this.log.debug(
                `tips kind=tips-client-tip-advance clientId=${clientId} category=${nextTip.category} tipId=${nextTip.tipId} priority=${this.safePri(
                    nextTip
                )} pageIndex=0 pageCount=${nextTip.pages.length} hasIntro=${bool01(
                    this.hasIntro(nextTip.category)
                )}`
            )

            return this.makeCurrent(nextTip, 0)
        })()

        try {
            return await session.inflight
        } finally {
            session.inflight = null
        }
    }

    resetCategory(category: string): void {
        const cat = String(category ?? '').trim()
        if (!cat) return

        delete this.rrTipPos[cat]
        delete this.rrOrder[cat]
        this.categoryCache.delete(cat)
        this.categoryIntroCache.delete(cat)
        this.categoryLoadInflight.delete(cat)

        if (this.currentTip?.category === cat) {
            this.currentTip = null
            this.currentPageIdx = 0
        }

        for (const s of this.clients.values()) {
            delete s.rrTipPos[cat]
            delete s.rrOrder[cat]
            s.inflight = null
            if (s.currentTip?.category === cat) {
                s.currentTip = null
                s.currentPageIdx = 0
            }
        }

        this.log.info(`tips kind=tips-reset-category category=${cat} clients=${this.clients.size}`)
    }

    resetAll(): void {
        this.rrCatIdx = 0
        this.rrTipPos = {}
        this.rrOrder = {}
        this.categoryCache.clear()
        this.categoryIntroCache.clear()
        this.categoryLoadInflight.clear()
        this.currentTip = null
        this.currentPageIdx = 0

        for (const s of this.clients.values()) {
            s.rrCatIdx = 0
            s.rrTipPos = {}
            s.rrOrder = {}
            s.currentTip = null
            s.currentPageIdx = 0
            s.inflight = null
        }

        this.log.info(`tips kind=tips-reset-all clients=${this.clients.size}`)
    }

    private isLifecycleActive(runId: number): boolean {
        return !this.stopped && this.lifecycleVersion === runId
    }

    private safeIntervalMs(raw: number): number {
        const n = Number.isFinite(raw) ? Math.floor(raw) : 10_000
        if (n < 250) return 250
        return n
    }

    private safeCacheTtlMs(raw: number): number {
        const n = Number.isFinite(raw) ? Math.floor(raw) : 30_000
        if (n < 0) return 0
        return n
    }

    private getOrCreateClientSession(clientId: string): ClientSession {
        const existing = this.clients.get(clientId)
        if (existing) return existing

        const s: ClientSession = {
            clientId,
            lastSeenAt: Date.now(),
            rrCatIdx: 0,
            rrTipPos: {},
            rrOrder: {}, // REQUIRED by types.ts
            currentTip: null,
            currentPageIdx: 0,
            inflight: null,
        }
        this.clients.set(clientId, s)

        this.log.info(
            `tips kind=tips-client-registered clientId=${clientId} clients=${this.clients.size}`
        )
        return s
    }

    private pruneInactiveClients(): void {
        const now = Date.now()
        let removed = 0
        for (const [id, s] of this.clients.entries()) {
            const age = now - s.lastSeenAt
            if (age >= this.clientInactiveMs) {
                this.clients.delete(id)
                removed += 1
            }
        }
        if (removed > 0) {
            this.log.info(
                `tips kind=tips-client-prune removed=${removed} clients=${this.clients.size} inactiveMs=${this.clientInactiveMs}`
            )
        }
    }

    private async ensureDiscoveryReady(runId: number): Promise<void> {
        if (!this.cfg.enabled) {
            throw new Error('tips nextForClient called but TIPS_ENABLED=false')
        }

        if (!this.isLifecycleActive(runId)) {
            throw new Error('tips discovery aborted: service stopped')
        }

        await this.sheets.init()

        if (!this.isLifecycleActive(runId)) {
            throw new Error('tips discovery aborted: service stopped after sheets init')
        }

        if (this.catalog && this.meta) return

        const t0 = Date.now()
        this.log.info('tips kind=tips-discover-on-demand-start reason=nextForClient')
        await this.refresh(runId)

        if (!this.isLifecycleActive(runId)) {
            throw new Error('tips discovery aborted: service stopped after refresh')
        }

        this.log.info(`tips kind=tips-discover-on-demand-ok ms=${Date.now() - t0}`)
    }

    private resolveRowConfig(): {
        categoryHeaderRow: number
        tipsStartRow: number
        categoryPropsRow: number
    } {
        const rawHeader = clampRow1(safeNum((this.cfg as any).categoryHeaderRow, 1), 1)
        const rawTips = clampRow1(safeNum((this.cfg as any).tipsStartRow, 2), 2)

        const rawProps = safeNum((this.cfg as any).categoryPropsRow, 0)
        const propsRow = rawProps <= 0 ? 0 : clampRow1(rawProps, 1)

        if (rawTips <= rawHeader) {
            if (this.cfg.strict) {
                throw new Error(
                    `tips row config invalid: tipsStartRow (${rawTips}) must be > categoryHeaderRow (${rawHeader})`
                )
            }

            const adjusted = rawHeader + 1
            this.log.warn(
                `tips kind=tips-row-config-adjusted strict=0 categoryHeaderRow=${rawHeader} tipsStartRow=${rawTips} adjustedTipsStartRow=${adjusted}`
            )
            return {
                categoryHeaderRow: rawHeader,
                tipsStartRow: adjusted,
                categoryPropsRow: propsRow,
            }
        }

        return { categoryHeaderRow: rawHeader, tipsStartRow: rawTips, categoryPropsRow: propsRow }
    }

    async refresh(runId?: number): Promise<void> {
        if (runId !== undefined && !this.isLifecycleActive(runId)) {
            this.log.info(
                `tips kind=tips-refresh-abort reason=inactive-before-start runId=${runId} currentRunId=${this.lifecycleVersion}`
            )
            return
        }

        const tab = String(this.cfg.tab ?? '').trim()
        if (!tab) {
            this.log.error('tips kind=tips-refresh-invalid-config reason=empty-tab')
            throw new Error('tips refresh failed: TIPS_SHEETS_TAB is empty')
        }

        const prevEligible = this.catalog?.eligibleCategories ?? []

        const { categoryHeaderRow, categoryPropsRow } = this.resolveRowConfig()

        const started = Date.now()
        this.log.info(
            `tips kind=tips-refresh-start tab=${tab} mode=header-only categoryHeaderRow=${categoryHeaderRow}`
        )

        const sheet = await this.sheets.getSheetByName(tab)

        if (runId !== undefined && !this.isLifecycleActive(runId)) {
            this.log.info(
                `tips kind=tips-refresh-abort reason=inactive-after-getSheet runId=${runId} currentRunId=${this.lifecycleVersion}`
            )
            return
        }

        const rowCount =
            typeof sheet.rowCount === 'number' && sheet.rowCount > 0 ? sheet.rowCount : 500
        const colCount =
            typeof sheet.columnCount === 'number' && sheet.columnCount > 0 ? sheet.columnCount : 52

        const endColLetter = columnNumberToLetter(colCount)

        const headerRange = `${tab}!A${categoryHeaderRow}:${endColLetter}${categoryHeaderRow}`

        const cacheTtlMs = this.safeCacheTtlMs(this.cfg.cacheTtlMs)
        const bypassCache = cacheTtlMs === 0

        this.log.info(
            'tips kind=tips-sheets-valuesGet-start ' +
                `tab=${tab} range=${headerRange} mode=background majorDimension=ROWS ` +
                `cacheTtlMs=${cacheTtlMs} bypassCache=${bool01(bypassCache)} purpose=discover-categories`
        )

        const tGet = Date.now()
        const res = await this.sheets.valuesGet(headerRange, {
            mode: 'background',
            majorDimension: 'ROWS',
            cacheTtlMs,
            bypassCache,
            valueRenderOption: 'FORMATTED_VALUE',
        })

        if (runId !== undefined && !this.isLifecycleActive(runId)) {
            this.log.info(
                `tips kind=tips-refresh-abort reason=inactive-after-header-valuesGet runId=${runId} currentRunId=${this.lifecycleVersion}`
            )
            return
        }

        this.log.info(
            `tips kind=tips-sheets-valuesGet-ok ms=${Date.now() - tGet} range=${headerRange}`
        )

        const header = (res.values?.[0] ?? []) as (string | number | boolean | null)[]

        const tParse = Date.now()
        const meta = this.parseHeaderToMeta(tab, rowCount, colCount, endColLetter, header)
        const allCategories = Object.keys(meta.categories)
        this.log.info(
            `tips kind=tips-discover-ok ms=${Date.now() - tParse} totalCategories=${allCategories.length} headerCols=${header.length}`
        )

        // OPTIONAL: category properties row (aligned to category blocks; ignores pri column)
        this.categoryProps = {}
        if (categoryPropsRow > 0) {
            const propsRange = `${tab}!A${categoryPropsRow}:${endColLetter}${categoryPropsRow}`
            this.log.info(
                'tips kind=tips-category-props-valuesGet-start ' +
                    `tab=${tab} range=${propsRange} mode=background majorDimension=ROWS ` +
                    `cacheTtlMs=${cacheTtlMs} bypassCache=${bool01(bypassCache)} purpose=category-props`
            )

            const tProps = Date.now()
            const propsRes = await this.sheets.valuesGet(propsRange, {
                mode: 'background',
                majorDimension: 'ROWS',
                cacheTtlMs,
                bypassCache,
                valueRenderOption: 'FORMATTED_VALUE',
            })

            if (runId !== undefined && !this.isLifecycleActive(runId)) {
                this.log.info(
                    `tips kind=tips-refresh-abort reason=inactive-after-props-valuesGet runId=${runId} currentRunId=${this.lifecycleVersion}`
                )
                return
            }

            this.log.info(
                `tips kind=tips-category-props-valuesGet-ok ms=${Date.now() - tProps} range=${propsRange}`
            )

            const propsRowValues = (propsRes.values?.[0] ?? []) as (
                | string
                | number
                | boolean
                | null
            )[]
            const parsed = this.parseCategoryPropsRow(header, propsRowValues)
            this.categoryProps = parsed

            const count = Object.keys(parsed).length
            this.log.info(
                `tips kind=tips-category-props-parse-ok categoryPropsRow=${categoryPropsRow} categoriesWithProps=${count} totalCategories=${allCategories.length}`
            )
        } else {
            this.log.debug('tips kind=tips-category-props-skip reason=disabled categoryPropsRow=0')
        }

        let eligibleCategories = this.computeEligible(allCategories, this.cfg.defaultCategories)

        const stubEligible = this.parseStubCategoriesFromEnv()
        if (stubEligible.length > 0) {
            const discoveredSet = new Set(allCategories)
            const filtered = stubEligible.filter((c) => discoveredSet.has(c))
            eligibleCategories = filtered
            this.log.info(
                `tips kind=tips-eligible-stubbed count=${filtered.length} requested=${stubEligible.length} source=TIPS_STUB_CATEGORIES`
            )
        }

        const prevSet = new Set(prevEligible)
        const nextSet = new Set(eligibleCategories)
        const added: string[] = []
        const removed: string[] = []
        const kept: string[] = []

        for (const c of eligibleCategories) {
            if (!prevSet.has(c)) added.push(c)
            else kept.push(c)
        }
        for (const c of prevEligible) {
            if (!nextSet.has(c)) removed.push(c)
        }

        const eligibleChanged = added.length > 0 || removed.length > 0

        this.log.info(
            `tips kind=tips-eligible-refresh prev=${prevEligible.length} next=${eligibleCategories.length} ` +
                `added=${added.length} removed=${removed.length} kept=${kept.length} changed=${bool01(
                    eligibleChanged
                )}`
        )
        if (eligibleChanged) {
            if (added.length > 0)
                this.log.debug(`tips kind=tips-eligible-added categories=${added.join(',')}`)
            if (removed.length > 0)
                this.log.debug(`tips kind=tips-eligible-removed categories=${removed.join(',')}`)
        }

        if (runId !== undefined && !this.isLifecycleActive(runId)) {
            this.log.info(
                `tips kind=tips-refresh-abort reason=inactive-before-state-commit runId=${runId} currentRunId=${this.lifecycleVersion}`
            )
            return
        }

        this.meta = meta

        const byCategory: Record<string, TipsTip[]> = {}
        let totalLoadedTips = 0
        for (const cat of eligibleCategories) {
            const cached = this.categoryCache.get(cat)
            const tips = cached?.tips ?? []
            if (tips.length > 0) {
                byCategory[cat] = tips
                totalLoadedTips += tips.length
            }
        }

        this.catalog = {
            categories: allCategories,
            eligibleCategories,
            byCategory,
            totalTips: totalLoadedTips,
        }

        // Reset pointers for eligible categories (GLOBAL)
        this.rrCatIdx = 0
        this.rrTipPos = {}
        this.rrOrder = {}
        for (const cat of eligibleCategories) {
            this.rrTipPos[cat] = 0
        }

        // Reset pointers for eligible categories (PER-CLIENT)
        for (const s of this.clients.values()) {
            s.rrCatIdx = 0
            s.rrTipPos = {}
            s.rrOrder = {}
            s.currentTip = null
            s.currentPageIdx = 0
            s.inflight = null
        }

        if (eligibleChanged) {
            this.log.info(
                `tips kind=tips-rotation-pointers-reset reason=eligible-changed eligibleCategories=${eligibleCategories.length} clients=${this.clients.size}`
            )
        } else {
            this.log.debug(
                `tips kind=tips-rotation-pointers-reset reason=refresh eligibleCategories=${eligibleCategories.length} clients=${this.clients.size}`
            )
        }

        // Drop cache for categories that are no longer eligible.
        if (removed.length > 0) {
            for (const cat of removed) {
                this.categoryCache.delete(cat)
                this.categoryIntroCache.delete(cat)
                this.categoryLoadInflight.delete(cat)
                delete this.rrTipPos[cat]
                delete this.rrOrder[cat]
            }
            this.log.info(`tips kind=tips-category-cache-dropped removed=${removed.length}`)
        }

        if (this.currentTip && !eligibleCategories.includes(this.currentTip.category)) {
            this.log.info(
                `tips kind=tips-current-cleared reason=category-not-eligible category=${this.currentTip.category}`
            )
            this.currentTip = null
            this.currentPageIdx = 0
        }

        const ms = Date.now() - started
        this.log.info(
            `tips kind=tips-refresh-ok tab=${tab} totalCategories=${allCategories.length} eligibleCategories=${eligibleCategories.length} loadedTips=${totalLoadedTips} ms=${ms}`
        )

        this.events.publish({
            kind: 'tips-refreshed',
            at: Date.now(),
            totalTips: totalLoadedTips,
            totalCategories: allCategories.length,
        })
        this.events.publish({
            kind: 'tips-eligible-categories',
            at: Date.now(),
            categories: eligibleCategories,
        })

        if (!this.currentTip) {
            void this.tick(runId)
        }
    }

    private async tick(runId?: number): Promise<void> {
        if (this.stopped) {
            this.log.debug('tips kind=tips-tick-skip reason=stopped')
            return
        }

        if (runId !== undefined && !this.isLifecycleActive(runId)) {
            this.log.debug(
                `tips kind=tips-tick-skip reason=inactive-run runId=${runId} currentRunId=${this.lifecycleVersion}`
            )
            return
        }

        const catalog = this.catalog
        const meta = this.meta
        if (!catalog || !meta) {
            this.log.debug('tips kind=tips-tick-skip reason=no-catalog')
            return
        }

        if (this.currentTip && this.currentTip.pages.length > 1) {
            if (this.currentPageIdx < this.currentTip.pages.length - 1) {
                this.currentPageIdx += 1
                const c = this.currentTip
                this.log.debug(
                    'tips kind=tips-page-advance ' +
                        `category=${c.category} tipId=${c.tipId} priority=${this.safePri(
                            c
                        )} pageIndex=${this.currentPageIdx} pageCount=${c.pages.length}`
                )

                if (runId !== undefined && !this.isLifecycleActive(runId)) {
                    this.log.debug(
                        `tips kind=tips-tick-skip reason=inactive-before-page-publish runId=${runId} currentRunId=${this.lifecycleVersion}`
                    )
                    return
                }

                this.events.publish({
                    kind: 'tips-current',
                    at: Date.now(),
                    current: this.makeCurrent(c, this.currentPageIdx),
                })
                return
            }
        }

        const nextTipRaw = await this.nextTipAsync(catalog, meta, runId)

        if (runId !== undefined && !this.isLifecycleActive(runId)) {
            this.log.debug(
                `tips kind=tips-tick-skip reason=inactive-after-nextTip runId=${runId} currentRunId=${this.lifecycleVersion}`
            )
            return
        }

        if (!nextTipRaw) {
            this.log.warn(
                'tips kind=tips-nextTip-none eligibleCategories=' +
                    catalog.eligibleCategories.length +
                    ' totalCategories=' +
                    catalog.categories.length
            )
            return
        }

        // NEW: inject intro (page 1) if category has an intro tip.
        const nextTip = this.applyIntroIfPresent(nextTipRaw.category, nextTipRaw)

        this.currentTip = nextTip
        this.currentPageIdx = 0

        this.log.debug(
            'tips kind=tips-tip-advance ' +
                `category=${nextTip.category} tipId=${nextTip.tipId} priority=${this.safePri(
                    nextTip
                )} pageIndex=0 pageCount=${nextTip.pages.length} hasIntro=${bool01(
                    this.hasIntro(nextTip.category)
                )}`
        )

        this.events.publish({
            kind: 'tips-current',
            at: Date.now(),
            current: this.makeCurrent(nextTip, 0),
        })
    }

    private computeCategoryProgress(
        cat: string,
        listLen: number,
        rrTipPos: Record<string, number>
    ): { exhausted: number; remaining: number } {
        const pos = rrTipPos[cat] ?? 0
        const exhausted = Math.max(0, Math.min(pos, listLen))
        const remaining = Math.max(0, listLen - pos)
        return { exhausted, remaining }
    }

    private safePri(tip: TipsTip | null | undefined): number {
        const p = (tip as any)?.priority
        return typeof p === 'number' && Number.isFinite(p) ? Math.trunc(p) : 0
    }

    private hasIntro(category: string): boolean {
        const c = String(category ?? '').trim()
        if (!c) return false
        const entry = this.categoryIntroCache.get(c)
        return !!entry?.intro
    }

    private getIntro(category: string): TipsTip | null {
        const c = String(category ?? '').trim()
        if (!c) return null
        return this.categoryIntroCache.get(c)?.intro ?? null
    }

    private applyIntroIfPresent(category: string, tip: TipsTip): TipsTip {
        const intro = this.getIntro(category)
        if (!intro) return tip

        // Combine into a synthetic tip: intro is page 1, then the real tip pages.
        const combinedPages = [...(intro.pages ?? []), ...(tip.pages ?? [])]

        const maxPagesPerTip = this.safeMaxPages(this.cfg.maxPagesPerTip)
        if (combinedPages.length > maxPagesPerTip) {
            if (this.cfg.strict) {
                this.log.error(
                    `tips kind=tips-intro-combine-too-many-pages strict=1 category=${category} maxPagesPerTip=${maxPagesPerTip} combinedPages=${combinedPages.length}`
                )
                throw new Error(
                    `intro+tip exceeds maxPagesPerTip (${maxPagesPerTip}) category=${category}`
                )
            }
            this.log.warn(
                `tips kind=tips-intro-combine-truncate strict=0 category=${category} maxPagesPerTip=${maxPagesPerTip} combinedPages=${combinedPages.length}`
            )
            combinedPages.length = maxPagesPerTip
        }

        // IMPORTANT: keep the *selected* tipId/imageUrl/priority; intro is just injected pages.
        return {
            category: tip.category,
            tipId: tip.tipId,
            imageUrl: tip.imageUrl,
            pages: combinedPages,
            priority: tip.priority,
        }
    }

    /* ---------------------------------------------------------------------- */
    /*  Priority-aware ordering helpers                                        */
    /* ---------------------------------------------------------------------- */

    private shuffleInPlace(nums: number[]): void {
        for (let i = nums.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            const tmp = nums[i]
            nums[i] = nums[j]
            nums[j] = tmp
        }
    }

    private buildPriorityOrder(list: TipsTip[]): number[] {
        const byPri = new Map<number, number[]>()
        for (let i = 0; i < list.length; i++) {
            const pri = Number.isFinite(list[i]?.priority) ? Math.trunc(list[i].priority) : 0
            const arr = byPri.get(pri)
            if (arr) arr.push(i)
            else byPri.set(pri, [i])
        }

        const pris = Array.from(byPri.keys()).sort((a, b) => b - a)
        const out: number[] = []
        for (const pri of pris) {
            const idxs = byPri.get(pri) ?? []
            this.shuffleInPlace(idxs)
            for (const ix of idxs) out.push(ix)
        }
        return out
    }

    private getOrBuildGlobalOrder(cat: string, list: TipsTip[]): number[] {
        const existing = this.rrOrder[cat]
        if (Array.isArray(existing) && existing.length === list.length) return existing
        const order = this.buildPriorityOrder(list)
        this.rrOrder[cat] = order
        return order
    }

    private rebuildGlobalOrder(cat: string, list: TipsTip[]): number[] {
        const order = this.buildPriorityOrder(list)
        this.rrOrder[cat] = order
        return order
    }

    private getOrBuildSessionOrder(session: ClientSession, cat: string, list: TipsTip[]): number[] {
        const existing = session.rrOrder[cat]
        if (Array.isArray(existing) && existing.length === list.length) return existing
        const order = this.buildPriorityOrder(list)
        session.rrOrder[cat] = order
        return order
    }

    private rebuildSessionOrder(session: ClientSession, cat: string, list: TipsTip[]): number[] {
        const order = this.buildPriorityOrder(list)
        session.rrOrder[cat] = order
        return order
    }

    /* ---------------------------------------------------------------------- */
    /*  Pickers                                                                */
    /* ---------------------------------------------------------------------- */

    private async nextTipAsync(
        catalog: TipsCatalog,
        meta: CatalogMeta,
        runId?: number
    ): Promise<TipsTip | null> {
        const eligible = catalog.eligibleCategories
        if (eligible.length === 0) return null

        for (let tries = 0; tries < eligible.length; tries++) {
            if (runId !== undefined && !this.isLifecycleActive(runId)) return null

            const idx = (this.rrCatIdx + tries) % eligible.length
            const cat = eligible[idx]

            const list = await this.ensureCategoryLoaded(cat, meta, runId).catch((err) => {
                const msg = err instanceof Error ? err.message : String(err)
                this.log.error(`tips kind=tips-category-load-failed category=${cat} error=${msg}`)
                return [] as TipsTip[]
            })

            if (runId !== undefined && !this.isLifecycleActive(runId)) return null

            if (!list || list.length === 0) {
                this.log.debug(
                    `tips kind=tips-nextTip-skip category=${cat} reason=empty-list tries=${tries} idx=${idx}`
                )
                continue
            }

            const listLen = list.length
            const pos = this.rrTipPos[cat] ?? 0
            const willWrap = pos >= listLen
            const nextPos = willWrap ? 0 : pos

            const order = willWrap
                ? this.rebuildGlobalOrder(cat, list)
                : this.getOrBuildGlobalOrder(cat, list)

            const selectedIdx = order[nextPos] ?? nextPos
            const tip = list[selectedIdx]
            const pri = this.safePri(tip)

            if (willWrap) {
                this.log.info(
                    `tips kind=tips-category-wrap category=${cat} total=${listLen} reason=exhausted`
                )
            }

            this.rrTipPos[cat] = nextPos + 1
            this.rrCatIdx = idx + 1

            const { exhausted, remaining } = this.computeCategoryProgress(cat, listLen, this.rrTipPos)
            this.log.debug(
                `tips kind=tips-category-progress category=${cat} tipId=${tip?.tipId ?? 'unknown'} priority=${pri} ` +
                    `exhausted=${exhausted} remaining=${remaining} total=${listLen} wrapped=${bool01(willWrap)}`
            )

            if (remaining === 0) {
                this.log.info(
                    `tips kind=tips-category-exhausted category=${cat} exhausted=${exhausted} remaining=0 total=${listLen}`
                )
            }

            this.log.debug(
                'tips kind=tips-nextTip ' +
                    `category=${cat} idx=${idx} tries=${tries} pos=${pos} nextPos=${nextPos} listLen=${listLen} ` +
                    `selectedIdx=${selectedIdx} priority=${pri} hasIntro=${bool01(this.hasIntro(cat))} rrCatIdxNext=${this.rrCatIdx}`
            )

            return tip ?? null
        }

        return null
    }

    private async nextTipAsyncForSession(
        session: ClientSession,
        catalog: TipsCatalog,
        meta: CatalogMeta,
        runId?: number
    ): Promise<TipsTip | null> {
        const eligible = catalog.eligibleCategories
        if (eligible.length === 0) return null

        for (let tries = 0; tries < eligible.length; tries++) {
            if (runId !== undefined && !this.isLifecycleActive(runId)) return null

            const idx = (session.rrCatIdx + tries) % eligible.length
            const cat = eligible[idx]

            const list = await this.ensureCategoryLoaded(cat, meta, runId).catch((err) => {
                const msg = err instanceof Error ? err.message : String(err)
                this.log.error(
                    `tips kind=tips-client-category-load-failed clientId=${session.clientId} category=${cat} error=${msg}`
                )
                return [] as TipsTip[]
            })

            if (runId !== undefined && !this.isLifecycleActive(runId)) return null

            if (!list || list.length === 0) {
                this.log.debug(
                    `tips kind=tips-client-nextTip-skip clientId=${session.clientId} category=${cat} reason=empty-list tries=${tries} idx=${idx}`
                )
                continue
            }

            const listLen = list.length
            const pos = session.rrTipPos[cat] ?? 0
            const willWrap = pos >= listLen
            const nextPos = willWrap ? 0 : pos

            const order = willWrap
                ? this.rebuildSessionOrder(session, cat, list)
                : this.getOrBuildSessionOrder(session, cat, list)

            const selectedIdx = order[nextPos] ?? nextPos
            const tip = list[selectedIdx]
            const pri = this.safePri(tip)

            if (willWrap) {
                this.log.info(
                    `tips kind=tips-client-category-wrap clientId=${session.clientId} category=${cat} total=${listLen} reason=exhausted`
                )
            }

            session.rrTipPos[cat] = nextPos + 1
            session.rrCatIdx = idx + 1

            const { exhausted, remaining } = this.computeCategoryProgress(cat, listLen, session.rrTipPos)
            this.log.debug(
                `tips kind=tips-client-category-progress clientId=${session.clientId} category=${cat} tipId=${tip?.tipId ?? 'unknown'} priority=${pri} ` +
                    `exhausted=${exhausted} remaining=${remaining} total=${listLen} wrapped=${bool01(willWrap)}`
            )

            if (remaining === 0) {
                this.log.info(
                    `tips kind=tips-client-category-exhausted clientId=${session.clientId} category=${cat} exhausted=${exhausted} remaining=0 total=${listLen}`
                )
            }

            this.log.debug(
                `tips kind=tips-client-nextTip clientId=${session.clientId} category=${cat} idx=${idx} tries=${tries} ` +
                    `pos=${pos} nextPos=${nextPos} listLen=${listLen} selectedIdx=${selectedIdx} priority=${pri} hasIntro=${bool01(
                        this.hasIntro(cat)
                    )} rrCatIdxNext=${session.rrCatIdx}`
            )

            return tip ?? null
        }

        return null
    }

    private async ensureCategoryLoaded(
        category: string,
        meta: CatalogMeta,
        runId?: number
    ): Promise<TipsTip[]> {
        const cat = String(category ?? '').trim()
        if (!cat) return []

        if (runId !== undefined && !this.isLifecycleActive(runId)) return []

        const ttlMs = this.safeCacheTtlMs(this.cfg.cacheTtlMs)
        const now = Date.now()

        if (ttlMs > 0) {
            const cached = this.categoryCache.get(cat)
            const introCached = this.categoryIntroCache.get(cat)

            // Cache is valid only if BOTH (tips + intro marker state) are within their own TTL windows.
            if (cached && introCached) {
                const ageTips = now - cached.fetchedAt
                const ageIntro = now - introCached.fetchedAt

                const tipsOk = ageTips >= 0 && ageTips < cached.ttlMs
                const introOk = ageIntro >= 0 && ageIntro < introCached.ttlMs

                if (tipsOk && introOk) {
                    this.log.debug(
                        `tips kind=tips-category-cache-hit category=${cat} ageTipsMs=${ageTips} tipsTtlMs=${cached.ttlMs} ageIntroMs=${ageIntro} introTtlMs=${introCached.ttlMs} hasIntro=${bool01(
                            !!introCached.intro
                        )}`
                    )
                    return cached.tips
                }

                this.log.debug(
                    `tips kind=tips-category-cache-expired category=${cat} ageTipsMs=${ageTips} tipsTtlMs=${cached.ttlMs} tipsOk=${bool01(
                        tipsOk
                    )} ageIntroMs=${ageIntro} introTtlMs=${introCached.ttlMs} introOk=${bool01(
                        introOk
                    )}`
                )
            }
        }

        const inflight = this.categoryLoadInflight.get(cat)
        if (inflight) {
            this.log.debug(`tips kind=tips-category-load-join category=${cat}`)
            return await inflight
        }

        const p = this.loadCategoryFromSheets(cat, meta, ttlMs, runId)
        this.categoryLoadInflight.set(cat, p)

        try {
            const tips = await p
            return tips
        } finally {
            this.categoryLoadInflight.delete(cat)
        }
    }

    private async loadCategoryFromSheets(
        category: string,
        meta: CatalogMeta,
        ttlMs: number,
        runId?: number
    ): Promise<TipsTip[]> {
        const tab = meta.tab
        const cat = String(category ?? '').trim()
        const cm = meta.categories[cat]
        if (!cm) {
            this.log.warn(`tips kind=tips-category-load-skip category=${cat} reason=not-in-meta`)
            return []
        }

        if (runId !== undefined && !this.isLifecycleActive(runId)) {
            this.log.info(
                `tips kind=tips-category-fetch-abort reason=inactive-before-fetch category=${cat} runId=${runId} currentRunId=${this.lifecycleVersion}`
            )
            return []
        }

        const { tipsStartRow } = this.resolveRowConfig()

        // Option A: image|text|priority => always fetch through pri col
        const range = `${tab}!${cm.imgColLetter}${tipsStartRow}:${cm.priColLetter}${meta.rowCount}`

        const cacheTtlMs = ttlMs
        const bypassCache = cacheTtlMs === 0

        this.log.info(
            'tips kind=tips-category-fetch-start ' +
                `category=${cat} tab=${tab} range=${range} mode=background majorDimension=ROWS ` +
                `cacheTtlMs=${cacheTtlMs} bypassCache=${bool01(bypassCache)} tipsStartRow=${tipsStartRow}`
        )

        const priorLen = this.categoryCache.get(cat)?.tips?.length ?? -1
        const hadIntroBefore = !!this.categoryIntroCache.get(cat)?.intro

        const tGet = Date.now()
        const res = await this.sheets.valuesGet(range, {
            mode: 'background',
            majorDimension: 'ROWS',
            cacheTtlMs,
            bypassCache,
            valueRenderOption: 'FORMATTED_VALUE',
        })

        if (runId !== undefined && !this.isLifecycleActive(runId)) {
            this.log.info(
                `tips kind=tips-category-fetch-abort reason=inactive-after-valuesGet category=${cat} runId=${runId} currentRunId=${this.lifecycleVersion}`
            )
            return []
        }

        this.log.info(
            `tips kind=tips-category-fetch-ok category=${cat} ms=${Date.now() - tGet} range=${range}`
        )

        const valuesN = res.values ?? []
        const tParse = Date.now()
        const parsed = this.parseCategoryValuesSplit(cat, valuesN, tipsStartRow)
        const tips = parsed.tips
        const intro = parsed.intro
        /*
        this.log.info(
            `tips kind=tips-category-parse-ok category=${cat} ms=${Date.now() - tParse} tips=${tips.length} hasIntro=${bool01(
                !!intro
            )}`
        )
        */

        if (runId !== undefined && !this.isLifecycleActive(runId)) {
            this.log.info(
                `tips kind=tips-category-fetch-abort reason=inactive-before-cache-commit category=${cat} runId=${runId} currentRunId=${this.lifecycleVersion}`
            )
            return tips
        }

        if (priorLen >= 0 && priorLen !== tips.length) {
            this.log.info(
                `tips kind=tips-category-updated category=${cat} oldTips=${priorLen} newTips=${tips.length} source=refetch`
            )
        }

        const hasIntroNow = !!intro
        if (hadIntroBefore !== hasIntroNow) {
            this.log.info(
                `tips kind=tips-category-intro-changed category=${cat} hadIntro=${bool01(
                    hadIntroBefore
                )} hasIntro=${bool01(hasIntroNow)}`
            )
        }

        const now = Date.now()
        if (ttlMs > 0) {
            this.categoryCache.set(cat, { tips, fetchedAt: now, ttlMs })
            this.categoryIntroCache.set(cat, { intro, fetchedAt: now, ttlMs })
        } else {
            this.categoryCache.delete(cat)
            this.categoryIntroCache.delete(cat)
        }

        if (this.catalog) {
            this.catalog.byCategory[cat] = tips
            this.catalog.totalTips = this.computeLoadedTipsTotal(this.catalog)
        }

        return tips
    }

    private computeLoadedTipsTotal(catalog: TipsCatalog): number {
        let total = 0
        for (const cat of catalog.eligibleCategories) {
            total += catalog.byCategory[cat]?.length ?? 0
        }
        return total
    }

    private makeCurrent(tip: TipsTip, pageIndex: number): TipsPanelCurrent {
        const pageCount = tip.pages.length
        const safeIdx = Math.max(0, Math.min(pageIndex, Math.max(0, pageCount - 1)))
        const text = tip.pages[safeIdx] ?? ''

        const props = this.categoryProps?.[tip.category]
        const title =
            props && typeof (props as any).title === 'string' && String((props as any).title).trim()
                ? String((props as any).title).trim()
                : tip.category

        return {
            category: tip.category,
            tipId: tip.tipId,
            pageIndex: safeIdx,
            pageCount,
            text,
            imageUrl: tip.imageUrl,
            shownAt: Date.now(),
            categoryTitle: title,
            categoryProps: props ?? undefined,
        } as any as TipsPanelCurrent
    }

    private parseHeaderToMeta(
        tab: string,
        rowCount: number,
        colCount: number,
        endColLetter: string,
        header: (string | number | boolean | null)[]
    ): CatalogMeta {
        const categories: Record<string, CategoryMeta> = {}

        const cols = Array.isArray(header) ? header.length : 0
        this.log.info(
            `tips kind=tips-header-parse-start tab=${tab} headerCols=${cols} rowCount=${rowCount} colCount=${colCount}`
        )

        // Option A: 3 columns per category (img, txt, pri)
        for (let col = 0; col < header.length; col += 3) {
            const imgHeader = header[col]
            const txtHeader = header[col + 1]
            // pri header is header[col + 2] (ignored for name)

            const rightName = txtHeader == null ? '' : String(txtHeader).trim()
            const leftName = imgHeader == null ? '' : String(imgHeader).trim()
            const category = rightName || leftName
            if (!category) continue

            const imgColNumber = col + 1
            const txtColNumber = col + 2
            const priColNumber = col + 3

            if (imgColNumber > colCount || txtColNumber > colCount || priColNumber > colCount)
                continue

            const imgColLetter = columnNumberToLetter(imgColNumber)
            const txtColLetter = columnNumberToLetter(txtColNumber)
            const priColLetter = columnNumberToLetter(priColNumber)

            if (!categories[category]) {
                categories[category] = {
                    category,
                    imgColLetter,
                    txtColLetter,
                    priColLetter,
                    imgColNumber,
                    txtColNumber,
                    priColNumber,
                }
            }
        }

        const totalCategories = Object.keys(categories).length
        this.log.info(
            `tips kind=tips-header-parse-done tab=${tab} totalCategories=${totalCategories} endCol=${endColLetter}`
        )

        for (const c of Object.keys(categories)) {
            const m = categories[c]
            this.log.debug(
                `tips kind=tips-category-meta category=${c} imgCol=${m.imgColLetter} txtCol=${m.txtColLetter} priCol=${m.priColLetter} imgColNum=${m.imgColNumber} txtColNum=${m.txtColNumber} priColNum=${m.priColNumber}`
            )
        }

        return {
            tab,
            rowCount,
            colCount,
            endColLetter,
            categories,
        }
    }

    private parseCategoryPropsRow(
        header: (string | number | boolean | null)[],
        propsRow: (string | number | boolean | null)[]
    ): Record<string, CategoryProps> {
        const out: Record<string, CategoryProps> = {}

        const headerLen = Array.isArray(header) ? header.length : 0
        const propsLen = Array.isArray(propsRow) ? propsRow.length : 0
        this.log.info(
            `tips kind=tips-category-props-parse-start headerCols=${headerLen} propsCols=${propsLen}`
        )

        // Option A: 3 columns per category; props prefer TEXT cell (middle), fallback to IMAGE cell (left).
        for (let col = 0; col < headerLen; col += 3) {
            const imgHeader = header[col]
            const txtHeader = header[col + 1]

            const rightName = txtHeader == null ? '' : String(txtHeader).trim()
            const leftName = imgHeader == null ? '' : String(imgHeader).trim()
            const category = rightName || leftName
            if (!category) continue

            const vRight = propsRow[col + 1] // text cell
            const vLeft = propsRow[col] // image cell
            const raw =
                vRight != null && String(vRight).trim()
                    ? String(vRight).trim()
                    : vLeft != null && String(vLeft).trim()
                      ? String(vLeft).trim()
                      : ''

            if (!raw) continue

            let parsed: unknown
            try {
                parsed = JSON.parse(raw)
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                if (this.cfg.strict) {
                    throw new Error(
                        `categoryPropsRow JSON parse failed category=${category} error=${msg}`
                    )
                }
                this.log.warn(
                    `tips kind=tips-category-props-json-invalid strict=0 category=${category} error=${msg}`
                )
                continue
            }

            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                if (this.cfg.strict) {
                    throw new Error(`categoryPropsRow JSON must be an object category=${category}`)
                }
                this.log.warn(
                    `tips kind=tips-category-props-json-not-object strict=0 category=${category}`
                )
                continue
            }

            out[category] = parsed as CategoryProps
        }

        this.log.info(
            `tips kind=tips-category-props-parse-done categoriesWithProps=${Object.keys(out).length}`
        )
        return out
    }

    private isIntroMarker(raw: unknown): boolean {
        if (typeof raw !== 'string') return false
        const s = raw.trim()
        if (s.length !== 1) return false
        return s.toLowerCase() === 'i'
    }

    private parsePriorityCell(args: { category: string; sheetRow: number; raw: unknown }): number {
        const raw = args.raw
        if (raw == null) return 0

        if (typeof raw === 'string' && !raw.trim()) return 0

        // NOTE: intro marker ("I") is handled by the caller, not here.
        const n =
            typeof raw === 'number'
                ? raw
                : typeof raw === 'string'
                  ? Number(raw.trim())
                  : NaN

        if (Number.isFinite(n)) return Math.trunc(n)

        const msg = `tips priority invalid category=${args.category} row=${args.sheetRow}`
        if (this.cfg.strict) {
            this.log.error(`tips kind=tips-priority-invalid strict=1 ${msg}`)
            throw new Error(`invalid priority value (${args.category}:r${args.sheetRow})`)
        }
        this.log.warn(`tips kind=tips-priority-invalid strict=0 ${msg}`)
        return 0
    }

    private parseCategoryValuesSplit(
        category: string,
        valuesNcol: (string | number | boolean | null)[][],
        tipsStartRow: number
    ): { tips: TipsTip[]; intro: TipsTip | null } {
        const maxTextChars = this.safeMaxTextChars(this.cfg.maxTextChars)
        const maxPagesPerTip = this.safeMaxPages(this.cfg.maxPagesPerTip)
        const delim = String(this.cfg.pageDelim ?? '').trim()

        const rows = Array.isArray(valuesNcol) ? valuesNcol.length : 0
        this.log.info(
            `tips kind=tips-category-parse-start category=${category} rows=${rows} tipsStartRow=${tipsStartRow} maxTextChars=${maxTextChars} maxPagesPerTip=${maxPagesPerTip} delimPresent=${bool01(
                !!delim
            )}`
        )

        const tips: TipsTip[] = []
        let intro: TipsTip | null = null

        for (let r = 0; r < valuesNcol.length; r++) {
            const row = valuesNcol[r] ?? []
            const rawImg = row[0]
            const rawTxt = row[1]
            const rawPri = row[2]

            const img = rawImg == null ? '' : String(rawImg).trim()
            const txt = rawTxt == null ? '' : String(rawTxt).trim()

            if (!txt) continue

            const sheetRow = tipsStartRow + r
            const imageUrl = img ? img : null

            const pagesRaw = this.splitPages(txt, delim)
            const pagesBounded = this.boundPages(pagesRaw, maxPagesPerTip, maxTextChars)

            // NEW: Intro marker ("I") in priority cell (case-insensitive), exactly one letter.
            if (this.isIntroMarker(rawPri)) {
                if (!intro) {
                    intro = {
                        category,
                        tipId: `${category}:r${sheetRow}:intro`,
                        imageUrl,
                        pages: pagesBounded,
                        // Intro does not have a priority; keep numeric field for compatibility.
                        priority: 0,
                    }
                    this.log.info(
                        `tips kind=tips-category-intro-detected category=${category} introTipId=${intro.tipId} row=${sheetRow}`
                    )
                } else {
                    // Multiple intro rows: keep the first (lowest sheet row).
                    this.log.debug(
                        `tips kind=tips-category-intro-skip category=${category} reason=already-have-intro row=${sheetRow}`
                    )
                }
                continue
            }

            const tipId = `${category}:r${sheetRow}`
            const priority = this.parsePriorityCell({ category, sheetRow, raw: rawPri })

            tips.push({
                category,
                tipId,
                imageUrl,
                pages: pagesBounded,
                priority,
            })
        }

        /*
        this.log.info(
            `tips kind=tips-category-parse-done category=${category} tips=${tips.length} hasIntro=${bool01(
                !!intro
            )}`
        )
        */

        return { tips, intro }
    }

    private parseStubCategoriesFromEnv(): string[] {
        const raw = String(process.env.TIPS_STUB_CATEGORIES ?? '').trim()
        if (!raw) return []

        const parts = raw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)

        const seen = new Set<string>()
        const out: string[] = []
        for (const p of parts) {
            if (seen.has(p)) continue
            seen.add(p)
            out.push(p)
        }
        return out
    }

    private safeMaxTextChars(raw: number): number {
        const n = Number.isFinite(raw) ? Math.floor(raw) : 4000
        if (n < 1) return 1
        return n
    }

    private safeMaxPages(raw: number): number {
        const n = Number.isFinite(raw) ? Math.floor(raw) : 10
        if (n < 1) return 1
        return n
    }

    private splitPages(text: string, delim: string): string[] {
        const t = String(text ?? '').trim()
        if (!t) return []
        if (!delim) return [t]

        if (!t.includes(delim)) return [t]
        return t
            .split(delim)
            .map((p) => p.trim())
            .filter((p) => p.length > 0)
    }

    private boundPages(pages: string[], maxPages: number, maxChars: number): string[] {
        const out: string[] = []
        for (let i = 0; i < pages.length && out.length < maxPages; i++) {
            let p = pages[i] ?? ''
            if (p.length > maxChars) {
                if (this.cfg.strict) {
                    this.log.error(
                        `tips kind=tips-page-too-long strict=1 maxTextChars=${maxChars} pageChars=${p.length}`
                    )
                    throw new Error(`tip page exceeds maxTextChars (${maxChars})`)
                }
                this.log.warn(
                    `tips kind=tips-page-truncate strict=0 maxTextChars=${maxChars} pageChars=${p.length}`
                )
                p = p.slice(0, maxChars)
            }
            out.push(p)
        }
        return out.length > 0 ? out : ['']
    }

    private computeEligible(all: string[], defaults: string[]): string[] {
        const cleanedAll = all.map((s) => String(s).trim()).filter(Boolean)
        const cleanedDefaults = (defaults ?? []).map((s) => String(s).trim()).filter(Boolean)

        if (cleanedDefaults.length === 0) return cleanedAll

        const set = new Set(cleanedAll)
        const out: string[] = []
        for (const d of cleanedDefaults) {
            if (set.has(d)) out.push(d)
        }
        return out
    }
}
