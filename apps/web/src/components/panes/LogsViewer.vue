<template>
    <div class="logs-pane" :style="{ '--pane-fg': paneFg, '--panel-fg': panelFg }">
        <!-- Hotspot region: only hovering here shows the advanced controls button -->
        <div class="logs-advanced-hotspot">
            <button
                class="gear-btn"
                :aria-expanded="showControls ? 'true' : 'false'"
                aria-controls="logs-controls-panel"
                title="Show filters & sorting"
                @click="showControls = !showControls"
            >
                ⚙️
            </button>
        </div>

        <!-- Settings panel (toolbar + legend), hidden by default -->
        <transition name="slide-fade">
            <div v-show="showControls" id="logs-controls-panel" class="controls-panel">
                <!-- Toolbar (left-aligned; no "Logs" title, keep counter) -->
                <div class="toolbar">
                    <div class="left">
                        <!-- Plain text (outside panels) uses pane foreground -->
                        <span class="meta plain-text">({{ size }} / cap {{ capacity }})</span>

                        <div class="controls">
                            <!-- Search (panel-styled) -->
                            <label class="search">
                                <input
                                    type="text"
                                    placeholder="Search…"
                                    v-model="search"
                                    @input="onSearchChange"
                                />
                            </label>

                            <!-- Sort (panel-styled) -->
                            <label class="select panel-text">
                                <span>Sort</span>
                                <select v-model="sortDir" @change="onSortChange">
                                    <option value="desc">Newest first</option>
                                    <option value="asc">Oldest first</option>
                                </select>
                            </label>

                            <!-- Level filter (panel-styled) -->
                            <label class="select panel-text">
                                <span>Min level</span>
                                <select v-model="minLevel" @change="onLevelChange">
                                    <option value="debug">debug</option>
                                    <option value="info">info</option>
                                    <option value="warn">warn</option>
                                    <option value="error">error</option>
                                    <option value="fatal">fatal</option>
                                </select>
                            </label>

                            <!-- Autoscroll (panel-styled like the selects) -->
                            <label class="checkbox panel panel-text">
                                <input
                                    type="checkbox"
                                    v-model="autoscroll"
                                    @change="onAutoscrollChange"
                                />
                                <span>Auto-scroll</span>
                            </label>

                            <!-- Pause (per-pane view freeze) -->
                            <button class="btn" :data-active="paused" @click="togglePause">
                                {{ paused ? 'Resume' : 'Pause' }}
                            </button>

                            <!-- Export (JSON only) -->
                            <div class="export">
                                <button class="btn mini" @click="exportJson">Export .json</button>
                            </div>

                            <!-- Clear (global logs) -->
                            <button class="btn" @click="clear()">Clear</button>
                        </div>
                    </div>
                    <div class="right"></div>
                </div>

                <!-- Channel legend / filters (panel-styled) -->
                <div class="legend">
                    <div class="legend-left">Channels:</div>
                    <div class="legend-channels">
                        <label
                            v-for="ch in channels"
                            :key="ch"
                            class="legend-item"
                            :data-checked="selected.has(ch)"
                            @click.prevent="onChipClick(ch)"
                        >
                            <span class="dot" :style="{ backgroundColor: colorFor(ch) }"></span>
                            <span class="name">{{ ch }}</span>
                        </label>
                    </div>
                    <div class="legend-actions">
                        <button class="btn mini" @click="selectAll">All</button>
                        <button class="btn mini" @click="selectNone">None</button>
                    </div>
                </div>
            </div>
        </transition>

        <!-- Paused hint (panel-styled) -->
        <div class="paused-banner" v-if="paused">
            <span>⏸️ Paused — this pane is not auto-scrolling</span>
        </div>

        <!-- Log list (panel-styled) -->
        <div ref="scroller" class="scroller">
            <div v-for="(item, idx) in items" :key="idx" class="row" :data-level="item.level">
                <span class="ts">{{ fmtTs(item.ts) }}</span>
                <span class="emoji">{{ item.emoji }}</span>
                <span class="chan">{{ item.channel }}</span>
                <span class="msg">{{ item.message }}</span>
            </div>
            <div v-if="items.length === 0" class="empty">No logs yet…</div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useLogs, type ClientLog, type ClientLogLevel, type LogChannel } from '@/stores/logs'

/** Accept pane context (optional). */
type Direction = 'row' | 'col'
type Constraints = {
    widthPx?: number | null
    heightPx?: number | null
    widthPct?: number | null
    heightPct?: number | null
}
type Appearance = {
    bg?: string | null
    mTop?: number | null
    mRight?: number | null
    mBottom?: number | null
    mLeft?: number | null
}
type PaneInfo = {
    id: string
    isRoot: boolean
    parentDir: Direction | null
    constraints: Constraints
    appearance: Appearance
    container: {
        constraints: Constraints | null
        direction: Direction | null
    }
}

/**
 * Per-pane UI prefs
 * - These are NOT written to the global logs store.
 * - They are persisted per pane id in localStorage as a fallback.
 *
 * NOTE: App.vue may inject these via leaf.props.__logsPaneUi when saving/loading profiles.
 */
type LogsPanePrefs = {
    selectedChannels?: LogChannel[]
    useChannelFilter?: boolean
    minLevel?: ClientLogLevel
    autoscroll?: boolean
    searchText?: string
    sortDir?: 'asc' | 'desc'
}

function isObject(x: any): x is Record<string, unknown> {
    return x !== null && typeof x === 'object' && !Array.isArray(x)
}

const props = defineProps<{
    pane?: PaneInfo
    __logsPaneUi?: LogsPanePrefs
    /** Monotonic "profile load" revision stamped by App.vue to force rehydrate on load. */
    __logsPaneProfileRev?: number
}>()

/** Contrast-aware plain-text color from pane background (for non-panel text) */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    if (!hex) return null
    const s = hex.trim().replace(/^#/, '')
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null
    const int = parseInt(s, 16)
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 }
}
function srgbToLinear(c: number): number {
    const x = c / 255
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
}
function relLuminance(hex: string): number {
    const rgb = hexToRgb(hex)
    if (!rgb) return 1
    const r = srgbToLinear(rgb.r)
    const g = srgbToLinear(rgb.g)
    const b = srgbToLinear(rgb.b)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrastRatio(l1: number, l2: number): number {
    const [L1, L2] = l1 >= l2 ? [l1, l2] : [l2, l1]
    return (L1 + 0.05) / (L2 + 0.05)
}
const paneFg = computed(() => {
    const bg = (props.pane?.appearance?.bg ?? '#ffffff') as string
    const Lbg = relLuminance(bg)
    const contrastWithWhite = contrastRatio(relLuminance('#ffffff'), Lbg)
    const contrastWithBlack = contrastRatio(relLuminance('#000000'), Lbg)
    return contrastWithWhite >= contrastWithBlack ? '#ffffff' : '#111111'
})

/** Fixed readable text for panel-wrapped areas (dark backgrounds) */
const panelFg = '#e6e6e6'

/* ------------ data source (global ingestion) ------------ */
const logs = useLogs()

const LEVEL_ORDER: Record<ClientLogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    fatal: 50
}

function isValidLevel(x: any): x is ClientLogLevel {
    return typeof x === 'string' && x in LEVEL_ORDER
}
function isValidSortDir(x: any): x is 'asc' | 'desc' {
    return x === 'asc' || x === 'desc'
}
function dedupChannels(x: any): LogChannel[] | null {
    if (!Array.isArray(x)) return null
    const cleaned = x
        .map((c) => (typeof c === 'string' ? (c as LogChannel) : null))
        .filter(Boolean) as LogChannel[]
    if (cleaned.length === 0) return []
    return Array.from(new Set(cleaned)) as LogChannel[]
}

const paneId = computed(() => String(props.pane?.id ?? '').trim())
const STORAGE_PREFIX = 'logs:pane:ui:'
const storageKey = computed(() => (paneId.value ? `${STORAGE_PREFIX}${paneId.value}` : ''))

function readPanePrefs(): LogsPanePrefs | null {
    const key = storageKey.value
    if (!key) return null
    try {
        const raw = localStorage.getItem(key)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? (parsed as LogsPanePrefs) : null
    } catch {
        return null
    }
}
function writePanePrefs(p: LogsPanePrefs) {
    const key = storageKey.value
    if (!key) return
    try {
        localStorage.setItem(key, JSON.stringify(p))
    } catch {
        // ignore
    }
}

function applyPanePrefs(prefs?: LogsPanePrefs | null) {
    if (!prefs || typeof prefs !== 'object') return

    const nextSelected = dedupChannels((prefs as any).selectedChannels)
    if (nextSelected !== null) selectedChannels.value = nextSelected

    const nextUse = (prefs as any).useChannelFilter
    if (typeof nextUse === 'boolean') useChannelFilter.value = nextUse

    const nextLevel = (prefs as any).minLevel
    if (isValidLevel(nextLevel)) minLevel.value = nextLevel

    const nextAuto = (prefs as any).autoscroll
    if (typeof nextAuto === 'boolean') autoscroll.value = nextAuto

    const nextSearch = (prefs as any).searchText
    if (typeof nextSearch === 'string') search.value = nextSearch

    const nextSort = (prefs as any).sortDir
    if (isValidSortDir(nextSort)) sortDir.value = nextSort
}

function exportPanePrefs(): LogsPanePrefs {
    return {
        selectedChannels: selectedChannels.value.slice(),
        useChannelFilter: !!useChannelFilter.value,
        minLevel: minLevel.value,
        autoscroll: !!autoscroll.value,
        searchText: search.value ?? '',
        sortDir: sortDir.value
    }
}

/* ------------ UI state (per pane) ------------ */
const showControls = ref(false)

// Filters (per pane)
const useChannelFilter = ref<boolean>(false)
const selectedChannels = ref<LogChannel[]>([])
const minLevel = ref<ClientLogLevel>('debug')
const paused = ref<boolean>(false)
const autoscroll = ref<boolean>(true)
const search = ref<string>('')
const sortDir = ref<'asc' | 'desc'>('desc')

/**
 * Hydration priority:
 * 1) profile-embedded prefs (leaf.props.__logsPaneUi) if present
 * 2) per-pane localStorage
 * 3) global store prefs as a fallback default
 *
 * Important: profile load must override "recent modifications", even if pane id is unchanged.
 * App.vue stamps a monotonic __logsPaneProfileRev on leaves to force this rehydrate.
 */
const lastHydratedSig = ref<string>('')

function hydrateForPane() {
    const key = storageKey.value
    const rev = typeof props.__logsPaneProfileRev === 'number' ? props.__logsPaneProfileRev : 0
    const hasEmbed = isObject(props.__logsPaneUi)

    // If we can’t key this pane yet (no id), we can still apply embedded prefs on change.
    if (!key) {
        const sig = `nokey|rev:${rev}|embed:${hasEmbed ? 1 : 0}`
        if (lastHydratedSig.value === sig) return
        lastHydratedSig.value = sig

        if (hasEmbed) {
            applyPanePrefs(props.__logsPaneUi as LogsPanePrefs)
        }
        return
    }

    // Rehydrate whenever:
    // - pane id changes
    // - profile rev changes
    // - embedded presence changes
    const sig = `${key}|rev:${rev}|embed:${hasEmbed ? 1 : 0}`
    if (lastHydratedSig.value === sig) return
    lastHydratedSig.value = sig

    // Reset non-persisted state on pane switch / profile load
    paused.value = false

    // 1) Embedded prefs from profile/layout snapshot (authoritative on profile load)
    if (hasEmbed) {
        applyPanePrefs(props.__logsPaneUi as LogsPanePrefs)
        // Mirror into localStorage so it becomes the persistent per-pane baseline.
        writePanePrefs(exportPanePrefs())
        return
    }

    // 2) localStorage
    const stored = readPanePrefs()
    if (stored) {
        applyPanePrefs(stored)
        return
    }

    // 3) fallback from global store (does NOT write to pane storage)
    const fallback = logs.exportPrefs?.() as any
    if (fallback && typeof fallback === 'object') {
        applyPanePrefs({
            selectedChannels: fallback.selectedChannels,
            useChannelFilter: fallback.useChannelFilter,
            minLevel: fallback.minLevel,
            autoscroll: fallback.autoscroll,
            searchText: fallback.searchText,
            sortDir: fallback.sortDir
        })
    }
}

onMounted(() => {
    hydrateForPane()
})

// Rehydrate on pane id change OR when profile injects new prefs/rev (profile load)
watch([paneId, () => props.__logsPaneUi, () => props.__logsPaneProfileRev], () => hydrateForPane())

// Persist per-pane prefs whenever these change (if pane id exists)
watch(
  [
    () => selectedChannels.value,
    () => useChannelFilter.value,
    () => minLevel.value,
    () => autoscroll.value,
    () => search.value,
    () => sortDir.value
  ],
  () => {
    writePanePrefs(exportPanePrefs())
  },
  { deep: true }
)

/* ------------ computed from global logs data ------------ */
const itemsSource = computed<ClientLog[]>(() => logs.items)
const size = computed(() => items.value.length)
const capacity = computed(() => logs.capacity)

const channels = computed<LogChannel[]>(() => {
    // use store getter for stable ordering
    return logs.availableChannels as LogChannel[]
})
const selected = computed<Set<LogChannel>>(() => new Set(selectedChannels.value))

const colorMap = computed<Record<string, string>>(() => logs.channelColors)

function colorFor(ch: string): string {
    const c = colorMap.value?.[ch as string]
    switch (c) {
        case 'blue':
            return '#60a5fa'
        case 'yellow':
            return '#facc15'
        case 'green':
            return '#22c55e'
        case 'magenta':
            return '#f472b6'
        case 'cyan':
            return '#22d3ee'
        case 'red':
            return '#ef4444'
        case 'white':
            return '#e5e7eb'
        case 'purple':
            return '#a78bfa'
        default:
            return '#9ca3af'
    }
}

const items = computed<ClientLog[]>(() => {
    const source = itemsSource.value || []
    const channelFilterOn = !!useChannelFilter.value
    const hasSelected = selectedChannels.value.length > 0
    const minOrder = LEVEL_ORDER[minLevel.value] ?? LEVEL_ORDER.debug
    const q = (search.value || '').trim().toLowerCase()
    const doSearch = q.length > 0

    const allowed =
        channelFilterOn && hasSelected ? new Set<LogChannel>(selectedChannels.value) : null

    const filtered = source.filter((e) => {
        if (channelFilterOn) {
            // If ON and none selected -> show nothing.
            if (!allowed) return false
            if (!allowed.has(e.channel)) return false
        }

        const lvl = LEVEL_ORDER[e.level] ?? LEVEL_ORDER.debug
        if (lvl < minOrder) return false

        if (doSearch) {
            const hay1 = e.message?.toLowerCase() ?? ''
            const hay2 = String(e.channel ?? '').toLowerCase()
            const hay3 = String(e.emoji ?? '').toLowerCase()
            if (hay1.indexOf(q) === -1 && hay2.indexOf(q) === -1 && hay3.indexOf(q) === -1)
                return false
        }

        return true
    })

    if (sortDir.value === 'desc') filtered.sort((a, b) => b.ts - a.ts)
    else filtered.sort((a, b) => a.ts - b.ts)

    return filtered
})

/* ------------ handlers ------------ */
function clear() {
    logs.clear()
}

function onChipClick(ch: LogChannel) {
    const idx = selectedChannels.value.indexOf(ch)
    if (idx >= 0) {
        const next = selectedChannels.value.slice()
        next.splice(idx, 1)
        selectedChannels.value = next
    } else {
        selectedChannels.value = [...selectedChannels.value, ch]
    }
    useChannelFilter.value = true
}
function selectAll() {
    selectedChannels.value = channels.value.slice()
    useChannelFilter.value = true
}
function selectNone() {
    selectedChannels.value = []
    useChannelFilter.value = true
}
function onLevelChange() {
    // v-model already updated
}
function onAutoscrollChange() {
    autoscroll.value = !!autoscroll.value
}
function togglePause() {
    paused.value = !paused.value
}
function onSearchChange() {
    // v-model already updated
}
function onSortChange() {
    // v-model already updated
}

/* ------------ export ------------ */
function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
}
function exportJson() {
    const data = items.value
    const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json;charset=utf-8'
    })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    downloadBlob(blob, `autobench98-logs-${ts}.json`)
}

/* ------------ rendering helpers ------------ */
function fmtTs(ts: number): string {
    try {
        const d = new Date(ts)
        const hh = String(d.getHours()).padStart(2, '0')
        const mm = String(d.getMinutes()).padStart(2, '0')
        const ss = String(d.getSeconds()).padStart(2, '0')
        const ms = String(d.getMilliseconds()).padStart(3, '0')
        return `${hh}:${mm}:${ss}.${ms}`
    } catch {
        return String(ts)
    }
}

/* ------------ scrolling (per pane) ------------ */
const scroller = ref<HTMLDivElement | null>(null)
function scrollSmoothToEnd() {
    const el = scroller.value
    if (!el) return
    if (sortDir.value === 'desc') el.scrollTo({ top: 0, behavior: 'smooth' })
    else el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
}
onMounted(() => {
    if (scroller.value && autoscroll.value && !paused.value) scrollSmoothToEnd()
})
watch(items, () => {
    if (!autoscroll.value || paused.value || !scroller.value) return
    queueMicrotask(scrollSmoothToEnd)
})
watch(autoscroll, (v) => {
    if (!v) return
    if (paused.value) return
    queueMicrotask(scrollSmoothToEnd)
})
watch(sortDir, () => {
    if (!autoscroll.value || paused.value) return
    queueMicrotask(scrollSmoothToEnd)
})
</script>

<style scoped>
.logs-pane {
    /* --pane-fg: readable for plain text on the pane background
       --panel-fg: readable for text inside dark panels (fixed light color) */
    --pane-fg: #111;
    --panel-fg: #e6e6e6;

    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: 100%;
    width: 100%;
}

/* Hotspot area for advanced controls button (top-right).
   Only hovering this region will reveal the button.
   z-index ensures it floats above pane content. */
.logs-advanced-hotspot {
    position: absolute;
    top: 0;
    right: 0;
    width: 3.2rem;
    height: 2.4rem;
    pointer-events: auto;
    z-index: 30;
}

/* Gear button */
.gear-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    height: 28px;
    min-width: 28px;
    padding: 0 8px;
    border-radius: 6px;
    border: 1px solid #333;
    background: #111;
    color: #eee;
    cursor: pointer;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 120ms ease, background 120ms ease, border-color 120ms ease,
        transform 60ms ease;
    z-index: 31;
}

/* Only show button while hotspot is hovered */
.logs-advanced-hotspot:hover .gear-btn {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
}

.gear-btn:hover {
    background: #1a1a1a;
    transform: translateY(-1px);
}

/* Slide-fade transition */
.slide-fade-enter-active,
.slide-fade-leave-active {
    transition: opacity 180ms ease, transform 180ms ease;
}
.slide-fade-enter-from,
.slide-fade-leave-to {
    opacity: 0;
    transform: translateY(-6px);
}

/* Panel container */
.controls-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

/* Toolbar */
.toolbar {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 8px;
    font-size: 14px;
}

/* plain text bits should use pane foreground */
.plain-text {
    color: var(--pane-fg);
}

/* Panel-styled controls keep panel foreground for readability */
.panel-text span {
    color: var(--panel-fg);
}

/* Left/right areas */
.toolbar .left {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
}
.toolbar .right {
}

/* Controls block */
.toolbar .controls {
    --control-h: 30px;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}

/* Search */
.search input {
    background: #0b0b0b;
    color: var(--panel-fg);
    border: 1px solid #333;
    border-radius: 6px;
    padding: 0 8px;
    min-width: 180px;
    height: var(--control-h);
    line-height: var(--control-h);
}

/* Select + labels (panel) */
.select {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--control-h);
    padding: 0 8px;
    background: #0b0b0b;
    border: 1px solid #333;
    border-radius: 6px;
}
.select select {
    background: #0b0b0b;
    color: var(--panel-fg);
    border: 1px solid #333;
    border-radius: 6px;
    padding: 0 8px;
    height: var(--control-h);
    line-height: var(--control-h);
}

/* Checkbox — panel style to match selects */
.checkbox.panel {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--control-h);
    padding: 0 8px;
    background: #0b0b0b;
    border: 1px solid #333;
    border-radius: 6px;
}
.checkbox input {
    width: 16px;
    height: 16px;
}
.checkbox span {
    line-height: var(--control-h);
    color: var(--panel-fg);
}

/* Legend (panel) */
.legend {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 6px 8px;
    background: #0e0e0e;
    border: 1px solid #1f1f1f;
    border-radius: 8px;
    font-size: 12px;
    color: var(--panel-fg);
}
.legend-left {
    color: #a0a0a0;
}
.legend-channels {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 14px;
}
.legend-item {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    user-select: none;
    padding: 4px 8px;
    border-radius: 8px;
    border: 1px solid #333;
    background: #0f0f0f;
    color: #d6d6d6;
    transition: background 120ms, border-color 120ms, transform 60ms;
}
.legend-item:hover {
    background: #151515;
}
.legend-item[data-checked='true'] {
    border-color: #6ee7b7;
    background: #07361f;
    color: #e8fff4;
    transform: translateY(-1px);
}
.legend-item .name {
    text-transform: lowercase;
}
.legend-item .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.06) inset;
}
.legend-actions .btn.mini {
    padding: 0 8px;
    font-size: 12px;
    height: var(--control-h);
}

/* Buttons (panel) */
.btn {
    padding: 0 12px;
    border-radius: 6px;
    border: 1px solid #333;
    background: #111;
    color: var(--panel-fg);
    cursor: pointer;
    height: var(--control-h);
    line-height: var(--control-h);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
}

/* Make toolbar buttons a touch wider & consistent */
.toolbar .btn {
    min-width: 104px;
}
.toolbar .btn.mini {
    min-width: 104px;
}

/* (legend action buttons remain compact) */
.legend-actions .btn.mini {
    min-width: auto;
}

.btn:hover {
    background: #1a1a1a;
}
.btn[data-active='true'] {
    border-color: #555;
    background: #1f1f1f;
}
.btn.mini {
    padding: 0 10px;
    font-size: 12px;
    height: var(--control-h);
    line-height: var(--control-h);
}

/* Paused banner (panel) */
.paused-banner {
    background: #141414;
    border: 1px dashed #333;
    border-radius: 8px;
    color: var(--panel-fg);
    padding: 6px 10px;
    font-size: 12px;
}

/* Log list (panel) */
.scroller {
    flex: 1;
    overflow: auto;
    background: #0b0b0b;
    border: 1px solid #222;
    border-radius: 8px;
    padding: 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
    line-height: 1.35;
    color: var(--panel-fg);
}
.row {
    display: grid;
    grid-template-columns: 88px 22px 120px 1fr;
    gap: 8px;
    padding: 3px 0;
    align-items: baseline;
}
.ts {
    color: #a0a0a0;
}
.emoji {
    text-align: center;
    width: 22px;
}
.chan {
    color: #7cc;
    text-transform: lowercase;
}
.msg {
    color: #eee;
}
.row[data-level='warn'] .msg {
    color: #ffd479;
}
.row[data-level='error'] .msg {
    color: #ff8686;
}
.row[data-level='fatal'] .msg {
    color: #ff4d4d;
}
.empty {
    padding: 12px;
    color: #909090;
    text-align: center;
}
</style>
