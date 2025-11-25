<!-- apps/web/src/panes/SerialPrinterPane.vue -->
<template>
    <div class="sp-pane" :style="{ '--pane-fg': paneFg, '--panel-fg': panelFg }">
        <!-- Hover gear button could be used later for options (page size, font, etc.) -->
        <button
            class="gear-btn"
            :aria-expanded="showOptions ? 'true' : 'false'"
            aria-controls="sp-options-panel"
            title="Show printer options"
            @click="showOptions = !showOptions"
        >
            ⚙️
        </button>

        <!-- Main panel (scroll container for "paper") -->
        <div class="panel">
            <!-- Header: title + status -->
            <div class="panel-head">
                <div class="panel-title-group">
                    <span class="panel-title">Serial Printer Output</span>

                    <!-- Meta row: jobs, bytes, and streaming indicator -->
                    <div class="panel-meta">
                        <span class="meta-item">
                            Jobs:
                            <span class="meta-value">{{ totalJobsFormatted }}</span>
                        </span>
                        <span class="meta-sep">·</span>
                        <span class="meta-item">
                            Bytes:
                            <span class="meta-value">{{ bytesReceivedFormatted }}</span>
                        </span>
                        <span
                            v-if="isStreaming"
                            class="meta-item meta-item--accent"
                        >
                            Streaming…
                        </span>
                    </div>
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

            <!-- Options panel (minimal for now) -->
            <transition name="slide-fade">
                <div
                    v-if="showOptions"
                    id="sp-options-panel"
                    class="options-panel"
                >
                    <div class="options-row">
                        <span class="options-label">Max live characters</span>
                        <span class="options-value">
                            {{ maxLiveChars }}
                        </span>
                        <span class="options-hint">
                            (configured server-side; trims from the top)
                        </span>
                    </div>
                    <div class="options-row">
                        <span class="options-label">Recent jobs tracked</span>
                        <span class="options-value">
                            {{ printer.maxRecentJobs }}
                        </span>
                    </div>
                    <div class="options-row">
                        <span class="options-label">Typing interval</span>
                        <span class="options-value">
                            {{ typingIntervalMs }} ms
                        </span>
                        <span class="options-hint">
                            (VITE_SERIAL_PRINTER_TYPING_INTERVAL_MS)
                        </span>
                    </div>
                    <div class="options-row">
                        <span class="options-label">Chars per tick</span>
                        <span class="options-value">
                            {{ charsPerTick }}
                        </span>
                        <span class="options-hint">
                            (VITE_SERIAL_PRINTER_CHARS_PER_TICK)
                        </span>
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

type SerialPrinterSnapshotView = {
    phase: SerialPrinterPhase
    message?: string
    stats: SerialPrinterStatsView
    currentJob: SerialPrinterCurrentJob | null
    lastJob: SerialPrinterJobSummary | null
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
    recentJobs: [],
    maxRecentJobs: 20,
}

const printer = computed<SerialPrinterSnapshotView>(() => {
    const root = mirror.data as any
    const slice = root?.serialPrinter as SerialPrinterSnapshotView | undefined
    return slice ?? initialPrinter
})

/* -------------------------------------------------------------------------- */
/*  Status + stats + streaming indicators                                     */
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

const totalJobsFormatted = computed(() =>
    new Intl.NumberFormat().format(printer.value.stats.totalJobs)
)
const bytesReceivedFormatted = computed(() =>
    new Intl.NumberFormat().format(printer.value.stats.bytesReceived)
)

/**
 * "Streaming" is a UI concept: as long as we're animating or have
 * a current job in the 'receiving' phase, show the pill in the meta line.
 */
const isStreaming = computed(() => {
    return (
        !!liveText.value ||
        !!pending.value ||
        printer.value.phase === 'receiving'
    )
})

/* -------------------------------------------------------------------------- */
/*  Tape auto-scroll behavior                                                 */
/* -------------------------------------------------------------------------- */

const paperRef = ref<HTMLElement | null>(null)
const autoScrollEnabled = ref(true)
/**
 * This is just a UI hint; the actual trim is enforced server-side in the
 * adapter (so UI and state are consistent).
 */
const maxLiveChars = 8000

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
 * completedJobs: local-only store of full job texts, in order.
 * This is the historical "tape" above the current job.
 */
type CompletedJobView = {
    id: number
    text: string
}
const completedJobs = ref<CompletedJobView[]>([])

/* Typing speed configuration (env-driven) */
const DEFAULT_TYPING_INTERVAL_MS = 30
const DEFAULT_CHARS_PER_TICK = 3

const typingIntervalMs = (() => {
    const raw = import.meta.env.VITE_SERIAL_PRINTER_TYPING_INTERVAL_MS
    const n = raw != null ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TYPING_INTERVAL_MS
})()

const charsPerTick = (() => {
    const raw = import.meta.env.VITE_SERIAL_PRINTER_CHARS_PER_TICK
    const n = raw != null ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CHARS_PER_TICK
})()

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

        const chunk = pending.value.slice(0, charsPerTick)
        pending.value = pending.value.slice(charsPerTick)

        // Append new characters
        liveText.value += chunk
        // NOTE: no client-side trimming; backend remains source of truth.
    }, typingIntervalMs) as unknown as number
}

function pushCompletedJob(id: number, text: string) {
    if (!text) return
    completedJobs.value.push({ id, text })
    const cap = printer.value.maxRecentJobs || 20
    if (completedJobs.value.length > cap) {
        completedJobs.value.splice(0, completedJobs.value.length - cap)
    }
}

function finalizeFinishedJobIfReady() {
    if (finishingJobId.value == null) return
    if (pending.value.length > 0) return

    // All pending characters have been rendered; move the tape into history.
    pushCompletedJob(finishingJobId.value, liveText.value)

    finishingJobId.value = null
    currentJobId.value = null
    liveText.value = ''
    displayedLength.value = 0
    // pending is already empty, but make it explicit:
    pending.value = ''
    stopTypingTimer()
}

/**
 * Watch job identity:
 *  - When a new job starts: if a previous job was still streaming, flush ALL
 *    of its text (live + pending) into completedJobs so we never lose tape.
 *  - When a job finishes: mark it as "finishing" and let the streamer drain
 *    any remaining pending characters before finalizing.
 */
watch(
    () => printer.value.currentJob,
    (job, prevJob) => {
        // New job started (id changed)
        if (job && job.id !== currentJobId.value) {
            const previousId = currentJobId.value

            if (previousId != null) {
                // If a previous job was in "finishing" state, finalize what we have.
                if (finishingJobId.value === previousId) {
                    // Flush any pending chars into liveText before finalizing.
                    if (pending.value.length) {
                        liveText.value += pending.value
                        pending.value = ''
                    }
                    pushCompletedJob(previousId, liveText.value)
                    finishingJobId.value = null
                } else {
                    // Previous job never reached "finished" state on the backend,
                    // but we're starting a new job anyway. Treat the current tape
                    // (live + pending) as a completed job so we don't lose it.
                    if (pending.value.length) {
                        liveText.value += pending.value
                        pending.value = ''
                    }
                    pushCompletedJob(previousId, liveText.value)
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
            // We now rely on finalizeFinishedJobIfReady (driven by pending watcher)
            // to move this job into completedJobs once all pending chars are rendered.
        }
    }
)

/**
 * Watch the server-driven currentJob text.
 * We just look at length deltas and append; if the server ever *shrinks*
 * the text (e.g. it trims from the top), we hard-sync to its version
 * without doing a clear/retype cycle.
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

        // If server text is shorter than what we think we've shown, resync
        // directly to the server's view (no typewriter, no flicker).
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
 * completedJobs.
 */
watch(
    () => pending.value,
    () => {
        finalizeFinishedJobIfReady()
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
/*  Options panel toggle                                                      */
/* -------------------------------------------------------------------------- */

const showOptions = ref(false)
</script>

<style scoped>
.sp-pane {
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
.sp-pane:hover .gear-btn {
    opacity: 1;
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
    min-height: 0;
    gap: 8px;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI',
        sans-serif;
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

/* Meta row under title */
.panel-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px;
    font-size: 0.72rem;
    color: #9ca3af;
}

.meta-item {
    display: inline-flex;
    align-items: baseline;
    gap: 2px;
}

.meta-value {
    font-variant-numeric: tabular-nums;
    color: #e5e7eb;
}

.meta-sep {
    opacity: 0.5;
}

.meta-item--accent {
    margin-left: 4px;
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid #16a34a;
    color: #bbf7d0;
    background: rgba(22, 163, 74, 0.12);
    font-size: 0.7rem;
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

/* Tape viewport */
.tape-viewport {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px 0;
    position: relative;
}

/* Tape surface */
.tape {
    position: relative;
    margin: 0 auto;
    max-width: 100%;
    background: radial-gradient(circle at top left, #fefce8 0, #fefce8 40%, #f9fafb 100%);
    border-radius: 6px;
    padding: 8px 10px 16px 10px;
    box-shadow:
        0 0 0 1px rgba(15, 23, 42, 0.4),
        0 10px 24px rgba(15, 23, 42, 0.7);
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

/* Tape footer deep shadow */
.tape-footer {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: -8px;
    height: 12px;
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
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px dashed #374151;
    background: #020617;
    font-size: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.options-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
}

.options-label {
    font-weight: 500;
}

.options-value {
    font-variant-numeric: tabular-nums;
}

.options-hint {
    opacity: 0.7;
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