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

// Local storage key for persisting UI preferences
const STORAGE_KEY = 'logs:ui'

type UiStatePersisted = {
    selectedChannels?: LogChannel[]
    minLevel?: ClientLogLevel
    autoscroll?: boolean
    searchText?: string
    capacity?: number
    useChannelFilter?: boolean
    sortDir?: 'asc' | 'desc'
}

export const useLogs = defineStore('logs', {
    state: () => ({
        // Initial default remains 500; will be overridden by serverConfig if provided
        capacity: Number(import.meta.env.VITE_CLIENT_LOGS_CAPACITY ?? 500) as number,
        items: [] as ClientLog[],

        // --- UI / filter state ---
        // Channel filtering is OFF by default. When off: show all channels regardless of selections.
        useChannelFilter: false as boolean,
        // Selected channels to include when filtering is ON.
        selectedChannels: [] as LogChannel[],
        minLevel: 'debug' as ClientLogLevel,
        autoscroll: true as boolean,
        paused: false as boolean,

        // keyword filter (client-side)
        searchText: '' as string,

        // sorting: newest first by default
        sortDir: 'desc' as 'asc' | 'desc',

        // internal: one-time hydration guard
        _hydrated: false as boolean
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
         * Items after applying:
         *  - channel filter (ONLY when useChannelFilter === true)
         *  - min level filter
         *  - keyword search (message, channel, emoji)
         *  - sort order (asc/desc by ts)
         *
         * Pause freezes only scroll/UI, not ingestion.
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

            const allowed = channelFilterOn && hasSelected ? new Set<LogChannel>(s.selectedChannels) : null

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
                    ) return false
                }
                return true
            })

            if (s.sortDir === 'desc') filtered.sort((a, b) => b.ts - a.ts)
            else filtered.sort((a, b) => a.ts - b.ts)

            return filtered
        }
    },
    actions: {
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
            this._saveUi()
        },

        /** Clear all logs (client-side only). */
        clear() {
            this.items = []
        },

        // ----- Persistence helpers -----
        _saveUi() {
            try {
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
        hydrate() {
            if (this._hydrated) return
            this._hydrated = true
            try {
                const raw = localStorage.getItem(STORAGE_KEY)
                if (!raw) return
                const parsed = JSON.parse(raw) as UiStatePersisted
                if (Array.isArray(parsed.selectedChannels)) {
                    // drop any duplicates; tolerate unknown channels
                    this.selectedChannels = Array.from(new Set(parsed.selectedChannels)) as LogChannel[]
                }
                if (parsed.minLevel && parsed.minLevel in LEVEL_ORDER) {
                    this.minLevel = parsed.minLevel
                }
                if (typeof parsed.autoscroll === 'boolean') {
                    this.autoscroll = parsed.autoscroll
                }
                if (typeof parsed.searchText === 'string') {
                    this.searchText = parsed.searchText
                }
                if (typeof parsed.capacity === 'number' && parsed.capacity > 0) {
                    this.capacity = Math.floor(parsed.capacity)
                    const over = this.items.length - this.capacity
                    if (over > 0) this.items.splice(0, over)
                }
                if (typeof parsed.useChannelFilter === 'boolean') {
                    this.useChannelFilter = parsed.useChannelFilter
                }
                if (parsed.sortDir === 'asc' || parsed.sortDir === 'desc') {
                    this.sortDir = parsed.sortDir
                }
            } catch {
                // ignore corrupt storage
            }
        },

        // ----- Adopt server-driven config -----
        adoptServerConfig(cfg?: ServerConfig) {
            if (!cfg?.logs) return
            const { capacity, minLevel, allowedChannels } = cfg.logs

            if (typeof capacity === 'number' && capacity > 0 && capacity !== this.capacity) {
                this.setCapacity(Math.floor(capacity))
            }
            if (minLevel && minLevel in LEVEL_ORDER && minLevel !== this.minLevel) {
                this.minLevel = minLevel
            }
            // If the server advertises an allowlist, default-select those at startup
            if (Array.isArray(allowedChannels) && allowedChannels.length > 0 && this.selectedChannels.length === 0) {
                const normalized = Array.from(new Set(allowedChannels)) as LogChannel[]
                this.selectedChannels = normalized
                // do NOT auto-enable filtering here; user controls it implicitly via UI
            }

            this._saveUi()
        },

        // ----- Filters / controls -----
        setChannels(channels: LogChannel[]) {
            const dedup = Array.from(new Set(channels))
            this.selectedChannels = dedup as LogChannel[]
            this._saveUi()
        },
        toggleChannel(channel: LogChannel) {
            const idx = this.selectedChannels.indexOf(channel)
            if (idx >= 0) {
                const next = this.selectedChannels.slice()
                next.splice(idx, 1)
                this.selectedChannels = next
            } else {
                this.selectedChannels = [...this.selectedChannels, channel]
            }
            this._saveUi()
        },
        clearChannels() {
            this.selectedChannels = []
            this._saveUi()
        },

        setUseChannelFilter(v: boolean) {
            this.useChannelFilter = !!v
            this._saveUi()
        },

        setMinLevel(level: ClientLogLevel) {
            this.minLevel = level
            this._saveUi()
        },

        setAutoscroll(v: boolean) {
            this.autoscroll = !!v
            this._saveUi()
        },

        setSearchText(v: string) {
            this.searchText = v
            this._saveUi()
        },

        togglePause() {
            this.paused = !this.paused
        },
        setPaused(v: boolean) {
            this.paused = !!v
        },

        setSortDir(dir: 'asc' | 'desc') {
            this.sortDir = dir
            this._saveUi()
        },
        toggleSortDir() {
            this.setSortDir(this.sortDir === 'asc' ? 'desc' : 'asc')
        }
    }
})