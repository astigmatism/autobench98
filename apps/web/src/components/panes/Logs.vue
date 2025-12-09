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

                            <!-- Autoscroll (NOW panel-styled like the selects) -->
                            <label class="checkbox panel panel-text">
                                <input
                                    type="checkbox"
                                    v-model="autoscroll"
                                    @change="onAutoscrollChange"
                                />
                                <span>Auto-scroll</span>
                            </label>

                            <!-- Pause -->
                            <button class="btn" :data-active="paused" @click="togglePause">
                                {{ paused ? 'Resume' : 'Pause' }}
                            </button>

                            <!-- Export (JSON only) -->
                            <div class="export">
                                <button class="btn mini" @click="exportJson">Export .json</button>
                            </div>

                            <!-- Clear -->
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
            <span>⏸️ Paused — new entries are being buffered</span>
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
import { useLogs, type ClientLogLevel, type LogChannel } from '@/stores/logs'

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
const props = defineProps<{ pane?: PaneInfo }>()

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

/* ------------ store + behavior (unchanged) ------------ */
const logs = useLogs()

onMounted(() => {
    logs.hydrate()
})

const showControls = ref(false)

const items = computed(() => logs.filteredItems)
const size = computed(() => logs.size)
const capacity = computed(() => logs.capacity)

const channels = computed<LogChannel[]>(() => logs.availableChannels)
const selected = computed<Set<LogChannel>>(() => new Set(logs.selectedChannels))
const minLevel = ref<ClientLogLevel>(logs.minLevel)
const paused = computed(() => logs.paused)
const autoscroll = ref<boolean>(logs.autoscroll)
const search = ref<string>(logs.searchText ?? '')
const sortDir = ref<'asc' | 'desc'>(logs.sortDir)

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

function clear() {
    logs.clear()
}
function onChipClick(ch: LogChannel) {
    logs.toggleChannel(ch)
    logs.setUseChannelFilter(true)
}
function selectAll() {
    logs.setChannels(channels.value.slice())
    logs.setUseChannelFilter(true)
}
function selectNone() {
    logs.clearChannels()
    logs.setUseChannelFilter(true)
}
function onLevelChange() {
    logs.setMinLevel(minLevel.value)
}
function onAutoscrollChange() {
    logs.setAutoscroll(!!autoscroll.value)
}
function togglePause() {
    logs.togglePause()
}
function onSearchChange() {
    logs.setSearchText(search.value)
}
function onSortChange() {
    logs.setSortDir(sortDir.value)
}

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
watch(
    () => logs.autoscroll,
    (v) => {
        autoscroll.value = v
    }
)
watch(
    () => logs.minLevel,
    (v) => {
        if (minLevel.value !== v) minLevel.value = v
    }
)
watch(
    () => logs.searchText,
    (v) => {
        if (search.value !== v) search.value = v
    }
)
watch(
    () => logs.sortDir,
    (v) => {
        if (sortDir.value !== v) sortDir.value = v
    }
)
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

/* Checkbox — upgraded to panel style to match selects */
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