<template>
    <div class="pm-pane" :style="{ '--pane-fg': paneFg, '--panel-fg': panelFg }">
        <!-- Hover gear button (toggles advanced view) -->
        <button
            class="gear-btn"
            :aria-expanded="showAdvanced ? 'true' : 'false'"
            aria-controls="pm-advanced-panel"
            title="Show recording controls & stats"
            @click="showAdvanced = !showAdvanced"
        >
            ⚙️
        </button>

        <!-- Single main panel (scrollable in advanced mode) -->
        <div class="panel current-panel" :class="{ 'panel--scrollable': showAdvanced }">
            <!-- Panel header: title (left) + status (right) -->
            <div class="panel-head">
                <div class="panel-title-group">
                    <span class="panel-title">Test System Power Consumption</span>
                </div>

                <!-- Status badge on the right side -->
                <span class="status-badge" :data-phase="state.phase">
                    <span class="dot"></span>
                    <span class="label">{{ statusLabel }}</span>
                </span>
            </div>

            <!-- ADVANCED VIEW: recording controls + compact stats table -->
            <transition name="slide-fade">
                <div
                    v-if="showAdvanced"
                    id="pm-advanced-panel"
                    class="advanced-section"
                >
                    <!-- Record controls -->
                    <div class="pm-controls">
                        <button
                            v-if="recState === 'idle'"
                            class="btn primary"
                            :disabled="!canRecord"
                            @click="startRecording"
                        >
                            ● Record
                        </button>

                        <template v-else-if="recState === 'recording'">
                            <button class="btn" @click="pauseRecording">Pause</button>
                            <button class="btn danger" @click="stopRecording">Stop &amp; Reset</button>
                        </template>

                        <template v-else-if="recState === 'paused'">
                            <button class="btn primary" @click="resumeRecording">Resume</button>
                            <button class="btn danger" @click="stopRecording">Stop &amp; Reset</button>
                        </template>

                        <span v-if="recState !== 'idle'" class="rec-meta">
                            {{ recStateLabel }} • {{ sampleCount }} samples
                        </span>
                        <span v-else class="rec-meta dim">
                            Recording controls (idle)
                        </span>
                    </div>

                    <!-- Recording stats (compact grid: rows = metrics, cols = cur/avg/min/max) -->
                    <div class="stats-panel">
                        <div class="stats-grid" :data-empty="sampleCount === 0">
                            <div v-if="sampleCount === 0" class="stats-empty">
                                No samples recorded yet.
                            </div>

                            <template v-else>
                                <div class="stats-table">
                                    <!-- Header row -->
                                    <div class="stats-header-row">
                                        <div class="stats-header-cell label-cell"></div>
                                        <div class="stats-header-cell">Current</div>
                                        <div class="stats-header-cell">Avg</div>
                                        <div class="stats-header-cell">Min</div>
                                        <div class="stats-header-cell">Max</div>
                                    </div>

                                    <!-- Watts row -->
                                    <div class="stats-body-row">
                                        <div class="stats-row-label">Watts</div>
                                        <div class="stats-cell">
                                            <span v-if="latest">{{ latest.watts.toFixed(2) }} W</span>
                                            <span v-else>—</span>
                                        </div>
                                        <div class="stats-cell">
                                            <span v-if="avgWatts != null">{{ avgWatts.toFixed(2) }} W</span>
                                            <span v-else>—</span>
                                        </div>
                                        <div class="stats-cell">
                                            <span v-if="minWatts != null">{{ minWatts.toFixed(2) }} W</span>
                                            <span v-else>—</span>
                                        </div>
                                        <div class="stats-cell">
                                            <span v-if="maxWatts != null">{{ maxWatts.toFixed(2) }} W</span>
                                            <span v-else>—</span>
                                        </div>
                                    </div>

                                    <!-- Volts row -->
                                    <div class="stats-body-row">
                                        <div class="stats-row-label">Volts</div>
                                        <div class="stats-cell">
                                            <span v-if="latest">{{ latest.volts.toFixed(2) }} V</span>
                                            <span v-else>—</span>
                                        </div>
                                        <div class="stats-cell">
                                            <span v-if="avgVolts != null">{{ avgVolts.toFixed(2) }} V</span>
                                            <span v-else>—</span>
                                        </div>
                                        <div class="stats-cell">
                                            <span v-if="minVolts != null">{{ minVolts.toFixed(2) }} V</span>
                                            <span v-else>—</span>
                                        </div>
                                        <div class="stats-cell">
                                            <span v-if="maxVolts != null">{{ maxVolts.toFixed(2) }} V</span>
                                            <span v-else>—</span>
                                        </div>
                                    </div>

                                    <!-- Amps row -->
                                    <div class="stats-body-row">
                                        <div class="stats-row-label">Amps</div>
                                        <div class="stats-cell">
                                            <span v-if="latest">{{ latest.amps.toFixed(4) }} A</span>
                                            <span v-else>—</span>
                                        </div>
                                        <div class="stats-cell">
                                            <span v-if="avgAmps != null">{{ avgAmps.toFixed(4) }} A</span>
                                            <span v-else>—</span>
                                        </div>
                                        <div class="stats-cell">
                                            <span v-if="minAmps != null">{{ minAmps.toFixed(4) }} A</span>
                                            <span v-else>—</span>
                                        </div>
                                        <div class="stats-cell">
                                            <span v-if="maxAmps != null">{{ maxAmps != null ? maxAmps.toFixed(4) : '' }} A</span>
                                            <span v-else>—</span>
                                        </div>
                                    </div>
                                </div>

                                <!-- Energy line (separate from table, single value) -->
                                <div class="energy-row">
                                    <span class="energy-label">Energy (approx)</span>
                                    <span class="energy-value">
                                        {{ wattHoursApprox!.toFixed(4) }} Wh
                                    </span>
                                </div>
                            </template>
                        </div>
                    </div>

                    <!-- Chart advanced options (x-axis window & resolution) -->
                    <div class="histogram-advanced-settings">
                        <div class="histogram-settings-title">
                            Chart settings
                        </div>
                        <div class="histogram-settings-grid">
                            <label class="histogram-setting">
                                <span class="setting-label">Time window</span>
                                <select v-model.number="histogramWindowSec">
                                    <option :value="30">Last 30 seconds</option>
                                    <option :value="60">Last 1 minute</option>
                                    <option :value="300">Last 5 minutes</option>
                                    <option :value="900">Last 15 minutes</option>
                                </select>
                            </label>
                            <label class="histogram-setting">
                                <span class="setting-label">Resolution</span>
                                <select v-model.number="histogramMaxPoints">
                                    <option :value="40">Coarse (up to 40 pts)</option>
                                    <option :value="80">Medium (up to 80 pts)</option>
                                    <option :value="160">Fine (up to 160 pts)</option>
                                </select>
                            </label>
                            <div class="histogram-setting hint">
                                History is kept only in this browser tab and is lost on refresh.
                            </div>
                        </div>
                    </div>
                </div>
            </transition>

            <!-- WATTS LINE CHART (visible in both basic & advanced views) -->
            <div class="histogram-panel">
                <div class="histogram-header">
                    <div class="histogram-title">Watts History</div>
                    <div class="histogram-current">
                        <template v-if="latest">
                            Currently: {{ latest.watts.toFixed(2) }} W
                        </template>
                        <template v-else>
                            —
                        </template>
                    </div>
                </div>

                <div v-if="!chartHasData" class="histogram-empty">
                    Waiting for enough samples to build a chart…
                </div>

                <div v-else class="histogram-chart-container">
                    <!-- Chart.js line chart -->
                    <Line
                        class="histogram-chart"
                        :data="chartData"
                        :options="chartOptions"
                    />
                </div>

                <!-- Bottom-right: window + low/high -->
                <div class="histogram-subtitle">
                    {{ histogramWindowLabel }}
                    <span v-if="chartHasData">
                        • Low ~ {{ chartMinDisplay.toFixed(1) }} W
                        • High ~ {{ chartMaxDisplay.toFixed(1) }} W
                    </span>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMirror } from '@/stores/mirror'

/* Chart.js / vue-chartjs setup */
import 'chartjs-adapter-luxon'
import { Line } from 'vue-chartjs'
import {
    Chart as ChartJS,
    LineElement,
    PointElement,
    LinearScale,
    CategoryScale,
    Tooltip,
    Legend,
    type ChartOptions,
    type ChartData
} from 'chart.js'

ChartJS.register(LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend)

/**
 * Pane context — same pattern as logs pane.
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

const props = defineProps<{ pane?: PaneInfo }>()

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

/** Fixed readable text for panel areas (dark backgrounds) */
const panelFg = '#e6e6e6'

/* -------------------------------------------------------------------------- */
/*  Power meter state via WS mirror                                           */
/* -------------------------------------------------------------------------- */

type PowerMeterPhase = 'disconnected' | 'connecting' | 'streaming' | 'error'

type PowerSample = {
    ts: string
    watts: number
    volts: number
    amps: number
}

type PowerMeterSnapshot = {
    phase: PowerMeterPhase
    message?: string
    stats: {
        totalSamples: number
        bytesReceived: number
        lastSampleAt: number | null
        lastErrorAt: number | null
    }
    lastSample: PowerSample | null
}

type PowerMeterStateView = {
    phase: PowerMeterPhase
    message?: string | null
}

const mirror = useMirror()

// Safe fallback in case snapshot hasn’t arrived yet
const initialPowerMeter: PowerMeterSnapshot = {
    phase: 'connecting',
    message: 'Waiting for power meter…',
    stats: {
        totalSamples: 0,
        bytesReceived: 0,
        lastSampleAt: null,
        lastErrorAt: null
    },
    lastSample: null
}

const powerMeter = computed<PowerMeterSnapshot>(() => {
    const root = mirror.data as any
    const slice = root?.powerMeter as PowerMeterSnapshot | undefined
    return slice ?? initialPowerMeter
})

const state = computed<PowerMeterStateView>(() => ({
    phase: powerMeter.value.phase,
    message: powerMeter.value.message ?? null
}))

const latest = computed<PowerSample | null>(() => powerMeter.value.lastSample)

/* -------------------------------------------------------------------------- */
/*  Status label                                                              */
/* -------------------------------------------------------------------------- */

const statusLabel = computed(() => {
    switch (state.value.phase) {
        case 'streaming':
            return 'Streaming'
        case 'connecting':
            return 'Connecting…'
        case 'disconnected':
            return 'Disconnected'
        case 'error':
            return 'Error'
        default:
            return 'Unknown'
    }
})

/* -------------------------------------------------------------------------- */
/*  UI Recorder (client-side aggregation)                                     */
/* -------------------------------------------------------------------------- */

type UiRecState = 'idle' | 'recording' | 'paused'

const recState = ref<UiRecState>('idle')
const recStateLabel = computed(() => {
    switch (recState.value) {
        case 'idle':
            return 'Idle'
        case 'recording':
            return 'Recording'
        case 'paused':
            return 'Paused'
    }
})

const canRecord = computed(() => state.value.phase === 'streaming')

/**
 * Aggregation fields.
 */
const sampleCount = ref(0)

// sums
const sumWatts = ref(0)
const sumVolts = ref(0)
const sumAmps = ref(0)

// min/max
const minWatts = ref<number | null>(null)
const maxWatts = ref<number | null>(null)
const minVolts = ref<number | null>(null)
const maxVolts = ref<number | null>(null)
const minAmps = ref<number | null>(null)
const maxAmps = ref<number | null>(null)

// energy approximation (watt-seconds)
const wattSecondsSum = ref(0)
const lastSampleTs = ref<number | null>(null)

const avgWatts = computed(() =>
    sampleCount.value > 0 ? sumWatts.value / sampleCount.value : null
)
const avgVolts = computed(() =>
    sampleCount.value > 0 ? sumVolts.value / sampleCount.value : null
)
const avgAmps = computed(() =>
    sampleCount.value > 0 ? sumAmps.value / sampleCount.value : null
)
const wattHoursApprox = computed(() =>
    wattSecondsSum.value > 0 ? wattSecondsSum.value / 3600 : 0
)

/** Reset all aggregation state. */
function resetRecorder() {
    sampleCount.value = 0
    sumWatts.value = 0
    sumVolts.value = 0
    sumAmps.value = 0
    minWatts.value = null
    maxWatts.value = null
    minVolts.value = null
    maxVolts.value = null
    minAmps.value = null
    maxAmps.value = null
    wattSecondsSum.value = 0
    lastSampleTs.value = null
}

function startRecording() {
    resetRecorder()
    if (latest.value) {
        // Seed with current sample
        addSampleToRecorder(latest.value)
    }
    recState.value = 'recording'
}

function pauseRecording() {
    recState.value = 'paused'
}

function resumeRecording() {
    recState.value = 'recording'
}

function stopRecording() {
    resetRecorder()
    recState.value = 'idle'
}

/**
 * Add a sample into the recorder.
 */
function addSampleToRecorder(sample: PowerSample) {
    const nowTs = Date.parse(sample.ts) || Date.now()

    if (lastSampleTs.value != null) {
        const dtSec = Math.max(0, (nowTs - lastSampleTs.value) / 1000)
        if (dtSec > 0 && dtSec < 10_000) {
            wattSecondsSum.value += sample.watts * dtSec
        }
    }
    lastSampleTs.value = nowTs

    sampleCount.value += 1
    sumWatts.value += sample.watts
    sumVolts.value += sample.volts
    sumAmps.value += sample.amps

    minWatts.value = minWatts.value == null ? sample.watts : Math.min(minWatts.value, sample.watts)
    maxWatts.value = maxWatts.value == null ? sample.watts : Math.max(maxWatts.value, sample.watts)

    minVolts.value = minVolts.value == null ? sample.volts : Math.min(minVolts.value, sample.volts)
    maxVolts.value = maxVolts.value == null ? sample.volts : Math.max(maxVolts.value, sample.volts)

    minAmps.value = minAmps.value == null ? sample.amps : Math.min(minAmps.value, sample.amps)
    maxAmps.value = maxAmps.value == null ? sample.amps : Math.max(maxAmps.value, sample.amps)
}

/* -------------------------------------------------------------------------- */
/*  Watts history (client-side only)                                          */
/* -------------------------------------------------------------------------- */

type WattsHistorySample = {
    t: number // epoch ms
    watts: number
}

// Maximum history window we ever care about (seconds)
const HIST_MAX_WINDOW_SEC = 15 * 60 // 15 minutes

const wattsHistory = ref<WattsHistorySample[]>([])

// User-adjustable x-axis window (seconds). Default: 300s.
const histogramWindowSec = ref(300)

// User-adjustable max # of points for the line (downsampling)
const histogramMaxPoints = ref(80)

// Helper: push latest watts sample into history, pruning old entries.
function addSampleToHistory(sample: PowerSample) {
    const t = Date.parse(sample.ts) || Date.now()
    const cutoff = t - HIST_MAX_WINDOW_SEC * 1000

    wattsHistory.value.push({ t, watts: sample.watts })

    // Prune anything older than our maximum window
    const history = wattsHistory.value
    if (history.length > 0) {
        let firstIdx = 0
        const len = history.length

        while (firstIdx < len) {
            const entry = history[firstIdx]
            if (!entry || entry.t >= cutoff) break
            firstIdx++
        }

        if (firstIdx > 0) {
            history.splice(0, firstIdx)
        }
    }
}

const histogramWindowLabel = computed(() => {
    const sec = histogramWindowSec.value
    if (sec < 60) return `Last ${sec} seconds`
    const minutes = Math.round(sec / 60)
    return `Last ${minutes} minute${minutes === 1 ? '' : 's'}`
})

/* -------------------------------------------------------------------------- */
/*  Line chart data for Chart.js                                              */
/* -------------------------------------------------------------------------- */

type ChartPoint = {
    x: number   // seconds into the past (negative)
    watts: number
}

// Downsampled points in the current window
const chartPointsRaw = computed<ChartPoint[]>(() => {
    const now = Date.now()
    const windowMs = histogramWindowSec.value * 1000
    if (windowMs <= 0) return []

    const from = now - windowMs
    const samples = wattsHistory.value.filter(s => s.t >= from && s.t <= now)
    if (samples.length === 0) return []

    const maxPoints = Math.max(10, histogramMaxPoints.value || 80)
    const toPoint = (s: WattsHistorySample): ChartPoint => ({
        x: (s.t - now) / 1000, // seconds ago (negative)
        watts: s.watts,
    })

    if (samples.length <= maxPoints) {
        return samples.map(toPoint)
    }

    const step = Math.ceil(samples.length / maxPoints)
    const result: ChartPoint[] = []
    for (let i = 0; i < samples.length; i += step) {
        const s = samples[i]
        if (!s) continue
        result.push(toPoint(s))
    }
    return result
})

const chartHasData = computed(() => chartPointsRaw.value.length > 1)

const chartMaxWatts = computed(() => {
    if (!chartPointsRaw.value.length) return 0
    return chartPointsRaw.value.reduce(
        (max, p) => (p.watts > max ? p.watts : max),
        0
    )
})

const chartMinDisplay = computed(() => {
    const pts = chartPointsRaw.value
    if (pts.length === 0) return 0

    let min: number | null = null

    for (const p of pts) {
        if (!p) continue
        if (min === null || p.watts < min) {
            min = p.watts
        }
    }

    return min ?? 0
})

const chartMaxDisplay = computed(() => chartMaxWatts.value)

function niceCeil(value: number): number {
    if (value <= 0) return 1
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)))
    const normalized = value / magnitude
    let niceNorm: number
    if (normalized <= 1) niceNorm = 1
    else if (normalized <= 2) niceNorm = 2
    else if (normalized <= 5) niceNorm = 5
    else niceNorm = 10
    return niceNorm * magnitude
}

const chartData = computed<ChartData<'line'>>(() => {
    const pts = chartPointsRaw.value

    return {
        labels: [],
        datasets: [
            {
                label: 'Watts',
                // NOTE: Chart.js will read x/y directly because we turn off parsing in options
                data: pts.map(p => ({
                    x: p.x,
                    y: p.watts,
                })),
                fill: false,
                borderColor: '#ef4444',
                backgroundColor: '#ef4444',
                tension: 0.15,
                pointRadius: 0,
                pointHitRadius: 6,
                borderWidth: 1.5,
            },
        ],
    }
})

const chartOptions = computed<ChartOptions<'line'>>(() => {
    const max = chartMaxWatts.value
    const suggestedMax = max > 0 ? niceCeil(max) : undefined
    const windowSec = histogramWindowSec.value

    return {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,

        // 🔇 Disable “grow from zero” animation on each update
        animation: {
            duration: 0,
        },
        transitions: {
            active: {
                animation: {
                    duration: 0,
                },
            },
            show: {
                animations: {
                    x: { duration: 0 },
                    y: { duration: 0 },
                },
            },
            hide: {
                animations: {
                    x: { duration: 0 },
                    y: { duration: 0 },
                },
            },
        },

        plugins: {
            legend: { display: false },
            tooltip: {
                intersect: false,
                mode: 'index',
                callbacks: {
                    label(context: any) {
                        const v = context.parsed.y
                        return `${v.toFixed(2)} W`
                    },
                },
            },
        },
        scales: {
            x: {
                type: 'linear',
                min: -windowSec,
                max: 0,
                ticks: {
                    color: '#6b7280',
                    maxRotation: 0,
                    autoSkip: true,
                    stepSize: windowSec / 6,
                    callback(value: any) {
                        const v =
                            typeof value === 'string' ? Number(value) : (value as number)

                        if (Math.abs(v) < 0.0001) return 'now'

                        const totalSeconds = Math.abs(Math.round(v))
                        const minutes = Math.floor(totalSeconds / 60)
                        const seconds = totalSeconds % 60

                        return `${minutes}:${seconds.toString().padStart(2, '0')}`
                    },
                },
                grid: {
                    color: 'rgba(229, 231, 235, 0.7)',
                },
            },
            y: {
                beginAtZero: true,
                suggestedMax,
                ticks: {
                    color: '#6b7280',
                    callback(value: any) {
                        return `${value} W`
                    },
                },
                grid: {
                    color: 'rgba(229, 231, 235, 0.7)',
                },
            },
        },
        elements: {
            line: {
                cubicInterpolationMode: 'default',
                tension: 0.15,
                borderWidth: 1.5,
            },
        },
    }
})

/**
 * Whenever `latest` changes:
 *  - Always add to watts history (for chart).
 *  - If recording, also fold into stats.
 */
watch(
    () => latest.value,
    (val) => {
        if (!val) return

        addSampleToHistory(val)

        if (recState.value !== 'recording') return
        addSampleToRecorder(val)
    }
)

/* -------------------------------------------------------------------------- */
/*  Advanced view toggle                                                      */
/* -------------------------------------------------------------------------- */

const showAdvanced = ref(false)
</script>

<style scoped>
.pm-pane {
    --pane-fg: #111;
    --panel-fg: #e6e6e6;

    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: 100%;
    width: 100%;
    color: var(--pane-fg);
}

/* Gear button (hover-only visibility) */
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
    transition: opacity 120ms ease, background 120ms ease, border-color 120ms ease,
        transform 60ms ease;
    z-index: 2;
}
.pm-pane:hover .gear-btn {
    opacity: 1;
}
.gear-btn:hover {
    background: #1a1a1a;
    transform: translateY(-1px);
}

/* Slide-fade transition for advanced section */
.slide-fade-enter-active,
.slide-fade-leave-active {
    transition: opacity 180ms ease, transform 180ms ease;
}
.slide-fade-enter-from,
.slide-fade-leave-to {
    opacity: 0;
    transform: translateY(-6px);
}

/* Main panel */
.panel {
    background: #0b0d12;
    border: 1px solid #1f2933;
    border-radius: 8px;
    padding: 8px;
    color: var(--panel-fg);
    display: flex;
    flex-direction: column;
    min-height: 0;
    gap: 8px;
}

/* When advanced view is open, allow vertical scrolling */
.panel--scrollable {
    overflow-y: auto;
}

/* Panel header */
.panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
    font-size: 0.8rem;
}

.panel-title-group {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

/* Softer, smaller title */
.panel-title {
    font-weight: 500;
    font-size: 0.75rem;
}

/* Status badge */
.status-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid #374151;
    background: #0b0d12;
    font-size: 0.75rem;
    color: var(--panel-fg);
}

.status-badge .dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: #9ca3af;
}

/* Phase-specific colors */
.status-badge[data-phase='streaming'] {
    border-color: #22c55e;
    background: #022c22;
}
.status-badge[data-phase='streaming'] .dot {
    background: #22c55e;
}
.status-badge[data-phase='connecting'] {
    border-color: #facc15;
    background: #3b2900;
}
.status-badge[data-phase='connecting'] .dot {
    background: #facc15;
}
.status-badge[data-phase='disconnected'] {
    border-color: #4b5563;
    background: #020617;
}
.status-badge[data-phase='disconnected'] .dot {
    background: #6b7280;
}
.status-badge[data-phase='error'] {
    border-color: #ef4444;
    background: #450a0a;
}
.status-badge[data-phase='error'] .dot {
    background: #ef4444;
}

/* Advanced section */
.advanced-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 2px;
}

/* Record controls */
.pm-controls {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
}

.btn {
    padding: 0 12px;
    border-radius: 6px;
    border: 1px solid #333;
    background: #111;
    color: var(--panel-fg);
    cursor: pointer;
    height: 28px;
    line-height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
    font-size: 0.8rem;
}
.btn.primary {
    background: #1f2937;
    border-color: #374151;
}
.btn.danger {
    border-color: #ef4444;
    color: #fecaca;
}
.btn:hover {
    background: #1a1a1a;
}

.rec-meta {
    font-size: 0.8rem;
    opacity: 0.9;
}
.rec-meta.dim {
    opacity: 0.6;
}

/* Stats panel */
.stats-panel {
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI',
        sans-serif;
}

.stats-grid {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.8rem;
}
.stats-grid[data-empty='true'] {
    justify-content: center;
}

.stats-empty {
    text-align: center;
    opacity: 0.7;
}

/* Stats table layout */
.stats-table {
    display: grid;
    gap: 4px;
}

.stats-header-row,
.stats-body-row {
    display: grid;
    grid-template-columns: 70px repeat(4, minmax(0, 1fr));
    gap: 4px;
    align-items: center;
}

.stats-header-cell {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.7;
}

.label-cell {
    text-align: left;
}

.stats-row-label {
    opacity: 0.8;
    font-weight: 500;
}

.stats-cell {
    font-variant-numeric: tabular-nums;
    font-size: 0.8rem;
    padding: 2px 6px;
    border-radius: 999px;
    border: 1px solid #374151;
    background: #020617;
    display: inline-flex;
    align-items: center;
}

/* Energy line */
.energy-row {
    margin-top: 6px;
    display: flex;
    justify-content: flex-start;
    gap: 8px;
    align-items: baseline;
}

.energy-label {
    opacity: 0.75;
}

.energy-value {
    font-variant-numeric: tabular-nums;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid #374151;
    background: #020617;
}

/* Chart panel */
.histogram-panel {
    margin-top: 6px;
    padding: 8px;
    border-radius: 6px;
    border: 1px dashed #d1d5db;
    background: #ffffff;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI',
        sans-serif;
    color: #111827;
}

.histogram-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    font-size: 0.78rem;
}

.histogram-title {
    font-weight: 500;
}

/* Simple inline current readings (top-right) */
.histogram-current {
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    opacity: 0.85;
}

/* Subtitle at the bottom-right under the chart/x-axis */
.histogram-subtitle {
    opacity: 0.7;
    font-size: 0.75rem;
    text-align: right;
    align-self: flex-end;
    margin-top: 4px;
}

.histogram-empty {
    font-size: 0.78rem;
    opacity: 0.7;
    text-align: center;
    padding: 12px 4px;
}

/* Chart.js canvas wrapper */
.histogram-chart-container {
    width: 100%;
    height: 120px;
}

.histogram-chart {
    width: 100%;
    height: 100%;
}

/* Chart advanced settings (advanced view only) */
.histogram-advanced-settings {
    margin-top: 4px;
    padding: 8px;
    border-radius: 6px;
    border: 1px solid #1f2937;
    background: #020617;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.78rem;
    color: #e5e7eb;
}

.histogram-settings-title {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.7;
}

.histogram-settings-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.histogram-setting {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.histogram-setting.hint {
    opacity: 0.7;
    max-width: 260px;
}

.setting-label {
    opacity: 0.8;
}

.histogram-setting select {
    min-width: 140px;
    height: 26px;
    border-radius: 4px;
    border: 1px solid #374151;
    background: #020617;
    color: #e5e7eb;
    font-size: 0.78rem;
}

/* Responsive: stack text if narrow */
@media (max-width: 720px) {
    .stats-header-row,
    .stats-body-row {
        grid-template-columns: 60px repeat(4, minmax(0, 1fr));
    }

    .histogram-settings-grid {
        flex-direction: column;
        align-items: flex-start;
    }

    .histogram-header {
        flex-direction: column;
        align-items: flex-start;
    }

    .histogram-subtitle {
        text-align: left;
        align-self: flex-start;
    }
}
</style>