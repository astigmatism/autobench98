<template>
    <div class="logs-pane">
        <!-- Toolbar -->
        <div class="toolbar">
            <div class="left">
                <strong>Logs</strong>
                <span class="meta">({{ size }} / cap {{ capacity }})</span>
            </div>
            <div class="right">
                <div class="controls">
                    <!-- Search -->
                    <label class="search">
                        <input
                            type="text"
                            placeholder="Search…"
                            v-model="search"
                            @input="onSearchChange"
                        />
                    </label>

                    <!-- Sort -->
                    <label class="select">
                        <span>Sort</span>
                        <select v-model="sortDir" @change="onSortChange">
                            <option value="desc">Newest first</option>
                            <option value="asc">Oldest first</option>
                        </select>
                    </label>

                    <!-- Level filter -->
                    <label class="select">
                        <span>Min level</span>
                        <select v-model="minLevel" @change="onLevelChange">
                            <option value="debug">debug</option>
                            <option value="info">info</option>
                            <option value="warn">warn</option>
                            <option value="error">error</option>
                            <option value="fatal">fatal</option>
                        </select>
                    </label>

                    <!-- Autoscroll -->
                    <label class="checkbox">
                        <input type="checkbox" v-model="autoscroll" @change="onAutoscrollChange" />
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
        </div>

        <!-- Channel legend / filters (dynamic) -->
        <div class="legend" v-if="channels.length">
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

        <!-- Paused hint -->
        <div class="paused-banner" v-if="paused">
            <span>⏸️ Paused — new entries are being buffered</span>
        </div>

        <!-- Log list -->
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

const logs = useLogs()

// Hydrate persisted UI prefs on first mount
onMounted(() => {
    logs.hydrate()
})

// --- derived data / bindings ---
const items = computed(() => logs.filteredItems)
const size = computed(() => logs.size)
const capacity = computed(() => logs.capacity)

// filters & controls
const channels = computed<LogChannel[]>(() => logs.availableChannels)
const selected = computed<Set<LogChannel>>(() => new Set(logs.selectedChannels))
const minLevel = ref<ClientLogLevel>(logs.minLevel)
const paused = computed(() => logs.paused)
const autoscroll = ref<boolean>(logs.autoscroll)
const search = ref<string>(logs.searchText ?? '')
const sortDir = ref<'asc' | 'desc'>(logs.sortDir)

// colors
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

// --- controls handlers ---
function clear() {
    logs.clear()
}
function onChipClick(ch: LogChannel) {
    logs.toggleChannel(ch)
    // Implicit filter behavior: touching chips enables filtering
    logs.setUseChannelFilter(true)
}
function selectAll() {
    logs.setChannels(channels.value.slice())
    logs.setUseChannelFilter(true) // enable include-only filter over all channels
}
function selectNone() {
    logs.clearChannels()
    logs.setUseChannelFilter(true) // include-only with empty -> show none (explicit)
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

// --- Export JSON ---
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

// --- time formatter ---
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

// --- scrolling behavior (smooth; depends on sort) ---
const scroller = ref<HTMLDivElement | null>(null)

function scrollSmoothToEnd() {
    const el = scroller.value
    if (!el) return
    if (sortDir.value === 'desc') {
        // newest first at top -> keep view anchored to top
        el.scrollTo({ top: 0, behavior: 'smooth' })
    } else {
        // oldest first -> keep anchored to bottom
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
}

onMounted(() => {
    if (scroller.value && autoscroll.value && !paused.value) {
        scrollSmoothToEnd()
    }
})

watch(items, () => {
    if (!autoscroll.value || paused.value || !scroller.value) return
    queueMicrotask(scrollSmoothToEnd)
})

// keep local refs in sync if store changes elsewhere
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
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: 100%;
}

/* Top toolbar */
.toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    font-size: 14px;
}
.toolbar .left {
    display: flex;
    align-items: baseline;
    gap: 8px;
}
.toolbar .meta {
    color: #808080;
}
.toolbar .right .controls {
    --control-h: 30px; /* unified control height */
    display: flex;
    align-items: center;
    gap: 12px;
}

/* Search */
.search input {
    background: #0b0b0b;
    color: #e6e6e6;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 0 8px;
    min-width: 180px;
    height: var(--control-h);
    line-height: var(--control-h);
}

/* Legend row */
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
    border-color: #6ee7b7; /* brighter mint border when active */
    background: #07361f; /* deeper greenish bg for strong contrast on black */
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

/* Controls */
.checkbox {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    user-select: none;
    height: var(--control-h);
}
.checkbox input {
    width: 16px;
    height: 16px;
}
.checkbox span {
    line-height: var(--control-h);
}
.select {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--control-h);
}
.select select {
    background: #0b0b0b;
    color: #e6e6e6;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 0 8px;
    height: var(--control-h);
    line-height: var(--control-h);
}

/* Buttons */
.btn {
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid #333;
    background: #111;
    color: #eee;
    cursor: pointer;
    height: var(--control-h);
    line-height: var(--control-h);
    display: inline-flex;
    align-items: center;
}
.btn:hover {
    background: #1a1a1a;
}
.btn[data-active='true'] {
    border-color: #555;
    background: #1f1f1f;
}
.btn.mini {
    padding: 0 8px;
    font-size: 12px;
    height: var(--control-h);
    line-height: var(--control-h);
}

/* Paused banner */
.paused-banner {
    background: #141414;
    border: 1px dashed #333;
    border-radius: 8px;
    color: #d0d0d0;
    padding: 6px 10px;
    font-size: 12px;
}

/* Log list */
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
    color: #e6e6e6;
}

.row {
    display: grid;
    grid-template-columns: 88px 22px 120px 1fr;
    gap: 8px;
    padding: 3px 0;
    align-items: baseline;
}

/* per-level coloring */
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
