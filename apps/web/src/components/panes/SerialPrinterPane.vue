<!-- apps/web/src/panes/SerialPrinterPane.vue -->
<template>
    <div class="sp-pane" :style="{ '--pane-fg': paneFg, '--panel-fg': panelFg }">
        <!-- Hotspot region: only hovering here shows the options button -->
        <div class="sp-options-hotspot">
            <button
                class="gear-btn"
                :aria-expanded="showOptions ? 'true' : 'false'"
                aria-controls="sp-options-panel"
                title="Show printer options"
                @click="showOptions = !showOptions"
            >
                ⚙️
            </button>
        </div>

        <!-- Main panel (scroll container for "paper") -->
        <div class="panel">
            <!-- Header: title + status -->
            <div class="panel-head">
                <div class="panel-title-group">
                    <span class="panel-title">Serial Printer Output</span>
                </div>

                <!-- Status badge on the right side -->
                <span
                    class="status-badge"
                    :data-phase="printer.phase"
                    :data-reconnecting="isReconnecting ? 'true' : 'false'"
                >
                    <span class="dot"></span>
                    <span class="label">{{ statusLabel }}</span>
                </span>
            </div>

            <!-- Tape viewport -->
            <div
                ref="paperRef"
                class="tape-viewport"
                @scroll="onScroll"
            >
                <!-- Simulated continuous tape -->
                <div class="tape">
                    <!-- Subtle perforation at the top -->
                    <div class="tape-perf"></div>

                    <!-- COMPLETED JOBS: full text, oldest first, with cut line after each -->
                    <div
                        v-for="job in completedJobs"
                        :key="job.id"
                        class="job-block"
                    >
                        <pre class="job-body">
{{ job.text }}
                        </pre>
                        <div class="job-divider"></div>
                    </div>

                    <!-- CURRENT JOB: streaming text at the bottom of the tape -->
                    <div
                        v-if="liveText"
                        class="job-block current-job"
                    >
                        <pre class="job-body job-body--live">
{{ liveText || ' ' }}
                        </pre>
                    </div>

                    <!-- Empty state if nothing has ever printed -->
                    <div
                        v-if="!liveText && completedJobs.length === 0"
                        class="empty-state"
                    >
                        <p>No printer output yet.</p>
                        <p class="hint">
                            Send a test page from Windows 98 to see the tape come to life.
                        </p>
                    </div>

                    <!-- Tape footer shadow -->
                    <div class="tape-footer"></div>
                </div>
            </div>

            <!-- Options panel: live typing speed controls -->
            <transition name="slide-fade">
                <div
                    v-if="showOptions"
                    id="sp-options-panel"
                    class="options-panel"
                >
                    <div class="options-header">
                        <span class="options-title">Typing speed</span>
                        <button
                            class="options-reset-btn"
                            type="button"
                            @click="resetSpeed"
                        >
                            Reset to defaults
                        </button>
                    </div>

                    <div class="options-row">
                        <div class="options-row-main">
                            <span class="options-label">Update interval</span>
                            <span class="options-value">
                                {{ currentIntervalMs }} ms
                            </span>
                        </div>
                        <input
                            class="options-slider"
                            type="range"
                            min="5"
                            max="80"
                            step="1"
                            v-model.number="currentIntervalMs"
                        />
                        <div class="options-hint">
                            Lower = more frequent, smoother updates · Higher = slower ticks
                        </div>
                    </div>

                    <div class="options-row">
                        <div class="options-row-main">
                            <span class="options-label">Characters per tick</span>
                            <span class="options-value">
                                {{ currentCharsPerTick }}
                            </span>
                        </div>
                        <input
                            class="options-slider"
                            type="range"
                            min="1"
                            max="6"
                            step="1"
                            v-model.number="currentCharsPerTick"
                        />
                        <div class="options-hint">
                            Higher = faster but chunkier · Lower = slower but smoother
                        </div>
                    </div>

                    <!-- Server history info -->
                    <div class="options-row">
                        <div class="options-row-main">
                            <span class="options-label">Server history</span>
                            <span class="options-value">
                                {{ printer.historyLimit }} jobs
                            </span>
                        </div>
                        <div class="options-hint">
                            Number of completed jobs the server keeps for refresh / new clients
                            (SERIAL_PRINTER_HISTORY_LIMIT).
                        </div>
                    </div>
                </div>
            </transition>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useMirror } from '@/stores/mirror'

/**
 * Pane context — same pattern as logs / power meter panes.
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
/*  Serial printer state via WS mirror                                        */
/* -------------------------------------------------------------------------- */

type SerialPrinterPhase = 'disconnected' | 'connected' | 'queued' | 'error' | 'receiving'

type SerialPrinterStatsView = {
    totalJobs: number
    bytesReceived: number
    lastJobAt: number | null
    lastErrorAt: number | null
}

type SerialPrinterJobSummary = {
    id: number
    createdAt: number
    completedAt: number
    preview: string
}

type SerialPrinterCurrentJob = {
    id: number
    startedAt: number
    text: string
}

type SerialPrinterHistoryEntry = {
    id: number
    createdAt: number
    completedAt: number
    text: string
}

type SerialPrinterSnapshotView = {
    phase: SerialPrinterPhase
    message?: string
    stats: SerialPrinterStatsView
    currentJob: SerialPrinterCurrentJob | null
    lastJob: SerialPrinterJobSummary | null
    // Canonical full text for last completed job
    lastJobFullText: string | null
    // Full-text history, server-side bounded
    history: SerialPrinterHistoryEntry[]
    historyLimit: number
    // Summary list (existing)
    recentJobs: SerialPrinterJobSummary[]
    maxRecentJobs: number
}

const mirror = useMirror()

const initialPrinter: SerialPrinterSnapshotView = {
    phase: 'disconnected',
    message: 'Waiting for serial printer…',
    stats: {
        totalJobs: 0,
        bytesReceived: 0,
        lastJobAt: null,
        lastErrorAt: null,
    },
    currentJob: null,
    lastJob: null,
    lastJobFullText: null,
    history: [],
    historyLimit: 10,
    recentJobs: [],
    maxRecentJobs: 20,
}

const printer = computed<SerialPrinterSnapshotView>(() => {
    const root = mirror.data as any
    const slice = root?.serialPrinter as SerialPrinterSnapshotView | undefined
    return slice ?? initialPrinter
})

/* -------------------------------------------------------------------------- */
/*  Status / connection indicators                                            */
/* -------------------------------------------------------------------------- */

const isReconnecting = computed(() => {
    return printer.value.phase === 'disconnected' && printer.value.stats.lastErrorAt != null
})

/**
 * Status badge is now purely about connection/health, not "printing".
 */
const statusLabel = computed(() => {
    if (printer.value.phase === 'error') {
        return 'Error'
    }
    if (printer.value.phase === 'disconnected') {
        return isReconnecting.value ? 'Reconnecting…' : 'Disconnected'
    }
    // connected, queued, receiving are all simply "Connected" at the transport level
    return 'Connected'
})

/* -------------------------------------------------------------------------- */
/*  Tape auto-scroll behavior                                                 */
/* -------------------------------------------------------------------------- */

const paperRef = ref<HTMLElement | null>(null)
const autoScrollEnabled = ref(true)

function scrollToBottom() {
    const el = paperRef.value
    if (!el) return
    el.scrollTop = el.scrollHeight
}

function onScroll() {
    const el = paperRef.value
    if (!el) return

    const threshold = 32 // px from bottom considered "at bottom"
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight)
    autoScrollEnabled.value = distanceFromBottom <= threshold
}

/* -------------------------------------------------------------------------- */
/*  Continuous tape + typewriter streaming                                    */
/* -------------------------------------------------------------------------- */

/**
 * liveText: text currently being streamed for the active job (bottom of tape).
 * pending: chars waiting to be revealed with typewriter effect.
 * displayedLength: how many characters from the server we've already accounted for.
 * currentJobId: which job we’re currently animating.
 * finishingJobId: job that the backend says is complete, but whose pending
 *                 characters are still draining into the tape.
 */
const liveText = ref('')
const pending = ref('')
const displayedLength = ref(0)
const currentJobId = ref<number | null>(null)
const finishingJobId = ref<number | null>(null)

/**
 * completedJobs: local view of full job texts, in order.
 * Hydrated from server-side history and updated while streaming.
 */
type CompletedJobView = {
    id: number
    text: string
}
const completedJobs = ref<CompletedJobView[]>([])

/* Typing speed configuration (env-driven defaults, user-overridable) */
const DEFAULT_TYPING_INTERVAL_MS = 30
const DEFAULT_CHARS_PER_TICK = 3

const envTypingInterval = (() => {
    const raw = import.meta.env.VITE_SERIAL_PRINTER_TYPING_INTERVAL_MS
    const n = raw != null ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TYPING_INTERVAL_MS
})()

const envCharsPerTick = (() => {
    const raw = import.meta.env.VITE_SERIAL_PRINTER_CHARS_PER_TICK
    const n = raw != null ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CHARS_PER_TICK
})()

const currentIntervalMs = ref(envTypingInterval)
const currentCharsPerTick = ref(envCharsPerTick)

let typingTimer: number | null = null

function stopTypingTimer() {
    if (typingTimer !== null) {
        clearInterval(typingTimer)
        typingTimer = null
    }
}

function startTypingTimer() {
    if (typingTimer !== null) return
    typingTimer = window.setInterval(() => {
        if (!pending.value.length) {
            stopTypingTimer()
            return
        }

        const chars = Math.max(1, currentCharsPerTick.value || 1)
        const chunk = pending.value.slice(0, chars)
        pending.value = pending.value.slice(chars)

        // Append new characters
        liveText.value += chunk
        // NOTE: no client-side trimming; backend remains source of truth.
    }, Math.max(1, currentIntervalMs.value || 1)) as unknown as number
}

function pushCompletedJob(id: number, text: string) {
    if (!text) return
    completedJobs.value.push({ id, text })
    const cap = printer.value.historyLimit || printer.value.maxRecentJobs || 20
    if (completedJobs.value.length > cap) {
        completedJobs.value.splice(0, completedJobs.value.length - cap)
    }
}

/**
 * Use backend canonical text for a job if available, otherwise fall back
 * to whatever we streamed locally.
 */
function getCanonicalCompletedText(jobId: number, fallback: string): string {
    const last = printer.value.lastJob
    if (last && last.id === jobId && printer.value.lastJobFullText) {
        return printer.value.lastJobFullText
    }
    return fallback
}

function finalizeFinishedJobIfReady() {
    if (finishingJobId.value == null) return
    if (pending.value.length > 0) return

    const id = finishingJobId.value
    const historyEnabled = (printer.value.historyLimit || 0) > 0

    // Capture before clearing
    const fallback = liveText.value

    // Clear live state for this job, but keep displayedLength as-is so that
    // any late snapshots with the same full text don't get re-streamed.
    finishingJobId.value = null
    currentJobId.value = null
    liveText.value = ''
    pending.value = ''
    stopTypingTimer()

    // If we *don't* have server history, we must keep a local copy.
    if (!historyEnabled) {
        const text = getCanonicalCompletedText(id, fallback)
        pushCompletedJob(id, text)
    }
}

/**
 * Hydrate local completedJobs from server-side history whenever it changes.
 */
watch(
    () => printer.value.history,
    (history) => {
        if (!history) return
        completedJobs.value = history.map(h => ({
            id: h.id,
            text: h.text,
        }))
    },
    { immediate: true, deep: true }
)

/**
 * Watch job identity:
 *  - When a new job starts: if a previous job was still streaming, flush ALL
 *    of its text (live + pending) into completedJobs so we never lose tape,
 *    preferring backend canonical text when available.
 *  - When a job finishes: mark it as "finishing" and let the
 *    streamer drain remaining pending characters before finalizing.
 */
watch(
    () => printer.value.currentJob,
    (job, prevJob) => {
        const historyEnabled = (printer.value.historyLimit || 0) > 0

        // New job started (id changed)
        if (job && job.id !== currentJobId.value) {
            const previousId = currentJobId.value

            if (previousId != null) {
                // If a previous job was in "finishing" state, finalize what we have.
                if (finishingJobId.value === previousId) {
                    if (pending.value.length) {
                        liveText.value += pending.value
                        pending.value = ''
                    }

                    if (!historyEnabled) {
                        const text = getCanonicalCompletedText(previousId, liveText.value)
                        pushCompletedJob(previousId, text)
                    }

                    finishingJobId.value = null
                } else {
                    // Previous job never reached "finished" state on the backend,
                    // but we're starting a new job anyway. Treat the current tape
                    // (live + pending) as a completed job so we don't lose it.
                    if (pending.value.length) {
                        liveText.value += pending.value
                        pending.value = ''
                    }

                    if (!historyEnabled) {
                        const text = getCanonicalCompletedText(previousId, liveText.value)
                        pushCompletedJob(previousId, text)
                    }
                }
            }

            // Reset state for the new job.
            currentJobId.value = job.id
            liveText.value = ''
            pending.value = ''
            displayedLength.value = 0
            stopTypingTimer()
            return
        }

        // Job finished (went from something to null)
        if (!job && prevJob) {
            // Don't clear text yet; just remember which job is finishing.
            finishingJobId.value = prevJob.id
            // finalizeFinishedJobIfReady (driven by pending watcher)
            // will move this job into completedJobs once pending is empty
            // (or just clear live state if historyEnabled).
        }
    }
)

/**
 * Watch the server-driven currentJob text.
 */
watch(
    () => printer.value.currentJob?.text,
    (serverText) => {
        const job = printer.value.currentJob
        if (!job || serverText == null) {
            return
        }

        const full = serverText
        const fullLen = full.length

        // If server text is shorter than what we think we've shown, resync.
        if (fullLen < displayedLength.value) {
            liveText.value = full
            pending.value = ''
            displayedLength.value = fullLen
            stopTypingTimer()
            return
        }

        // Normal case: new tail appended.
        const delta = full.slice(displayedLength.value)
        if (!delta) {
            return
        }

        pending.value += delta
        displayedLength.value = fullLen
        startTypingTimer()
    }
)

/**
 * When pending changes and a job is marked as "finishing", check whether
 * we've drained all remaining characters; if so, finalize the job into
 * completedJobs (or just clear live state if historyEnabled).
 */
watch(
    () => pending.value,
    () => {
        finalizeFinishedJobIfReady()
    }
)

/**
 * When the user changes typing speed controls, restart the timer if needed
 * so the new values take effect during an in-flight job.
 */
watch(
    () => ({
        interval: currentIntervalMs.value,
        chars: currentCharsPerTick.value,
    }),
    () => {
        if (!pending.value.length) return
        if (typingTimer !== null) {
            stopTypingTimer()
            startTypingTimer()
        }
    }
)

/* -------------------------------------------------------------------------- */
/*  Auto-scroll watcher                                                       */
/* -------------------------------------------------------------------------- */

watch(
    () => ({
        live: liveText.value,
        completedCount: completedJobs.value.length,
        bytes: printer.value.stats.bytesReceived,
    }),
    () => {
        if (autoScrollEnabled.value) {
            requestAnimationFrame(scrollToBottom)
        }
    }
)

onMounted(() => {
    requestAnimationFrame(scrollToBottom)
})

onBeforeUnmount(() => {
    autoScrollEnabled.value = false
    stopTypingTimer()
    liveText.value = ''
    pending.value = ''
    displayedLength.value = 0
    currentJobId.value = null
    finishingJobId.value = null
    completedJobs.value = []
})

/* -------------------------------------------------------------------------- */
/*  Options panel toggle + reset                                              */
/* -------------------------------------------------------------------------- */

const showOptions = ref(false)

function resetSpeed() {
    currentIntervalMs.value = envTypingInterval
    currentCharsPerTick.value = envCharsPerTick
}
</script>

<style scoped>
.sp-pane {
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

/* Hotspot area for options button (top-right).
   Only hovering this region will reveal the button. */
.sp-options-hotspot {
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
    background: #111;
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

/* Only show button while hotspot is hovered */
.sp-options-hotspot:hover .gear-btn {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
}

.gear-btn:hover {
    background: #1a1a1a;
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

/* Main panel */
.panel {
    background: #020617;
    border: 1px solid #1f2933;
    border-radius: 8px;
    padding: 8px;
    color: var(--panel-fg);
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI',
        sans-serif;

    /* Fill the entire pane area */
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
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

.panel-title {
    font-weight: 500;
    font-size: 0.8rem;
}

/* Status badge */
.status-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid #374151;
    background: #020617;
    font-size: 0.75rem;
    color: var(--panel-fg);
}

.status-badge .dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: #9ca3af;
}

/* Phase-specific colors (aligned with Power Meter semantics) */
.status-badge[data-phase='receiving'] {
    border-color: #22c55e;
    background: #022c22;
}
.status-badge[data-phase='receiving'] .dot {
    background: #22c55e;
}
.status-badge[data-phase='connected'] {
    border-color: #22c55e;
    background: #022c22;
}
.status-badge[data-phase='connected'] .dot {
    background: #22c55e;
}

/* Optional: keep queued distinct (purple) */
.status-badge[data-phase='queued'] {
    border-color: #a855f7;
    background: #2b103f;
}
.status-badge[data-phase='queued'] .dot {
    background: #a855f7;
}

/* Disconnected baseline (no reconnect attempt yet) */
.status-badge[data-phase='disconnected'] {
    border-color: #4b5563;
    background: #020617;
}
.status-badge[data-phase='disconnected'] .dot {
    background: #6b7280;
}

/* Disconnected + reconnecting (yellow, like Power Meter "connecting") */
.status-badge[data-phase='disconnected'][data-reconnecting='true'] {
    border-color: #facc15;
    background: #3b2900;
}
.status-badge[data-phase='disconnected'][data-reconnecting='true'] .dot {
    background: #facc15;
}

/* Error state */
.status-badge[data-phase='error'] {
    border-color: #ef4444;
    background: #450a0a;
}
.status-badge[data-phase='error'] .dot {
    background: #ef4444;
}

/* Tape viewport: scrollable area, fills remaining panel space.
   Made a flex container with NO padding so child 100%/flex height matches it exactly. */
.tape-viewport {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    position: relative;

    display: flex;
    align-items: stretch;
}

/* Tape surface: flex child that stretches to fill viewport height in empty state.
   No min-height:100%; that plus viewport padding was causing the early scrollbar. */
.tape {
    position: relative;
    margin: 4px auto; /* replaces viewport padding */
    max-width: 100%;
    background: radial-gradient(circle at top left, #fefce8 0, #fefce8 40%, #f9fafb 100%);
    border-radius: 6px;
    padding: 8px 10px 16px 10px;
    box-shadow:
        0 0 0 1px rgba(15, 23, 42, 0.4),
        0 10px 24px rgba(15, 23, 42, 0.7);

    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
}

/* Perforation strip */
.tape-perf {
    position: relative;
    height: 8px;
    margin: -8px -10px 6px;
    background: repeating-linear-gradient(
        to right,
        rgba(15, 23, 42, 0.25),
        rgba(15, 23, 42, 0.25) 1px,
        transparent 1px,
        transparent 4px
    );
    mask-image: linear-gradient(to bottom, black, transparent);
}

/* Tape footer deep shadow (inside tape so it doesn't add scroll height) */
.tape-footer {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 0;
    height: 10px;
    background: radial-gradient(ellipse at center, rgba(0, 0, 0, 0.45), transparent 60%);
    opacity: 0.8;
    pointer-events: none;
}

/* Job blocks */
.job-block {
    margin-bottom: 8px;
}

.job-block.current-job {
    animation: pulse-border 1.4s ease-in-out infinite;
}

/* Job body text */
.job-body {
    margin: 0;
    padding: 4px 6px;
    border-radius: 4px;
    background: rgba(249, 250, 251, 0.9);
    color: #111827;
    font-family: 'SF Mono', ui-monospace, Menlo, Monaco, Consolas, 'Liberation Mono',
        'Courier New', monospace;
    font-size: 0.75rem;
    line-height: 1.3;
    white-space: pre-wrap;
    word-wrap: break-word;
    border: 1px solid rgba(209, 213, 219, 0.9);
}

.job-body--live {
    border-style: dashed;
    border-color: #16a34a;
}

/* Divider between jobs (cut line) */
.job-divider {
    margin-top: 4px;
    height: 1px;
    background: repeating-linear-gradient(
        to right,
        rgba(148, 163, 184, 0.6),
        rgba(148, 163, 184, 0.6) 4px,
        transparent 4px,
        transparent 8px
    );
    opacity: 0.8;
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

/* Options panel */
.options-panel {
    margin-top: 4px;
    padding: 6px 8px 8px;
    border-radius: 6px;
    border: 1px dashed #374151;
    background: #020617;
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
    gap: 4px;
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

.options-hint {
    opacity: 0.7;
    font-size: 0.7rem;
}

/* Subtle pulsing border for live job */
@keyframes pulse-border {
    0% {
        transform: translateY(0);
    }
    50% {
        transform: translateY(-0.5px);
    }
    100% {
        transform: translateY(0);
    }
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
}
</style>