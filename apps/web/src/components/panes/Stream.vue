<template>
    <div class="stream-pane" :style="{ '--pane-fg': paneFg, '--panel-fg': panelFg }">
        <!-- Hotspot region: only hovering here shows the advanced controls button -->
        <div class="stream-advanced-hotspot">
            <button
                class="gear-btn"
                :aria-expanded="showControls ? 'true' : 'false'"
                aria-controls="stream-controls-panel"
                title="Show stream settings"
                @click="toggleControls"
            >
                ⚙️
            </button>
        </div>

        <!-- Settings panel (hidden by default) -->
        <transition name="slide-fade">
            <div v-show="showControls" id="stream-controls-panel" class="controls-panel">
                <div class="toolbar">
                    <div class="left">
                        <div class="controls">
                            <!-- Enable / disable stream -->
                            <label class="checkbox panel panel-text">
                                <input
                                    type="checkbox"
                                    v-model="enabled"
                                    @change="onEnabledChange"
                                />
                                <span>Show stream</span>
                            </label>

                            <!-- Scale mode -->
                            <label class="select panel-text">
                                <span>Scale</span>
                                <select v-model="scaleMode">
                                    <option value="fit">Fit</option>
                                    <option value="fill">Fill</option>
                                    <option value="stretch">Stretch</option>
                                    <option value="native">1:1</option>
                                </select>
                            </label>

                            <!-- Background style (for black vs pane background) -->
                            <label class="select panel-text">
                                <span>Background</span>
                                <select v-model="bgMode">
                                    <option value="black">Black</option>
                                    <option value="pane">Pane</option>
                                </select>
                            </label>
                        </div>
                    </div>
                    <div class="right">
                        <!-- Placeholder for future info (resolution/fps, status) -->
                    </div>
                </div>

                <!-- Sidecar / stream health details -->
                <div class="health-panel">
                    <div class="health-header">
                        <span class="health-title">Sidecar / Stream health</span>

                        <span class="health-meta">
                            <span
                                v-if="healthLoading"
                                class="health-pill health-pill--loading"
                            >
                                Loading…
                            </span>
                            <span v-else-if="health" class="health-pill health-pill--ok">
                                {{ health.status === 'ok' ? 'OK' : health.status }}
                            </span>
                            <span
                                v-else-if="healthError"
                                class="health-pill health-pill--error"
                            >
                                Error
                            </span>
                        </span>
                    </div>

                    <div v-if="healthError" class="health-error">⚠️ {{ healthError }}</div>

                    <div v-else-if="health" class="health-grid">
                        <div class="health-row">
                            <span class="label">Service</span>
                            <span class="value monospace">{{ health.service }}</span>
                        </div>

                        <div class="health-row">
                            <span class="label">Uptime</span>
                            <span class="value">
                                {{ formattedUptime }}
                            </span>
                        </div>

                        <div class="health-row">
                            <span class="label">Capture</span>
                            <span class="value">
                                <span v-if="health.capture?.running">Running</span>
                                <span v-else>Stopped</span>
                                <span v-if="health.capture?.restartCount != null">
                                    · {{ health.capture.restartCount }} restart<span
                                        v-if="health.capture.restartCount !== 1"
                                        >s</span
                                    >
                                </span>
                            </span>
                        </div>

                        <div class="health-row">
                            <span class="label">Frame</span>
                            <span class="value monospace">
                                {{ health.capture?.metrics?.frame ?? '—' }}
                            </span>
                        </div>

                        <div class="health-row">
                            <span class="label">FPS</span>
                            <span class="value monospace">
                                {{ health.capture?.metrics?.fps ?? '—' }}
                            </span>
                        </div>

                        <div class="health-row">
                            <span class="label">Quality</span>
                            <span class="value monospace">
                                {{ health.capture?.metrics?.quality ?? '—' }}
                            </span>
                        </div>
                    </div>

                    <div v-else class="health-empty">No health data yet.</div>
                </div>
            </div>
        </transition>

        <!-- Main viewport (panel-styled) -->
        <div class="viewport" :data-bg="bgMode">
            <div v-if="enabled" class="viewport-inner">
                <img
                    :key="reloadKey"
                    class="stream-img"
                    :data-scale="scaleMode"
                    :src="STREAM_ENDPOINT"
                    alt="Test machine stream"
                />
            </div>
            <div v-else class="viewport-placeholder">
                <span class="placeholder-text">Stream is hidden (use ⚙️ to show)</span>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'

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
 * Per-pane UI prefs (Stream pane)
 * - NOT written to any global store
 * - persisted per pane id in localStorage as a fallback
 *
 * NOTE: App.vue may inject these via leaf.props.__streamPaneUi when saving/loading profiles.
 */
type StreamPanePrefs = {
    enabled?: boolean
    scaleMode?: 'fit' | 'fill' | 'stretch' | 'native'
    bgMode?: 'black' | 'pane'
}

function isObject(x: any): x is Record<string, unknown> {
    return x !== null && typeof x === 'object' && !Array.isArray(x)
}

const props = defineProps<{
    pane?: PaneInfo
    __streamPaneUi?: StreamPanePrefs
    /** Monotonic "profile load" revision stamped by App.vue to force rehydrate on load. */
    __streamPaneProfileRev?: number
}>()

/**
 * Endpoint is always the orchestrator proxy.
 * The orchestrator is responsible for talking to the sidecar on localhost.
 */
const STREAM_ENDPOINT = '/api/sidecar/stream'
const HEALTH_ENDPOINT = '/api/sidecar/health'

/* -------------------------------------------------------------------------- */
/*  Sidecar health shape                                                      */
/* -------------------------------------------------------------------------- */

type SidecarHealthMetrics = {
    frame?: string
    fps?: string
    quality?: string
    time?: string
}

type SidecarHealthCapture = {
    running: boolean
    lastFrameTs: number | null
    lastError: string | null
    restartCount: number
    metrics?: SidecarHealthMetrics
    hasLastFrame: boolean
}

type SidecarHealthEnv = {
    nodeEnv: string
    port: number
    host: string
    ffmpegArgsConfigured: boolean
    maxStreamClients: number
    recordingsRoot: string
    maxRecordings: number
}

type SidecarHealth = {
    service: string
    status: string
    timestamp: string
    uptimeSec: number
    hostname: string
    env: SidecarHealthEnv
    capture?: SidecarHealthCapture
    reasons: string[]
}

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

/* ------------- local UI state ------------- */

const showControls = ref(false)

/** Whether the stream is actively rendered. */
const enabled = ref(true)

/** Scaling mode for the image. */
const scaleMode = ref<'fit' | 'fill' | 'stretch' | 'native'>('fit')

/** Background mode: black (default) or pane background. */
const bgMode = ref<'black' | 'pane'>('black')

/** Reload key forces <img> to re-request the stream (by remounting it). */
const reloadKey = ref(0)

/* -------------------------------------------------------------------------- */
/*  Per-pane persistence (localStorage + profile round-trip)                   */
/* -------------------------------------------------------------------------- */

function isValidScaleMode(x: any): x is 'fit' | 'fill' | 'stretch' | 'native' {
    return x === 'fit' || x === 'fill' || x === 'stretch' || x === 'native'
}
function isValidBgMode(x: any): x is 'black' | 'pane' {
    return x === 'black' || x === 'pane'
}

const paneId = computed(() => String(props.pane?.id ?? '').trim())
const STORAGE_PREFIX = 'stream:pane:ui:'
const storageKey = computed(() => (paneId.value ? `${STORAGE_PREFIX}${paneId.value}` : ''))

function readPanePrefs(): StreamPanePrefs | null {
    const key = storageKey.value
    if (!key) return null
    try {
        const raw = localStorage.getItem(key)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? (parsed as StreamPanePrefs) : null
    } catch {
        return null
    }
}

function writePanePrefs(p: StreamPanePrefs) {
    const key = storageKey.value
    if (!key) return
    try {
        localStorage.setItem(key, JSON.stringify(p))
    } catch {
        // ignore
    }
}

function applyPanePrefs(prefs?: StreamPanePrefs | null) {
    if (!prefs || typeof prefs !== 'object') return

    const nextEnabled = (prefs as any).enabled
    if (typeof nextEnabled === 'boolean') enabled.value = nextEnabled

    const nextScale = (prefs as any).scaleMode
    if (isValidScaleMode(nextScale)) scaleMode.value = nextScale

    const nextBg = (prefs as any).bgMode
    if (isValidBgMode(nextBg)) bgMode.value = nextBg
}

function exportPanePrefs(): StreamPanePrefs {
    return {
        enabled: !!enabled.value,
        scaleMode: scaleMode.value,
        bgMode: bgMode.value
    }
}

/**
 * Hydration priority:
 * 1) profile-embedded prefs (leaf.props.__streamPaneUi) if present
 * 2) per-pane localStorage
 * 3) local defaults (refs above)
 *
 * Important: profile load must override "recent modifications", even if pane id is unchanged.
 * App.vue stamps a monotonic __streamPaneProfileRev on leaves to force this rehydrate.
 */
const lastHydratedSig = ref<string>('')

function hydrateForPane() {
    const key = storageKey.value
    const rev = typeof props.__streamPaneProfileRev === 'number' ? props.__streamPaneProfileRev : 0
    const hasEmbed = isObject(props.__streamPaneUi)

    // If we can’t key this pane yet (no id), we can still apply embedded prefs on change.
    if (!key) {
        const sig = `nokey|rev:${rev}|embed:${hasEmbed ? 1 : 0}`
        if (lastHydratedSig.value === sig) return
        lastHydratedSig.value = sig

        if (hasEmbed) applyPanePrefs(props.__streamPaneUi as StreamPanePrefs)
        return
    }

    // Rehydrate whenever:
    // - pane id changes
    // - profile rev changes
    // - embedded presence changes
    const sig = `${key}|rev:${rev}|embed:${hasEmbed ? 1 : 0}`
    if (lastHydratedSig.value === sig) return
    lastHydratedSig.value = sig

    // 1) Embedded prefs from profile/layout snapshot (authoritative on profile load)
    if (hasEmbed) {
        applyPanePrefs(props.__streamPaneUi as StreamPanePrefs)
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

    // 3) defaults already set by refs
}

onMounted(() => {
    hydrateForPane()
})

// Rehydrate on pane id change OR when profile injects new prefs/rev (profile load)
watch([paneId, () => props.__streamPaneUi, () => props.__streamPaneProfileRev], () =>
    hydrateForPane()
)

// Persist per-pane prefs whenever these change (if pane id exists)
watch(
    [() => enabled.value, () => scaleMode.value, () => bgMode.value],
    () => {
        writePanePrefs(exportPanePrefs())
    }
)

/* ------------- health state ------------- */

const health = ref<SidecarHealth | null>(null)
const healthLoading = ref(false)
const healthError = ref<string | null>(null)

/* Format uptime like "1h 32m 10s" or "12m 05s" etc. */
const formattedUptime = computed(() => {
    const sec = health.value?.uptimeSec
    if (sec == null || !Number.isFinite(sec) || sec < 0) return '—'

    const total = Math.floor(sec)
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const seconds = total % 60

    const parts: string[] = []
    if (hours > 0) parts.push(`${hours}h`)
    if (minutes > 0 || hours > 0) parts.push(`${minutes}m`)
    parts.push(`${seconds}s`)

    return parts.join(' ')
})

async function loadHealth() {
    healthLoading.value = true
    healthError.value = null

    try {
        const res = await fetch(HEALTH_ENDPOINT, {
            method: 'GET',
            headers: {
                Accept: 'application/json'
            }
        })

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`)
        }

        const json = (await res.json()) as SidecarHealth
        health.value = json
    } catch (err: any) {
        health.value = null
        healthError.value =
            err?.message ? `Failed to load health: ${err.message}` : 'Failed to load health'
    } finally {
        healthLoading.value = false
    }
}

function toggleControls() {
    const next = !showControls.value
    showControls.value = next
}

/* When advanced panel is opened, fetch fresh health details. */
watch(
    () => showControls.value,
    (open) => {
        if (open) {
            void loadHealth()
        }
    }
)

function onEnabledChange() {
    // When re-enabling the stream, force a reload so we don't rely on a stale connection.
    if (enabled.value) {
        reloadStream()
    }
}

function reloadStream() {
    reloadKey.value++
}
</script>

<style scoped>
.stream-pane {
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
.stream-advanced-hotspot {
    position: absolute;
    top: 0;
    right: 0;
    width: 3.2rem;
    height: 2.4rem;
    pointer-events: auto;
    z-index: 30;
}

/* Gear button (same pattern as logs / CF pane) */
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
.stream-advanced-hotspot:hover .gear-btn {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
}

.gear-btn:hover {
    background: #1a1a1a;
    transform: translateY(-1px);
}

/* Slide-fade transition (for controls panel) */
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

/* Checkbox (panel style) */
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
.btn:hover {
    background: #1a1a1a;
}

/* Health panel */
.health-panel {
    margin-top: 4px;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px dashed #4b5563;
    background: #020617;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.76rem;
    color: var(--panel-fg);
}

.health-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
}

.health-title {
    font-weight: 500;
    opacity: 0.9;
}

.health-meta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}

.health-pill {
    padding: 0 8px;
    border-radius: 999px;
    border: 1px solid #374151;
    font-size: 0.72rem;
    line-height: 1.4;
}

.health-pill--ok {
    border-color: #22c55e;
    background: #022c22;
}

.health-pill--loading {
    border-color: #38bdf8;
    background: #022c3a;
}

.health-pill--error {
    border-color: #ef4444;
    background: #450a0a;
}

.health-error {
    font-size: 0.74rem;
    color: #fecaca;
}

.health-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px 10px;
}

.health-row {
    display: flex;
    justify-content: space-between;
    gap: 6px;
}

.health-row .label {
    opacity: 0.7;
}

.health-row .value {
    text-align: right;
}

.health-empty {
    opacity: 0.7;
}

/* Main viewport */
.viewport {
    flex: 1;
    min-height: 0;
    background: #000;
    border: 1px solid #222;
    border-radius: 8px;
    padding: 4px;
    display: flex;
    align-items: stretch;
    justify-content: stretch;
}

/* Background mode: pane vs black */
.viewport[data-bg='pane'] {
    background: transparent;
    border-color: transparent;
}

/* Inner container centers the stream visually */
.viewport-inner {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
}

/* MJPEG stream image */
.stream-img {
    max-width: 100%;
    max-height: 100%;
    image-rendering: auto;
}

/* Scale modes */
.stream-img[data-scale='fit'] {
    object-fit: contain;
}
.stream-img[data-scale='fill'] {
    width: 100%;
    height: 100%;
    object-fit: cover;
}
.stream-img[data-scale='stretch'] {
    width: 100%;
    height: 100%;
    object-fit: fill;
}
.stream-img[data-scale='native'] {
    max-width: none;
    max-height: none;
    object-fit: contain;
}

/* Placeholder when stream is disabled */
.viewport-placeholder {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
}
.placeholder-text {
    color: var(--panel-fg);
    font-size: 13px;
    opacity: 0.75;
}

.monospace {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
        'Courier New', monospace;
}
</style>
