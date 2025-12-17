<template>
    <div class="stream-pane" :style="{ '--pane-fg': paneFg, '--panel-fg': panelFg }">
        <!-- Hotspot region: only hovering here shows the advanced controls button -->
        <div class="stream-advanced-hotspot">
            <button
                class="gear-btn"
                :aria-expanded="showControls ? 'true' : 'false'"
                aria-controls="stream-controls-panel"
                title="Show stream settings"
                @click="showControls = !showControls"
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
            </div>
        </transition>

        <!-- Main viewport (panel-styled) -->
        <div
            class="viewport"
            :data-bg="bgMode"
        >
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
import { computed, ref } from 'vue'

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

const props = defineProps<{
    pane?: PaneInfo
}>()

/**
 * Endpoint is always the orchestrator proxy.
 * The orchestrator is responsible for talking to the sidecar on localhost.
 */
const STREAM_ENDPOINT = '/api/sidecar/stream'

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

/* Gear button (same pattern as logs pane) */
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

/* plain text bits should use pane foreground */
.plain-text {
    color: var(--pane-fg);
    display: inline-flex;
    align-items: center;
    gap: 8px;
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
</style>
