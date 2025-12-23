// apps/web/src/stores/logs.ts
import { defineStore } from 'pinia'

export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export type LogChannel =
    | 'orchestrator'
    | 'sidecar'
    | 'ffmpeg'
    | 'stream'
    | 'ocr'
    | 'device'
    | 'benchmark'
    | 'websocket'
    | 'app'
    | 'request'
    | 'powermeter'
    | 'serial-printer'
    | (string & {}) // allow future/unknown channels without breaking types

export interface ClientLog {
    ts: number
    channel: LogChannel
    emoji: string
    color:
        | 'blue'
        | 'yellow'
        | 'green'
        | 'magenta'
        | 'cyan'
        | 'red'
        | 'white'
        | 'purple'
        | (string & {})
    level: ClientLogLevel
    message: string
}

export type ServerConfig = {
    logs?: {
        snapshot?: number
        capacity?: number
        allowedChannels?: string[]
        minLevel?: ClientLogLevel
    }
    ws?: {
        heartbeatIntervalMs?: number
        heartbeatTimeoutMs?: number
        reconnectEnabled?: boolean
        reconnectMinMs?: number
        reconnectMaxMs?: number
        reconnectFactor?: number
        reconnectJitter?: number
    }
}

const LEVEL_ORDER: Record<ClientLogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    fatal: 50
}

// Local storage key for persisting UI preferences (fallback only)
// NOTE: legacy global key. We keep it for backward-compat + migration.
const STORAGE_KEY = 'logs:ui'

// Per-pane storage key prefix (new)
const STORAGE_KEY_PANE_PREFIX = 'logs:ui:pane:'

// Default pane id used when callers do not provide one (back-compat)
const DEFAULT_PANE_ID = 'default'

export type UiStatePersisted = {
    selectedChannels?: LogChannel[]
    minLevel?: ClientLogLevel
    autoscroll?: boolean
    searchText?: string
    capacity?: number
    useChannelFilter?: boolean
    sortDir?: 'asc' | 'desc'
}

type ApplyPrefsOptions = {
    /**
     * When true, writes the resulting state to localStorage.
     * Default is false so that applying profile-driven prefs does not
     * accidentally overwrite the local fallback store.
     */
    persist?: boolean
    /**
     * When true, capacity changes are applied to the store (and log array is capped).
     * Default true.
     */
    applyCapacity?: boolean
}

function isValidLevel(x: any): x is ClientLogLevel {
    return typeof x === 'string' && x in LEVEL_ORDER
}
function isValidSortDir(x: any): x is 'asc' | 'desc' {
    return x === 'asc' || x === 'desc'
}
function asFinitePositiveInt(x: any): number | null {
    const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN
    if (!Number.isFinite(n)) return null
    const v = Math.floor(n)
    return v > 0 ? v : null
}
function dedupChannels(x: any): LogChannel[] | null {
    if (!Array.isArray(x)) return null
    const cleaned = x
        .map((c) => (typeof c === 'string' ? (c as LogChannel) : null))
        .filter(Boolean) as LogChannel[]
    if (cleaned.length === 0) return []
    return Array.from(new Set(cleaned)) as LogChannel[]
}

function normalizePaneId(paneId?: string | null): string {
    const id = String(paneId ?? '').trim()
    return id || DEFAULT_PANE_ID
}

type PaneUiState = {
    // Channel filtering is OFF by default. When off: show all channels regardless of selections.
    useChannelFilter: boolean
    // Selected channels to include when filtering is ON.
    selectedChannels: LogChannel[]
    minLevel: ClientLogLevel
    autoscroll: boolean
    // keyword filter (client-side)
    searchText: string
    // sorting: newest first by default
    sortDir: 'asc' | 'desc'
    // internal: one-time hydration guard (per-pane)
    _hydrated: boolean
}

function makeDefaultPaneUiState(): PaneUiState {
    return {
        useChannelFilter: false,
        selectedChannels: [],
        minLevel: 'debug',
        autoscroll: true,
        searchText: '',
        sortDir: 'desc',
        _hydrated: false
    }
}

export const useLogs = defineStore('logs', {
    state: () => ({
        // Logs ingestion state is global (shared). UI prefs can be per-pane.
        capacity: Number(import.meta.env.VITE_CLIENT_LOGS_CAPACITY ?? 500) as number,
        items: [] as ClientLog[],

        // --- LEGACY UI / filter state (DEFAULT pane mirror) ---
        // These remain so existing panes/components keep working until they’re updated
        // to pass a paneId and use the per-pane APIs below.
        useChannelFilter: false as boolean,
        selectedChannels: [] as LogChannel[],
        minLevel: 'debug' as ClientLogLevel,
        autoscroll: true as boolean,
        paused: false as boolean,
        searchText: '' as string,
        sortDir: 'desc' as 'asc' | 'desc',

        // internal: one-time hydration guard (legacy)
        _hydrated: false as boolean,

        // --- NEW: per-pane UI state ---
        panes: {} as Record<string, PaneUiState>
    }),
    getters: {
        size: (s) => s.items.length,

        /** Unique list of channels present in current items; sorted by first-seen order */
        availableChannels: (s): LogChannel[] => {
            const seen = new Set<LogChannel>()
            const list: LogChannel[] = []
            for (const e of s.items) {
                if (!seen.has(e.channel)) {
                    seen.add(e.channel)
                    list.push(e.channel)
                }
            }
            return list
        },

        /** Map channel -> latest color observed (for legend dots) */
        channelColors: (s): Record<string, string> => {
            const map: Record<string, string> = {}
            for (const e of s.items) {
                map[e.channel] = e.color
            }
            return map
        },

        /**
         * LEGACY: filtered items using the DEFAULT pane’s UI state.
         * Kept for compatibility with existing components.
         */
        filteredItems: (s): ClientLog[] => {
            const source = s.items
            const channelFilterOn = !!s.useChannelFilter
            const hasSelected = s.selectedChannels.length > 0
            const minOrder = LEVEL_ORDER[s.minLevel] ?? LEVEL_ORDER.debug
            const q = (s.searchText || '').trim().toLowerCase()
            const doSearch = q.length > 0

            // If literally no filters and default level, just sort.
            if (!channelFilterOn && minOrder === LEVEL_ORDER.debug && !doSearch) {
                const out = source.slice()
                if (s.sortDir === 'desc') out.sort((a, b) => b.ts - a.ts)
                else out.sort((a, b) => a.ts - b.ts)
                return out
            }

            const allowed =
                channelFilterOn && hasSelected ? new Set<LogChannel>(s.selectedChannels) : null

            const filtered = source.filter((e) => {
                // Channel include-only (when ON). If ON and none selected -> show nothing.
                if (channelFilterOn) {
                    if (!allowed) return false
                    if (!allowed.has(e.channel)) return false
                }

                // Level
                const lvl = LEVEL_ORDER[e.level] ?? LEVEL_ORDER.debug
                if (lvl < minOrder) return false

                // Search
                if (doSearch) {
                    const hay1 = e.message?.toLowerCase() ?? ''
                    const hay2 = String(e.channel ?? '').toLowerCase()
                    const hay3 = String(e.emoji ?? '').toLowerCase()
                    if (
                        hay1.indexOf(q) === -1 &&
                        hay2.indexOf(q) === -1 &&
                        hay3.indexOf(q) === -1
                    )
                        return false
                }
                return true
            })

            if (s.sortDir === 'desc') filtered.sort((a, b) => b.ts - a.ts)
            else filtered.sort((a, b) => a.ts - b.ts)

            return filtered
        },

        /**
         * NEW: filtered items by pane id (per-pane prefs).
         * Usage: logs.filteredItemsFor(paneId)
         */
        filteredItemsFor:
            (s) =>
            (paneId?: string | null): ClientLog[] => {
                const id = normalizePaneId(paneId)
                const ui: PaneUiState = s.panes[id] ?? makeDefaultPaneUiState()

                const source = s.items
                const channelFilterOn = !!ui.useChannelFilter
                const hasSelected = ui.selectedChannels.length > 0
                const minOrder = LEVEL_ORDER[ui.minLevel] ?? LEVEL_ORDER.debug
                const q = (ui.searchText || '').trim().toLowerCase()
                const doSearch = q.length > 0

                // If literally no filters and default level, just sort.
                if (!channelFilterOn && minOrder === LEVEL_ORDER.debug && !doSearch) {
                    const out = source.slice()
                    if (ui.sortDir === 'desc') out.sort((a, b) => b.ts - a.ts)
                    else out.sort((a, b) => a.ts - b.ts)
                    return out
                }

                const allowed =
                    channelFilterOn && hasSelected ? new Set<LogChannel>(ui.selectedChannels) : null

                const filtered = source.filter((e) => {
                    // Channel include-only (when ON). If ON and none selected -> show nothing.
                    if (channelFilterOn) {
                        if (!allowed) return false
                        if (!allowed.has(e.channel)) return false
                    }

                    // Level
                    const lvl = LEVEL_ORDER[e.level] ?? LEVEL_ORDER.debug
                    if (lvl < minOrder) return false

                    // Search
                    if (doSearch) {
                        const hay1 = e.message?.toLowerCase() ?? ''
                        const hay2 = String(e.channel ?? '').toLowerCase()
                        const hay3 = String(e.emoji ?? '').toLowerCase()
                        if (
                            hay1.indexOf(q) === -1 &&
                            hay2.indexOf(q) === -1 &&
                            hay3.indexOf(q) === -1
                        )
                            return false
                    }
                    return true
                })

                if (ui.sortDir === 'desc') filtered.sort((a, b) => b.ts - a.ts)
                else filtered.sort((a, b) => a.ts - b.ts)

                return filtered
            },

        /**
         * NEW: get the effective UI state for a pane (copy, not reactive).
         * Usage: logs.getPaneUi(paneId)
         */
        getPaneUi:
            (s) =>
            (paneId?: string | null): PaneUiState => {
                const id = normalizePaneId(paneId)
                const ui = s.panes[id]
                return ui
                    ? { ...ui, selectedChannels: ui.selectedChannels.slice() }
                    : makeDefaultPaneUiState()
            }
    },
    actions: {
        /* -----------------------
           Internal helpers
        ------------------------ */
        _paneStorageKey(paneId?: string | null): string {
            const id = normalizePaneId(paneId)
            return `${STORAGE_KEY_PANE_PREFIX}${id}`
        },

        _ensurePane(paneId?: string | null): PaneUiState {
            const id = normalizePaneId(paneId)
            if (!this.panes[id]) {
                this.panes[id] = makeDefaultPaneUiState()
                // If this is the default pane, mirror legacy fields on creation.
                if (id === DEFAULT_PANE_ID) this._syncLegacyFromPane(DEFAULT_PANE_ID)
            }
            return this.panes[id]
        },

        _syncLegacyFromPane(paneId?: string | null) {
            const id = normalizePaneId(paneId)
            if (id !== DEFAULT_PANE_ID) return
            const ui = this._ensurePane(DEFAULT_PANE_ID)
            this.useChannelFilter = !!ui.useChannelFilter
            this.selectedChannels = ui.selectedChannels.slice()
            this.minLevel = ui.minLevel
            this.autoscroll = !!ui.autoscroll
            this.searchText = ui.searchText ?? ''
            this.sortDir = ui.sortDir
        },

        _syncPaneFromLegacy(paneId?: string | null) {
            const id = normalizePaneId(paneId)
            if (id !== DEFAULT_PANE_ID) return
            const ui = this._ensurePane(DEFAULT_PANE_ID)
            ui.useChannelFilter = !!this.useChannelFilter
            ui.selectedChannels = this.selectedChannels.slice()
            ui.minLevel = this.minLevel
            ui.autoscroll = !!this.autoscroll
            ui.searchText = this.searchText ?? ''
            ui.sortDir = this.sortDir
        },

        /* -----------------------
           Log ingestion (global)
        ------------------------ */

        /** Replace current list with newest N logs from history (already bounded server-side). */
        replaceHistory(entries: ClientLog[]) {
            if (!Array.isArray(entries) || entries.length === 0) return
            const capped = entries.slice(-this.capacity)
            this.items = capped
        },

        /** Append a single live log; enforce capacity. */
        append(entry: ClientLog) {
            this.items.push(entry)
            const over = this.items.length - this.capacity
            if (over > 0) this.items.splice(0, over)
        },

        /** Optional: change capacity at runtime (preserve most recent). */
        setCapacity(n: number) {
            const cap = Number.isFinite(n) && n > 0 ? Math.floor(n) : this.capacity
            this.capacity = cap
            const over = this.items.length - cap
            if (over > 0) this.items.splice(0, over)

            // Persist capacity to legacy/global localStorage for backward-compat
            this._saveUiLegacy()
        },

        /** Clear all logs (client-side only). */
        clear() {
            this.items = []
        },

        /* -------------------------------------------------
           NEW: Export / Import prefs (per-pane capable)
        -------------------------------------------------- */

        /**
         * LEGACY: Export DEFAULT pane prefs in a serializable format.
         * Kept so existing profile wiring continues to work until updated.
         */
        exportPrefs(): UiStatePersisted {
            // Ensure default pane exists, and prefer pane state if present.
            const ui = this._ensurePane(DEFAULT_PANE_ID)
            return {
                selectedChannels: ui.selectedChannels.slice(),
                minLevel: ui.minLevel,
                autoscroll: ui.autoscroll,
                searchText: ui.searchText,
                capacity: this.capacity,
                useChannelFilter: ui.useChannelFilter,
                sortDir: ui.sortDir
            }
        },

        /**
         * NEW: Export prefs for a specific pane id.
         * This is what layout profiles should store when panes are independent.
         */
        exportPrefsFor(paneId?: string | null): UiStatePersisted {
            const id = normalizePaneId(paneId)
            const ui = this._ensurePane(id)
            return {
                selectedChannels: ui.selectedChannels.slice(),
                minLevel: ui.minLevel,
                autoscroll: ui.autoscroll,
                searchText: ui.searchText,
                capacity: this.capacity,
                useChannelFilter: ui.useChannelFilter,
                sortDir: ui.sortDir
            }
        },

        /**
         * LEGACY: Apply prefs to DEFAULT pane with validation/coercion.
         * By default, does NOT persist to localStorage.
         */
        applyPrefs(prefs?: UiStatePersisted | null, opts: ApplyPrefsOptions = {}) {
            this.applyPrefsFor(DEFAULT_PANE_ID, prefs, opts)
        },

        /**
         * NEW: Apply prefs to a specific pane.
         * By default, does NOT persist to localStorage (local is a fallback store).
         */
        applyPrefsFor(paneId: string | null | undefined, prefs?: UiStatePersisted | null, opts: ApplyPrefsOptions = {}) {
            if (!prefs || typeof prefs !== 'object') return

            const id = normalizePaneId(paneId)
            const ui = this._ensurePane(id)

            const applyCapacity = opts.applyCapacity !== false

            const nextSelected = dedupChannels((prefs as any).selectedChannels)
            if (nextSelected !== null) ui.selectedChannels = nextSelected

            const nextMinLevel = (prefs as any).minLevel
            if (isValidLevel(nextMinLevel)) ui.minLevel = nextMinLevel

            const nextAutoscroll = (prefs as any).autoscroll
            if (typeof nextAutoscroll === 'boolean') ui.autoscroll = nextAutoscroll

            const nextSearchText = (prefs as any).searchText
            if (typeof nextSearchText === 'string') ui.searchText = nextSearchText

            const nextUseChannelFilter = (prefs as any).useChannelFilter
            if (typeof nextUseChannelFilter === 'boolean') ui.useChannelFilter = nextUseChannelFilter

            const nextSortDir = (prefs as any).sortDir
            if (isValidSortDir(nextSortDir)) ui.sortDir = nextSortDir

            if (applyCapacity) {
                const nextCap = asFinitePositiveInt((prefs as any).capacity)
                if (nextCap != null && nextCap !== this.capacity) {
                    this.capacity = nextCap
                    const over = this.items.length - this.capacity
                    if (over > 0) this.items.splice(0, over)
                }
            }

            if (id === DEFAULT_PANE_ID) this._syncLegacyFromPane(DEFAULT_PANE_ID)

            if (opts.persist) this._saveUiFor(id)
        },

        /* -------------------------------------------------
           Persistence helpers (localStorage fallback)
        -------------------------------------------------- */

        /**
         * LEGACY: save DEFAULT pane to legacy key.
         * Kept so old code paths don’t break.
         */
        _saveUiLegacy() {
            try {
                // Make sure legacy fields reflect the default pane before saving legacy.
                this._syncLegacyFromPane(DEFAULT_PANE_ID)
                const payload: UiStatePersisted = {
                    selectedChannels: this.selectedChannels,
                    minLevel: this.minLevel,
                    autoscroll: this.autoscroll,
                    searchText: this.searchText,
                    capacity: this.capacity,
                    useChannelFilter: this.useChannelFilter,
                    sortDir: this.sortDir
                }
                localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
            } catch {
                // ignore storage failures
            }
        },

        /**
         * NEW: save a specific pane to its own localStorage key.
         */
        _saveUiFor(paneId?: string | null) {
            const id = normalizePaneId(paneId)
            try {
                const payload = this.exportPrefsFor(id)
                localStorage.setItem(this._paneStorageKey(id), JSON.stringify(payload))
            } catch {
                // ignore storage failures
            }
        },

        /**
         * LEGACY: Hydrate DEFAULT pane from localStorage (fallback only).
         * This should be called on startup, but profile-driven prefs can override it later.
         */
        hydrate() {
            this.hydrateFor(DEFAULT_PANE_ID)
        },

        /**
         * NEW: Hydrate a specific pane from localStorage (fallback only).
         *
         * Migration behavior:
         * - If pane-specific key exists, use it.
         * - Else, if paneId === default and legacy key exists, use legacy (and optionally write to pane key later via persist).
         */
        hydrateFor(paneId?: string | null) {
            const id = normalizePaneId(paneId)
            const ui = this._ensurePane(id)
            if (ui._hydrated) return
            ui._hydrated = true

            try {
                const paneKey = this._paneStorageKey(id)
                const rawPane = localStorage.getItem(paneKey)

                if (rawPane) {
                    const parsed = JSON.parse(rawPane) as UiStatePersisted
                    // Do not re-persist during hydration; local is the source here.
                    this.applyPrefsFor(id, parsed, { persist: false, applyCapacity: true })
                    return
                }

                // Default pane can fall back to legacy key
                if (id === DEFAULT_PANE_ID) {
                    const rawLegacy = localStorage.getItem(STORAGE_KEY)
                    if (!rawLegacy) return
                    const parsedLegacy = JSON.parse(rawLegacy) as UiStatePersisted
                    this.applyPrefsFor(DEFAULT_PANE_ID, parsedLegacy, {
                        persist: false,
                        applyCapacity: true
                    })
                    return
                }
            } catch {
                // ignore corrupt storage
            }
        },

        /* ----------------------------
           Adopt server-driven config
        ----------------------------- */
        adoptServerConfig(cfg?: ServerConfig) {
            if (!cfg?.logs) return
            const { capacity, minLevel, allowedChannels } = cfg.logs

            if (typeof capacity === 'number' && capacity > 0 && capacity !== this.capacity) {
                this.setCapacity(Math.floor(capacity))
            }
            if (minLevel && minLevel in LEVEL_ORDER) {
                // Apply server minLevel to DEFAULT pane only (legacy behavior)
                const ui = this._ensurePane(DEFAULT_PANE_ID)
                if (minLevel !== ui.minLevel) ui.minLevel = minLevel
                this._syncLegacyFromPane(DEFAULT_PANE_ID)
            }
            // If the server advertises an allowlist, default-select those at startup (DEFAULT pane only)
            if (Array.isArray(allowedChannels) && allowedChannels.length > 0) {
                const ui = this._ensurePane(DEFAULT_PANE_ID)
                if (ui.selectedChannels.length === 0) {
                    const normalized = Array.from(new Set(allowedChannels)) as LogChannel[]
                    ui.selectedChannels = normalized
                    // do NOT auto-enable filtering here; user controls it implicitly via UI
                    this._syncLegacyFromPane(DEFAULT_PANE_ID)
                }
            }

            // Keep legacy key updated for now (back-compat)
            this._saveUiLegacy()
        },

        /* ----------------------------
           Filters / controls (LEGACY)
        ----------------------------- */

        setChannels(channels: LogChannel[]) {
            this.setChannelsFor(DEFAULT_PANE_ID, channels)
        },
        toggleChannel(channel: LogChannel) {
            this.toggleChannelFor(DEFAULT_PANE_ID, channel)
        },
        clearChannels() {
            this.clearChannelsFor(DEFAULT_PANE_ID)
        },
        setUseChannelFilter(v: boolean) {
            this.setUseChannelFilterFor(DEFAULT_PANE_ID, v)
        },
        setMinLevel(level: ClientLogLevel) {
            this.setMinLevelFor(DEFAULT_PANE_ID, level)
        },
        setAutoscroll(v: boolean) {
            this.setAutoscrollFor(DEFAULT_PANE_ID, v)
        },
        setSearchText(v: string) {
            this.setSearchTextFor(DEFAULT_PANE_ID, v)
        },
        setSortDir(dir: 'asc' | 'desc') {
            this.setSortDirFor(DEFAULT_PANE_ID, dir)
        },
        toggleSortDir() {
            this.setSortDirFor(DEFAULT_PANE_ID, this.sortDir === 'asc' ? 'desc' : 'asc')
        },

        /* ----------------------------
           Filters / controls (PER-PANE)
        ----------------------------- */

        setChannelsFor(paneId: string | null | undefined, channels: LogChannel[], opts: { persist?: boolean } = {}) {
            const id = normalizePaneId(paneId)
            const ui = this._ensurePane(id)
            const dedup = Array.from(new Set(channels))
            ui.selectedChannels = dedup as LogChannel[]
            if (id === DEFAULT_PANE_ID) this._syncLegacyFromPane(DEFAULT_PANE_ID)
            if (opts.persist) this._saveUiFor(id)
        },

        toggleChannelFor(paneId: string | null | undefined, channel: LogChannel, opts: { persist?: boolean } = {}) {
            const id = normalizePaneId(paneId)
            const ui = this._ensurePane(id)
            const idx = ui.selectedChannels.indexOf(channel)
            if (idx >= 0) {
                const next = ui.selectedChannels.slice()
                next.splice(idx, 1)
                ui.selectedChannels = next
            } else {
                ui.selectedChannels = [...ui.selectedChannels, channel]
            }
            if (id === DEFAULT_PANE_ID) this._syncLegacyFromPane(DEFAULT_PANE_ID)
            if (opts.persist) this._saveUiFor(id)
        },

        clearChannelsFor(paneId: string | null | undefined, opts: { persist?: boolean } = {}) {
            const id = normalizePaneId(paneId)
            const ui = this._ensurePane(id)
            ui.selectedChannels = []
            if (id === DEFAULT_PANE_ID) this._syncLegacyFromPane(DEFAULT_PANE_ID)
            if (opts.persist) this._saveUiFor(id)
        },

        setUseChannelFilterFor(paneId: string | null | undefined, v: boolean, opts: { persist?: boolean } = {}) {
            const id = normalizePaneId(paneId)
            const ui = this._ensurePane(id)
            ui.useChannelFilter = !!v
            if (id === DEFAULT_PANE_ID) this._syncLegacyFromPane(DEFAULT_PANE_ID)
            if (opts.persist) this._saveUiFor(id)
        },

        setMinLevelFor(paneId: string | null | undefined, level: ClientLogLevel, opts: { persist?: boolean } = {}) {
            const id = normalizePaneId(paneId)
            const ui = this._ensurePane(id)
            ui.minLevel = level
            if (id === DEFAULT_PANE_ID) this._syncLegacyFromPane(DEFAULT_PANE_ID)
            if (opts.persist) this._saveUiFor(id)
        },

        setAutoscrollFor(paneId: string | null | undefined, v: boolean, opts: { persist?: boolean } = {}) {
            const id = normalizePaneId(paneId)
            const ui = this._ensurePane(id)
            ui.autoscroll = !!v
            if (id === DEFAULT_PANE_ID) this._syncLegacyFromPane(DEFAULT_PANE_ID)
            if (opts.persist) this._saveUiFor(id)
        },

        setSearchTextFor(paneId: string | null | undefined, v: string, opts: { persist?: boolean } = {}) {
            const id = normalizePaneId(paneId)
            const ui = this._ensurePane(id)
            ui.searchText = typeof v === 'string' ? v : String(v ?? '')
            if (id === DEFAULT_PANE_ID) this._syncLegacyFromPane(DEFAULT_PANE_ID)
            if (opts.persist) this._saveUiFor(id)
        },

        setSortDirFor(paneId: string | null | undefined, dir: 'asc' | 'desc', opts: { persist?: boolean } = {}) {
            const id = normalizePaneId(paneId)
            const ui = this._ensurePane(id)
            ui.sortDir = dir
            if (id === DEFAULT_PANE_ID) this._syncLegacyFromPane(DEFAULT_PANE_ID)
            if (opts.persist) this._saveUiFor(id)
        },

        /* ----------------------------
        Pause is still global
        ----------------------------- */

        togglePause() {
            this.paused = !this.paused
        },
        setPaused(v: boolean) {
            this.paused = !!v
        }
    }
})
