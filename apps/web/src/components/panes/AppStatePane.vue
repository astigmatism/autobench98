<!-- apps/web/src/panes/AppStatePane.vue -->
<template>
    <div class="as-pane" :style="{ '--pane-fg': paneFg, '--panel-fg': panelFg }">
        <!-- Hotspot region: only hovering here shows the options button -->
        <div class="as-options-hotspot">
            <button
                class="gear-btn"
                :aria-expanded="showOptions ? 'true' : 'false'"
                aria-controls="as-options-panel"
                title="Show pane options"
                @click="showOptions = !showOptions"
            >
                ⚙️
            </button>
        </div>

        <div class="panel">
            <!-- Header: title + status -->
            <div class="panel-head">
                <div class="panel-title-group">
                    <span class="panel-title">
                        Application State
                    </span>

                    <!-- "over the title" settings button (appears on hover) -->
                    <button
                        class="title-gear-btn"
                        :aria-expanded="showOptions ? 'true' : 'false'"
                        aria-controls="as-options-panel"
                        title="Show pane options"
                        @click="showOptions = !showOptions"
                    >
                        ⚙️
                    </button>
                </div>

                <!-- Badge is strictly keyword-only (no version / extra data) -->
                <span
                    class="status-badge"
                    :data-status="statusKind"
                >
                    <span class="dot"></span>
                    <span class="label">{{ statusBadgeLabel }}</span>
                </span>
            </div>

            <!-- Body (everything below the header) -->
            <div class="panel-body">
                <!-- Advanced/options panel lives BETWEEN header and content window (CF-style) -->
                <transition name="slide-fade">
                    <div
                        v-show="showOptions"
                        id="as-options-panel"
                        class="options-panel"
                    >
                        <div class="options-header">
                            <span class="options-title">View</span>
                            <button
                                class="options-reset-btn"
                                type="button"
                                @click="resetPrefs"
                            >
                                Reset to defaults
                            </button>
                        </div>

                        <div class="options-row">
                            <div class="options-row-main">
                                <span class="options-label">Default expand depth</span>
                                <span class="options-value">
                                    {{ defaultExpandDepth }}
                                </span>
                            </div>
                            <input
                                class="options-slider"
                                type="range"
                                min="0"
                                max="6"
                                step="1"
                                v-model.number="defaultExpandDepth"
                            />
                            <div class="options-hint">
                                Applies only when you click “Re-seed expansion”.
                            </div>

                            <div class="options-btn-row">
                                <button class="options-small-btn" type="button" @click="seedExpansion()">
                                    Re-seed expansion
                                </button>
                                <button class="options-small-btn" type="button" @click="collapseAll()">
                                    Collapse all
                                </button>
                            </div>
                        </div>

                        <div class="options-row">
                            <div class="options-row-main">
                                <span class="options-label">Max nodes rendered</span>
                                <span class="options-value">
                                    {{ maxNodes.toLocaleString() }}
                                </span>
                            </div>
                            <input
                                class="options-slider"
                                type="range"
                                min="250"
                                max="10000"
                                step="250"
                                v-model.number="maxNodes"
                            />
                            <div class="options-hint">
                                Guard rail to keep large states responsive.
                            </div>
                        </div>

                        <div class="options-row">
                            <div class="options-row-main">
                                <span class="options-label">Show types</span>
                                <span class="options-value">
                                    {{ showTypes ? 'On' : 'Off' }}
                                </span>
                            </div>
                            <label class="options-hint">
                                <input type="checkbox" v-model="showTypes" />
                                Display primitive/container types next to each path.
                            </label>
                        </div>

                        <div class="options-row">
                            <div class="options-row-main">
                                <span class="options-label">Wrap values</span>
                                <span class="options-value">
                                    {{ wrapValues ? 'On' : 'Off' }}
                                </span>
                            </div>
                            <label class="options-hint">
                                <input type="checkbox" v-model="wrapValues" />
                                Allow long values to wrap instead of ellipsizing.
                            </label>
                        </div>
                    </div>
                </transition>

                <!-- Toolbar directly above content window (CF-style search) -->
                <div class="as-toolbar">
                    <div class="as-toolbar-left">
                        <label class="as-search">
                            <span class="label">Search:</span>
                            <div class="as-search-input-wrap">
                                <input
                                    class="as-search-input"
                                    type="text"
                                    v-model="searchQuery"
                                    spellcheck="false"
                                />
                                <button
                                    v-if="searchQuery"
                                    class="as-search-clear"
                                    type="button"
                                    @click="onClearSearchClick"
                                    aria-label="Clear search"
                                    title="Clear search"
                                >
                                    ✕
                                </button>
                            </div>
                        </label>
                    </div>

                    <div class="as-toolbar-right"></div>
                </div>

                <!-- Content window frame (like CF fs-panel) -->
                <div class="state-viewport">
                    <div class="state-scroll">
                        <div v-if="rows.length === 0" class="empty-state">
                            <p>No application state values to display yet.</p>
                            <p class="hint">
                                Waiting for the server snapshot / first patch to populate the mirror.
                            </p>
                        </div>

                        <div
                            v-else
                            class="rows"
                            role="tree"
                            aria-label="Application state values"
                        >
                            <div
                                v-for="r in rows"
                                :key="r.id"
                                class="row"
                                :style="{ paddingLeft: `${Math.max(0, r.depth) * 12}px` }"
                                role="treeitem"
                                :aria-expanded="r.isExpandable ? (r.isExpanded ? 'true' : 'false') : undefined"
                            >
                                <button
                                    v-if="r.isExpandable"
                                    class="expander"
                                    type="button"
                                    :title="r.isExpanded ? 'Collapse' : 'Expand'"
                                    @click="toggleExpanded(r.path)"
                                >
                                    {{ r.isExpanded ? '▾' : '▸' }}
                                </button>
                                <span v-else class="expander-spacer"></span>

                                <span class="path" :title="r.path">{{ r.path }}</span>

                                <span v-if="showTypes" class="type" :title="r.type">{{ r.type }}</span>

                                <span
                                    class="value"
                                    :class="{ 'value--wrap': wrapValues }"
                                    :title="r.preview"
                                >
                                    {{ r.preview }}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Footer: bottom-left version counter only -->
                <div class="as-footer">
                    <div class="as-meta-text">
                        <span class="as-meta-version">
                            v{{ stateVersion }}
                        </span>
                    </div>

                    <div class="as-actions"></div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useMirror } from '@/stores/mirror'

/**
 * Pane context — same pattern as SerialPrinterPane.
 */
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
 * Per-pane UI prefs (AppState pane)
 */
type AsPanePrefs = {
    showOptions?: boolean
    searchQuery?: string
    showTypes?: boolean
    wrapValues?: boolean
    maxNodes?: number
    defaultExpandDepth?: number
}

function isObject(x: any): x is Record<string, unknown> {
    return x !== null && typeof x === 'object' && !Array.isArray(x)
}
function isFiniteNumber(x: any): x is number {
    return typeof x === 'number' && Number.isFinite(x)
}
function clampNumber(n: number, min: number, max: number): number {
    if (!Number.isFinite(n)) return min
    return Math.min(max, Math.max(min, n))
}

const props = defineProps<{
    pane?: PaneInfo
    __asPaneUi?: AsPanePrefs
    /** Monotonic "profile load" revision stamped by App.vue to force rehydrate on load. */
    __asPaneProfileRev?: number
}>()

/* -------------------------------------------------------------------------- */
/*  Contrast-aware pane foreground                                            */
/* -------------------------------------------------------------------------- */

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
    const R = srgbToLinear(rgb.r)
    const G = srgbToLinear(rgb.g)
    const B = srgbToLinear(rgb.b)
    return 0.2126 * R + 0.7152 * G + 0.0722 * B
}
function contrastRatio(l1: number, l2: number): number {
    const [L1, L2] = l1 >= l2 ? [l1, l2] : [l2, l1]
    return (L1 + 0.05) / (L2 + 0.05)
}

const paneFg = computed(() => {
    const bg = (props.pane?.appearance?.bg ?? '#111827') as string
    const Lbg = relLuminance(bg)
    const contrastWithWhite = contrastRatio(relLuminance('#ffffff'), Lbg)
    const contrastWithBlack = contrastRatio(relLuminance('#000000'), Lbg)
    return contrastWithWhite >= contrastWithBlack ? '#ffffff' : '#111111'
})

/** Fixed readable text for panel areas (dark backgrounds) */
const panelFg = '#e6e6e6'

/* -------------------------------------------------------------------------- */
/*  Mirror state (authoritative server state reflected locally)               */
/* -------------------------------------------------------------------------- */

const mirror = useMirror()

const appState = computed<any>(() => {
    // SerialPrinterPane treats mirror.data as the root AppState object.
    return (mirror as any)?.data ?? {}
})

const stateVersion = computed<number>(() => {
    // Do not assume a specific store shape; accept either mirror.version or state.version.
    const mv = Number((mirror as any)?.version)
    if (Number.isFinite(mv) && mv >= 0) return mv
    const sv = Number(appState.value?.version)
    if (Number.isFinite(sv) && sv >= 0) return sv
    return 0
})

const hasAnyState = computed(() => {
    const s = appState.value
    if (!s) return false
    if (typeof s !== 'object') return true
    try {
        return Object.keys(s).length > 0
    } catch {
        return true
    }
})

const statusKind = computed(() => {
    return hasAnyState.value ? 'synced' : 'waiting'
})

/**
 * Badge text is keyword-only (no version / extra data).
 */
const statusBadgeLabel = computed(() => {
    return hasAnyState.value ? 'Synced' : 'Waiting'
})

/* -------------------------------------------------------------------------- */
/*  Per-pane UI persistence (localStorage + profile round-trip)               */
/* -------------------------------------------------------------------------- */

const DEFAULT_MAX_NODES = 2500
const DEFAULT_EXPAND_DEPTH = 1

const showOptions = ref(false)
const searchQuery = ref('')
const showTypes = ref(true)
const wrapValues = ref(false)
const maxNodes = ref(DEFAULT_MAX_NODES)
const defaultExpandDepth = ref(DEFAULT_EXPAND_DEPTH)

const paneId = computed(() => String(props.pane?.id ?? '').trim())
const STORAGE_PREFIX = 'as:pane:ui:'
const storageKey = computed(() => (paneId.value ? `${STORAGE_PREFIX}${paneId.value}` : ''))

function readPanePrefs(): AsPanePrefs | null {
    const key = storageKey.value
    if (!key) return null
    try {
        const raw = localStorage.getItem(key)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? (parsed as AsPanePrefs) : null
    } catch {
        return null
    }
}

function writePanePrefs(p: AsPanePrefs) {
    const key = storageKey.value
    if (!key) return
    try {
        localStorage.setItem(key, JSON.stringify(p))
    } catch {
        // ignore
    }
}

function exportPanePrefs(): AsPanePrefs {
    return {
        showOptions: !!showOptions.value,
        searchQuery: searchQuery.value,
        showTypes: !!showTypes.value,
        wrapValues: !!wrapValues.value,
        maxNodes: maxNodes.value,
        defaultExpandDepth: defaultExpandDepth.value,
    }
}

function applyPanePrefs(prefs?: AsPanePrefs | null) {
    if (!prefs || typeof prefs !== 'object') return

    const nextShow = (prefs as any).showOptions
    if (typeof nextShow === 'boolean') showOptions.value = nextShow

    const nextQ = (prefs as any).searchQuery
    if (typeof nextQ === 'string') searchQuery.value = nextQ

    const nextTypes = (prefs as any).showTypes
    if (typeof nextTypes === 'boolean') showTypes.value = nextTypes

    const nextWrap = (prefs as any).wrapValues
    if (typeof nextWrap === 'boolean') wrapValues.value = nextWrap

    const nextMax = (prefs as any).maxNodes
    if (isFiniteNumber(nextMax)) maxNodes.value = clampNumber(Math.floor(nextMax), 100, 100000)

    const nextDepth = (prefs as any).defaultExpandDepth
    if (isFiniteNumber(nextDepth)) defaultExpandDepth.value = clampNumber(Math.floor(nextDepth), 0, 20)
}

const lastHydratedSig = ref<string>('')

function hydrateForPane() {
    const key = storageKey.value
    const rev = typeof props.__asPaneProfileRev === 'number' ? props.__asPaneProfileRev : 0
    const hasEmbed = isObject(props.__asPaneUi)

    if (!key) {
        const sig = `nokey|rev:${rev}|embed:${hasEmbed ? 1 : 0}`
        if (lastHydratedSig.value === sig) return
        lastHydratedSig.value = sig

        if (hasEmbed) applyPanePrefs(props.__asPaneUi as AsPanePrefs)
        return
    }

    const sig = `${key}|rev:${rev}|embed:${hasEmbed ? 1 : 0}`
    if (lastHydratedSig.value === sig) return
    lastHydratedSig.value = sig

    // 1) Embedded prefs win on profile load
    if (hasEmbed) {
        applyPanePrefs(props.__asPaneUi as AsPanePrefs)
        writePanePrefs(exportPanePrefs())
        return
    }

    // 2) localStorage
    const stored = readPanePrefs()
    if (stored) {
        applyPanePrefs(stored)
        return
    }
}

watch([paneId, () => props.__asPaneUi, () => props.__asPaneProfileRev], () => hydrateForPane(), {
    immediate: true,
})

watch(
    [
        () => showOptions.value,
        () => searchQuery.value,
        () => showTypes.value,
        () => wrapValues.value,
        () => maxNodes.value,
        () => defaultExpandDepth.value,
    ],
    () => {
        writePanePrefs(exportPanePrefs())
    }
)

/* CF-style clear button behavior */
function onClearSearchClick() {
    searchQuery.value = ''
}

/* -------------------------------------------------------------------------- */
/*  State explorer (tree by default, flat matches when searching)             */
/* -------------------------------------------------------------------------- */

type Row = {
    id: string
    path: string
    depth: number
    type: string
    preview: string
    isExpandable: boolean
    isExpanded: boolean
}

const expandedMap = ref<Record<string, boolean>>({})

function isExpandable(v: any): boolean {
    return v !== null && typeof v === 'object'
}

function typeOf(v: any): string {
    if (v === null) return 'null'
    if (Array.isArray(v)) return 'array'
    return typeof v
}

function previewOf(v: any): string {
    const t = typeOf(v)
    if (t === 'string') {
        const s = String(v)
        return s.length > 220 ? `${s.slice(0, 220)}…` : s
    }
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v)
    if (t === 'undefined') return 'undefined'
    if (t === 'function') return 'function'
    if (t === 'symbol') return 'symbol'
    if (t === 'null') return 'null'
    if (t === 'array') return `Array(${(v as any[]).length})`
    // object
    try {
        const keys = Object.keys(v as any)
        return `Object(${keys.length})`
    } catch {
        return 'Object(?)'
    }
}

function getExpanded(path: string): boolean {
    return expandedMap.value[path] === true
}

function toggleExpanded(path: string) {
    expandedMap.value = {
        ...expandedMap.value,
        [path]: !getExpanded(path),
    }
}

function collapseAll() {
    expandedMap.value = {}
}

function seedExpansion() {
    // Seed expandedMap up to a depth based on current state; does not require any store-specific fields.
    const next: Record<string, boolean> = {}

    const depthLimit = clampNumber(defaultExpandDepth.value, 0, 20)

    function walk(v: any, path: string, depth: number) {
        if (!isExpandable(v)) return
        if (depth >= depthLimit) return

        next[path] = true

        if (Array.isArray(v)) {
            const n = Math.min(v.length, 50)
            for (let i = 0; i < n; i++) {
                walk(v[i], `${path}[${i}]`, depth + 1)
            }
            return
        }

        let keys: string[] = []
        try {
            keys = Object.keys(v)
        } catch {
            return
        }
        const n = Math.min(keys.length, 50)
        for (let i = 0; i < n; i++) {
            const k = keys[i]
            if (!k) continue
            walk(v[k], path ? `${path}.${k}` : k, depth + 1)
        }
    }

    const root = appState.value
    if (isExpandable(root)) {
        // Seed starting from top-level keys (no synthetic "root" node).
        if (Array.isArray(root)) {
            const n = Math.min(root.length, 50)
            for (let i = 0; i < n; i++) walk(root[i], `[${i}]`, 0)
        } else {
            let keys: string[] = []
            try {
                keys = Object.keys(root)
            } catch {
                keys = []
            }
            const n = Math.min(keys.length, 200)
            for (let i = 0; i < n; i++) {
                const k = keys[i]
                if (!k) continue
                walk(root[k], k, 0)
            }
        }
    }

    expandedMap.value = next
}

function buildTreeRows(root: any, nodeLimit: number): Row[] {
    const out: Row[] = []
    let count = 0

    function pushRow(path: string, depth: number, v: any) {
        if (count >= nodeLimit) return
        count++

        const t = typeOf(v)
        const expandable = isExpandable(v)

        out.push({
            id: `${path}|${depth}`,
            path,
            depth,
            type: t,
            preview: previewOf(v),
            isExpandable: expandable,
            isExpanded: expandable ? getExpanded(path) : false,
        })
    }

    function walk(v: any, path: string, depth: number) {
        pushRow(path, depth, v)
        if (count >= nodeLimit) return
        if (!isExpandable(v)) return
        if (!getExpanded(path)) return

        if (Array.isArray(v)) {
            const n = v.length
            for (let i = 0; i < n; i++) {
                if (count >= nodeLimit) return
                walk(v[i], `${path}[${i}]`, depth + 1)
            }
            return
        }

        let keys: string[] = []
        try {
            keys = Object.keys(v)
        } catch {
            return
        }
        for (const k of keys) {
            if (count >= nodeLimit) return
            const childPath = path ? `${path}.${k}` : k
            walk((v as any)[k], childPath, depth + 1)
        }
    }

    // No synthetic root row; show top-level keys as the list.
    if (!isExpandable(root)) {
        pushRow('(state)', 0, root)
        return out
    }

    if (Array.isArray(root)) {
        for (let i = 0; i < root.length && count < nodeLimit; i++) {
            walk(root[i], `[${i}]`, 0)
        }
        return out
    }

    let keys: string[] = []
    try {
        keys = Object.keys(root)
    } catch {
        keys = []
    }
    for (const k of keys) {
        if (count >= nodeLimit) break
        walk(root[k], k, 0)
    }

    return out
}

function buildFlatMatchRows(root: any, nodeLimit: number, needle: string): Row[] {
    const out: Row[] = []
    let count = 0
    const q = needle.trim().toLowerCase()

    function consider(path: string, depth: number, v: any) {
        if (count >= nodeLimit) return
        const p = path.toLowerCase()
        const pv = previewOf(v).toLowerCase()
        const tt = typeOf(v)
        const hit = p.includes(q) || pv.includes(q) || tt.includes(q)
        if (!hit) return

        count++
        out.push({
            id: `${path}|flat`,
            path,
            depth,
            type: tt,
            preview: previewOf(v),
            isExpandable: isExpandable(v),
            isExpanded: false,
        })
    }

    function walk(v: any, path: string, depth: number) {
        consider(path, depth, v)
        if (count >= nodeLimit) return
        if (!isExpandable(v)) return

        if (Array.isArray(v)) {
            const n = v.length
            for (let i = 0; i < n; i++) {
                if (count >= nodeLimit) return
                walk(v[i], `${path}[${i}]`, depth + 1)
            }
            return
        }

        let keys: string[] = []
        try {
            keys = Object.keys(v)
        } catch {
            return
        }
        for (const k of keys) {
            if (count >= nodeLimit) return
            const childPath = path ? `${path}.${k}` : k
            walk((v as any)[k], childPath, depth + 1)
        }
    }

    if (!isExpandable(root)) {
        consider('(state)', 0, root)
        return out
    }

    if (Array.isArray(root)) {
        for (let i = 0; i < root.length && count < nodeLimit; i++) {
            walk(root[i], `[${i}]`, 0)
        }
        return out
    }

    let keys: string[] = []
    try {
        keys = Object.keys(root)
    } catch {
        keys = []
    }
    for (const k of keys) {
        if (count >= nodeLimit) break
        walk(root[k], k, 0)
    }
    return out
}

const rows = computed<Row[]>(() => {
    const limit = clampNumber(maxNodes.value, 100, 100000)
    const root = appState.value
    const q = searchQuery.value.trim()
    if (q) return buildFlatMatchRows(root, limit, q)
    return buildTreeRows(root, limit)
})

function resetPrefs() {
    showOptions.value = false
    searchQuery.value = ''
    showTypes.value = true
    wrapValues.value = false
    maxNodes.value = DEFAULT_MAX_NODES
    defaultExpandDepth.value = DEFAULT_EXPAND_DEPTH
}

/**
 * Safety: do not keep stale expansion state across unmount; this is purely UI-local.
 */
onBeforeUnmount(() => {
    expandedMap.value = {}
})
</script>

<style scoped>
.as-pane {
    --pane-fg: #111;
    --panel-fg: #e6e6e6;

    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    height: 100%;
    min-height: 0;
    color: var(--pane-fg);
}

/* Hotspot area for options button (top-right). */
.as-options-hotspot {
    position: absolute;
    top: 0;
    right: 0;
    width: 3.2rem;
    height: 2.4rem;
    pointer-events: auto;
    z-index: 30;
}

/* Gear button (visible only while hotspot is hovered) */
.gear-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    height: 28px;
    min-width: 28px;
    padding: 0 8px;
    border-radius: 6px;
    border: 1px solid #333;
    background: #050816;
    color: #eee;
    cursor: pointer;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition:
        opacity 120ms ease,
        background 120ms ease,
        border-color 120ms ease,
        transform 60ms ease;
    z-index: 31;
}
.as-options-hotspot:hover .gear-btn {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
}
.gear-btn:hover {
    background: #0f172a;
    border-color: #4b5563;
    transform: translateY(-1px);
}

/* Slide-fade transition for options panel */
.slide-fade-enter-active,
.slide-fade-leave-active {
    transition: opacity 180ms ease, transform 180ms ease;
}
.slide-fade-enter-from,
.slide-fade-leave-to {
    opacity: 0;
    transform: translateY(-6px);
}

/* -------------------------------------------------------------------------- */
/*  Two-surface styling (match CF pane)                                       */
/*  - Panel: near-black                                                       */
/*  - Content window: dark blue                                               */
/* -------------------------------------------------------------------------- */

.panel {
    background: #0b0d12; /* near-black panel surface (CF-style) */
    border: 1px solid #1f2933;
    border-radius: 8px;
    padding: 8px;
    color: var(--panel-fg);
    display: flex;
    flex-direction: column;
    gap: 8px;

    flex: 1 1 0%;
    min-height: 0;
}

/* Panel header */
.panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 2px;
    font-size: 0.8rem;
}

.panel-title-group {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

.panel-title {
    font-weight: 500;
    font-size: 0.8rem;
}

/* Settings button “over the title” (appears on hover of title group) */
.title-gear-btn {
    height: 24px;
    min-width: 24px;
    padding: 0 8px;
    border-radius: 6px;
    border: 1px solid #334155;
    background: #020617;
    color: #e5e7eb;
    cursor: pointer;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition:
        opacity 120ms ease,
        background 120ms ease,
        transform 60ms ease,
        border-color 120ms ease;
}
.panel-title-group:hover .title-gear-btn {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
}
.title-gear-btn:hover {
    background: #111827;
    border-color: #9ca3af;
    transform: translateY(-0.5px);
}

/* Status badge */
.status-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid #374151;
    background: #0b0d12; /* match panel surface */
    font-size: 0.75rem;
    color: var(--panel-fg);
}
.status-badge .dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: #9ca3af;
}

/* Synced (green) */
.status-badge[data-status='synced'] {
    border-color: #22c55e;
    background: #022c22;
}
.status-badge[data-status='synced'] .dot {
    background: #22c55e;
}

/* Waiting (gray) */
.status-badge[data-status='waiting'] {
    border-color: #4b5563;
    background: #0b0d12;
}
.status-badge[data-status='waiting'] .dot {
    background: #6b7280;
}

/* Body wrapper (below header) */
.panel-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1 1 0%;
    min-height: 0;
}

/* -------------------------------------------------------------------------- */
/*  CF-style toolbar search (position + styling matches CF pane)              */
/* -------------------------------------------------------------------------- */

.as-toolbar {
    margin-top: 4px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 0.78rem;
}

.as-toolbar-left {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.as-toolbar-right {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    min-width: 40px;
}

.as-search {
    display: inline-flex;
    align-items: center;
    gap: 4px;
}

.as-search .label {
    opacity: 0.7;
}

/* Wrap for input + clear icon */
.as-search-input-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
}

.as-search-input {
    --control-h: 28px;

    background: #020617;
    color: var(--panel-fg);
    border: 1px solid #374151;
    border-radius: 6px;
    padding: 0 20px 0 8px; /* extra right padding for clear button */
    min-width: 40px;
    max-width: 100px;
    font-size: 0.76rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
        'Courier New', monospace;
    height: var(--control-h);
    line-height: var(--control-h);
}

/* Tiny "×" clear control inside the input */
.as-search-clear {
    position: absolute;
    right: 10px;
    top: 50%;
    transform: translateY(-50%);
    width: 16px;
    height: 16px;
    border-radius: 999px;
    border: none;
    padding: 0;
    background: transparent;
    color: #9ca3af;
    cursor: pointer;
    font-size: 0.75rem;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}

.as-search-clear:hover {
    background: rgba(148, 163, 184, 0.18);
    color: #e5e7eb;
}

/* Content window frame (like CF fs-panel) */
.state-viewport {
    flex: 1 1 0%;
    min-height: 0;
    display: flex;
    flex-direction: column;

    padding: 6px 8px;
    border-radius: 6px;
    border: 1px dashed #4b5563;
    background: #020617; /* dark blue content surface */
    overflow: hidden;
}

/* Scrollable content area inside the content window */
.state-scroll {
    flex: 1 1 0%;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    background: #020617;
    padding: 6px 6px;
}

/* Rows */
.rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.row {
    display: grid;
    grid-template-columns: 18px 1fr auto 1fr;
    gap: 8px;
    align-items: baseline;
    padding: 3px 6px;
    border-radius: 6px;
    border: 1px solid transparent;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
        monospace;
    font-size: 0.74rem;
    color: var(--panel-fg);
    min-width: 0;
}
.row:hover {
    border-color: rgba(148, 163, 184, 0.22);
    background: #030712; /* CF-like hover */
}

.expander {
    height: 18px;
    width: 18px;
    padding: 0;
    border: 1px solid rgba(148, 163, 184, 0.25);
    border-radius: 4px;
    background: rgba(2, 6, 23, 0.75);
    color: #e5e7eb;
    cursor: pointer;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.expander:hover {
    background: rgba(17, 24, 39, 0.9);
}
.expander-spacer {
    display: inline-block;
    width: 18px;
    height: 18px;
}

.path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsize;
    white-space: nowrap;
    color: #dbeafe;
}

.type {
    color: #a7f3d0;
    font-variant-numeric: tabular-nums;
    padding-left: 6px;
    padding-right: 6px;
    white-space: nowrap;
    opacity: 0.9;
}

.value {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #e5e7eb;
}

.value--wrap {
    white-space: pre-wrap;
    overflow: visible;
    text-overflow: unset;
    word-break: break-word;
}

/* Empty state */
.empty-state {
    text-align: center;
    padding: 24px 8px 12px;
    color: #6b7280;
    font-size: 0.78rem;
}
.empty-state .hint {
    margin-top: 4px;
    font-size: 0.72rem;
    opacity: 0.9;
}

/* Footer (bottom-left version counter) */
.as-footer {
    margin-top: 4px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.as-meta-text {
    font-size: 0.72rem;
    opacity: 0.75;
    align-self: flex-start;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px;
}

.as-actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
}

/* Options panel */
.options-panel {
    margin-top: 4px;
    padding: 6px 8px 8px;
    border-radius: 6px;
    border: 1px dashed #374151;
    background: #020617; /* keep aligned with “inner” surface */
    font-size: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.options-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 2px;
}
.options-title {
    font-weight: 600;
    font-size: 0.78rem;
}
.options-reset-btn {
    border: 1px solid #4b5563;
    background: #020617;
    color: #e5e7eb;
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 0.7rem;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease, transform 60ms ease;
}
.options-reset-btn:hover {
    background: #111827;
    border-color: #9ca3af;
    transform: translateY(-0.5px);
}

.options-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.options-row-main {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
}

.options-label {
    font-weight: 500;
}
.options-value {
    font-variant-numeric: tabular-nums;
    color: #e5e7eb;
}
.options-slider {
    width: 100%;
}
.options-input {
    width: 100%;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid #374151;
    background: rgba(2, 6, 23, 0.9);
    color: #e5e7eb;
    font-size: 0.75rem;
}
.options-input::placeholder {
    color: rgba(229, 231, 235, 0.45);
}
.options-hint {
    opacity: 0.7;
    font-size: 0.7rem;
    line-height: 1.25;
}
.options-btn-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
}
.options-small-btn {
    border: 1px solid #4b5563;
    background: #020617;
    color: #e5e7eb;
    border-radius: 999px;
    padding: 2px 10px;
    font-size: 0.7rem;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease, transform 60ms ease;
}
.options-small-btn:hover {
    background: #111827;
    border-color: #9ca3af;
    transform: translateY(-0.5px);
}

/* Responsive tweaks */
@media (max-width: 720px) {
    .panel-head {
        flex-direction: column;
        align-items: flex-start;
    }
    .status-badge {
        align-self: flex-start;
    }
    .row {
        grid-template-columns: 18px 1fr;
        grid-auto-rows: auto;
        align-items: start;
    }
    .type,
    .value {
        display: none;
    }
    .as-footer {
        flex-direction: column;
        align-items: flex-start;
    }
    .as-toolbar {
        flex-direction: column;
        align-items: flex-start;
    }
    .as-toolbar-right {
        align-self: stretch;
        justify-content: flex-start;
    }
}
</style>
