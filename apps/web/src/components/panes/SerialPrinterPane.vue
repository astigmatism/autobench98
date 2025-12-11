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
                    :data-streaming="isStreaming ? 'true' : 'false'"
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

                    <!-- CONTINUOUS TAPE, SEGMENTED BY JOB -->
                    <div
                        v-for="(segment, index) in tapeSegments"
                        :key="segment.id"
                        class="job-block"
                        :class="{ 'current-job': isStreaming && segment.id === activeJobId }"
                    >
                        <pre class="job-body">
{{ segment.text || ' ' }}
                        </pre>
                        <!-- Visual “cut” between jobs -->
                        <div
                            v-if="index < tapeSegments.length - 1"
                            class="job-divider"
                        ></div>
                    </div>

                    <!-- Empty state if nothing has ever printed -->
                    <div
                        v-if="tapeSegments.length === 0"
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

                    <!-- Backlog speed multiplier -->
                    <div class="options-row">
                        <div class="options-row-main">
                            <span class="options-label">Backlog speed multiplier</span>
                            <span class="options-value">
                                ×{{ backlogSpeedFactor.toFixed(1) }}
                            </span>
                        </div>
                        <input
                            class="options-slider"
                            type="range"
                            min="1"
                            max="20"
                            step="0.5"
                            v-model.number="backlogSpeedFactor"
                        />
                        <div class="options-hint">
                            When new completed jobs arrive while older ones are still streaming,
                            this factor speeds up the backlog so the latest job becomes visible sooner.
                        </div>
                    </div>

                    <!-- Buffer size (rolling char cap) -->
                    <div class="options-row">
                        <div class="options-row-main">
                            <span class="options-label">Buffer size</span>
                            <span class="options-value">
                                {{ tapeMaxChars.toLocaleString() }} chars
                            </span>
                        </div>
                        <input
                            class="options-slider"
                            type="range"
                            min="1000"
                            max="100000"
                            step="500"
                            v-model.number="tapeMaxChars"
                        />
                        <div class="options-hint">
                            Maximum number of characters retained in the tape buffer.
                            Oldest text is trimmed automatically when this limit is exceeded
                            (while you are scrolled to the bottom).
                        </div>
                    </div>

                    <!-- Fast-forward toggle -->
                    <div class="options-row">
                        <div class="options-row-main">
                            <span class="options-label">Fast forward to latest</span>
                            <span class="options-value">
                                {{ fastForwardToLatest ? 'On' : 'Off' }}
                            </span>
                        </div>
                        <label class="options-hint">
                            <input
                                type="checkbox"
                                v-model="fastForwardToLatest"
                            />
                            When enabled, if older jobs are still streaming when a new job completes,
                            all backlog text is printed immediately and streaming focuses on the latest job.
                        </label>
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

type SerialPrinterCurrentJobView = {
    id: number
    startedAt: number
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
    currentJob: SerialPrinterCurrentJobView | null
    lastJob: SerialPrinterJobSummary | null
    lastJobFullText: string | null
    history: SerialPrinterHistoryEntry[]
    historyLimit: number
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
/*  Continuous tape + typewriter streaming (segmented by job)                */
/* -------------------------------------------------------------------------- */

/**
 * New behavior:
 *
 * - We maintain a single logical tape composed of ordered segments, one per job.
 * - Each segment is visually separated by a "cut" line (job-divider).
 * - Completed jobs from the backend are queued in jobQueue as full text.
 * - A typing timer drains characters from pendingText into the current segment.
 * - As the total character count across all segments grows, we trim old text
 *   from the front, dropping whole segments when they become empty.
 */

/* Tape segments currently visible in the component */
type TapeSegment = { id: number; text: string }
const tapeSegments = ref<TapeSegment[]>([])

/* Characters waiting to be streamed for the active job */
const pendingText = ref('')

/* FIFO queue of completed jobs awaiting streaming */
type QueuedJob = { id: number; text: string }
const jobQueue = ref<QueuedJob[]>([])

/* The job currently being streamed (for visual state) */
const activeJobId = ref<number | null>(null)

const isStreaming = computed(() => {
    return pendingText.value.length > 0 || jobQueue.value.length > 0
})

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

/* Rolling tape character cap (env-driven) */
const DEFAULT_TAPE_MAX_CHARS = 20000
const envTapeMaxChars = (() => {
    const raw = import.meta.env.VITE_SERIAL_PRINTER_MAX_CHARS
    const n = raw != null ? Number(raw) : NaN
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_TAPE_MAX_CHARS
    return Math.floor(n)
})()
const tapeMaxChars = ref(envTapeMaxChars)

/* Backlog speed multiplier (env-driven, default 10 here) */
const DEFAULT_BACKLOG_SPEED_FACTOR = 10
const envBacklogFactor = (() => {
    const raw = import.meta.env.VITE_SERIAL_PRINTER_BACKLOG_SPEED_FACTOR
    const n = raw != null ? Number(raw) : NaN
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_BACKLOG_SPEED_FACTOR
    return n
})()

/* Fast-forward-to-latest toggle (env-driven, default TRUE as requested) */
const DEFAULT_FAST_FORWARD_TO_LATEST = true
const envFastForwardToLatest = (() => {
    const raw = import.meta.env.VITE_SERIAL_PRINTER_FAST_FORWARD_TO_LATEST
    if (typeof raw === 'string') {
        const s = raw.trim().toLowerCase()
        if (s === 'true') return true
        if (s === 'false') return false
    }
    return DEFAULT_FAST_FORWARD_TO_LATEST
})()

const currentIntervalMs = ref(envTypingInterval)
const currentCharsPerTick = ref(envCharsPerTick)
const backlogSpeedFactor = ref(envBacklogFactor)
const fastForwardToLatest = ref(envFastForwardToLatest)

let typingTimer: number | null = null

function stopTypingTimer() {
    if (typingTimer !== null) {
        clearInterval(typingTimer)
        typingTimer = null
    }
}

/**
 * Compute total character count across all visible segments.
 */
function totalTapeChars(): number {
    return tapeSegments.value.reduce((sum, seg) => sum + seg.text.length, 0)
}

/**
 * Enforce the rolling character cap on the visible tape.
 * Keeps only the most recent tapeMaxChars characters across segments.
 * Oldest characters are removed first; empty segments are dropped.
 *
 * IMPORTANT UX CHANGE:
 * - We only trim while auto-scroll is enabled (user pinned to bottom).
 * - If the user scrolls up to inspect earlier output, we stop trimming
 *   so they do NOT see text "stream away" at the top.
 */
function trimTapeIfNeeded() {
    if (!autoScrollEnabled.value) {
        // User is scrolled up; avoid visual "vanishing tape" at the top.
        return
    }

    let total = totalTapeChars()
    if (total <= tapeMaxChars.value) return

    let excess = total - tapeMaxChars.value

    while (excess > 0 && tapeSegments.value.length > 0) {
        const first = tapeSegments.value[0]

        // Extra safety so TS and runtime are both happy:
        if (!first) {
            break
        }

        if (first.text.length <= excess) {
            excess -= first.text.length
            tapeSegments.value.shift()
        } else {
            first.text = first.text.slice(excess)
            excess = 0
        }
    }
}

/**
 * Immediately flush all currently pending/queued jobs into the tape with
 * no animation. Used when fastForwardToLatest is enabled and a new job
 * arrives while older ones are still streaming.
 */
function flushBacklogToTapeSync() {
    // 1) Flush any currently pending text for the active job.
    if (pendingText.value.length && activeJobId.value != null) {
        let last = tapeSegments.value[tapeSegments.value.length - 1]
        if (!last || last.id !== activeJobId.value) {
            last = { id: activeJobId.value, text: '' }
            tapeSegments.value.push(last)
        }
        last.text += pendingText.value
        pendingText.value = ''
    }

    // 2) Flush any queued jobs in order.
    if (jobQueue.value.length > 0) {
        for (const job of jobQueue.value) {
            let last = tapeSegments.value[tapeSegments.value.length - 1]
            if (!last || last.id !== job.id) {
                last = { id: job.id, text: '' }
                tapeSegments.value.push(last)
            }
            last.text += job.text
        }
        jobQueue.value = []
    }

    // After flushing everything, no job is actively streaming.
    activeJobId.value = null

    // Enforce cap if user is at the bottom.
    trimTapeIfNeeded()
}

/**
 * Ensure pendingText has content to stream:
 *  - If pendingText is empty and jobQueue has entries, pull the next job and
 *    assign its full text to pendingText.
 */
function hydratePendingFromQueueIfNeeded() {
    if (pendingText.value.length > 0) return
    if (!jobQueue.value.length) return

    const next = jobQueue.value.shift()!
    activeJobId.value = next.id
    pendingText.value = next.text

    // Create a new segment for this job if needed
    const last = tapeSegments.value[tapeSegments.value.length - 1]
    if (!last || last.id !== next.id) {
        tapeSegments.value.push({ id: next.id, text: '' })
    }
}

function startTypingTimer() {
    if (typingTimer !== null) return

    typingTimer = window.setInterval(() => {
        // If we have nothing pending, try to pull from queued jobs.
        if (!pendingText.value.length) {
            hydratePendingFromQueueIfNeeded()
            if (!pendingText.value.length) {
                // No work to do; stop timer.
                stopTypingTimer()
                activeJobId.value = null
                return
            }
        }

        // Base chars per tick from user setting
        const baseChars = Math.max(1, currentCharsPerTick.value || 1)

        // If there is a backlog (jobs waiting behind the current one),
        // speed up streaming with the backlogSpeedFactor.
        const hasBacklog = jobQueue.value.length > 0
        const factor = hasBacklog ? Math.max(1, backlogSpeedFactor.value || 1) : 1

        const chars = Math.max(1, Math.floor(baseChars * factor))
        const chunk = pendingText.value.slice(0, chars)
        pendingText.value = pendingText.value.slice(chars)

        // Append new characters to the active segment
        if (activeJobId.value != null) {
            let last = tapeSegments.value[tapeSegments.value.length - 1]
            if (!last || last.id !== activeJobId.value) {
                last = { id: activeJobId.value, text: '' }
                tapeSegments.value.push(last)
            }
            last.text += chunk
        } else {
            // Safety fallback: no active job id; treat as anonymous segment
            if (!tapeSegments.value.length) {
                tapeSegments.value.push({ id: -1, text: '' })
            }
            const last = tapeSegments.value[tapeSegments.value.length - 1]
            if (!last) {
                // Extremely defensive; should not happen if we just pushed
                return
            }
            last.text += chunk
        }

        trimTapeIfNeeded()

        // If this job's text is fully streamed, and there are more queued jobs,
        // the next tick will hydratePendingFromQueueIfNeeded and we’ll begin
        // a new segment, giving a clear visual break (job-divider).
        if (!pendingText.value.length) {
            if (!jobQueue.value.length) {
                // No more jobs queued; active job finishes naturally.
                activeJobId.value = null
            } else {
                // There are more jobs queued; next hydration will set activeJobId
                // to the next job and create a new segment.
            }
        }
    }, Math.max(1, currentIntervalMs.value || 1)) as unknown as number
}

/* Track the last job id we’ve already enqueued for streaming */
const lastEnqueuedJobId = ref<number | null>(null)

/**
 * Whenever the backend reports a new completed job (via lastJob),
 * enqueue its full text for streaming.
 *
 * If another job arrives while we’re still streaming, we either:
 *  - (fastForwardToLatest=false) enqueue and let backlog speed handle it, or
 *  - (fastForwardToLatest=true) flush backlog instantly and focus on the latest job.
 */
watch(
    () => printer.value.lastJob,
    (job) => {
        if (!job) return

        if (lastEnqueuedJobId.value === job.id) {
            return
        }

        lastEnqueuedJobId.value = job.id

        const text =
            printer.value.lastJobFullText != null
                ? printer.value.lastJobFullText
                : job.preview ?? ''

        if (!text) return

        const newJob: QueuedJob = { id: job.id, text }

        const hasInFlightBacklog =
            pendingText.value.length > 0 || jobQueue.value.length > 0

        if (fastForwardToLatest.value && hasInFlightBacklog) {
            // Fast-forward: flush all older work synchronously, then
            // start streaming ONLY the latest job.
            flushBacklogToTapeSync()

            jobQueue.value = [newJob]
            pendingText.value = ''
            activeJobId.value = null

            hydratePendingFromQueueIfNeeded()
            startTypingTimer()
        } else {
            // Existing behavior: enqueue and let the backlog
            // speed factor handle older jobs.
            jobQueue.value.push(newJob)
            hydratePendingFromQueueIfNeeded()
            startTypingTimer()
        }
    }
)

/**
 * When the user changes typing speed controls, restart the timer if needed
 * so the new values take effect during an in-flight stream.
 */
watch(
    () => ({
        interval: currentIntervalMs.value,
        chars: currentCharsPerTick.value,
        backlogFactor: backlogSpeedFactor.value,
        fastForward: fastForwardToLatest.value,
        bufferSize: tapeMaxChars.value,
    }),
    () => {
        if (!pendingText.value.length && !jobQueue.value.length) return
        if (typingTimer !== null) {
            stopTypingTimer()
            startTypingTimer()
        }
    }
)

/* -------------------------------------------------------------------------- */
/*  Status / connection indicators (badge text)                               */
/* -------------------------------------------------------------------------- */

const isReconnecting = computed(() => {
    return printer.value.phase === 'disconnected' && printer.value.stats.lastErrorAt != null
})

/**
 * Status badge semantics:
 *
 * - error               → "Error"
 * - disconnected        → "Disconnected" or "Reconnecting…"
 * - streaming text      → "Printing"
 * - backend has job     → "Spooling…" (device is receiving / job has started)
 * - connected & idle    → "Idle"
 */
const statusLabel = computed(() => {
    if (printer.value.phase === 'error') {
        return 'Error'
    }

    if (printer.value.phase === 'disconnected') {
        return isReconnecting.value ? 'Reconnecting…' : 'Disconnected'
    }

    // Device is logically present at this point (connected / receiving / queued).

    // While the UI is streaming a job onto the tape.
    if (isStreaming.value) {
        return 'Printing'
    }

    // Device-level job has started but we're not streaming UI text yet.
    if (printer.value.currentJob) {
        return 'Spooling…'
    }

    // Fully idle but connected.
    return 'Idle'
})

/* -------------------------------------------------------------------------- */
/*  Auto-scroll watcher                                                       */
/* -------------------------------------------------------------------------- */

const tapeJoined = computed(() => tapeSegments.value.map(s => s.text).join('\n'))

watch(
    () => ({
        tape: tapeJoined.value,
        jobs: printer.value.stats.totalJobs,
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
    tapeSegments.value = []
    pendingText.value = ''
    jobQueue.value = []
    activeJobId.value = null
})

/* -------------------------------------------------------------------------- */
/*  Options panel toggle + reset                                              */
/* -------------------------------------------------------------------------- */

const showOptions = ref(false)

function resetSpeed() {
    currentIntervalMs.value = envTypingInterval
    currentCharsPerTick.value = envCharsPerTick
    backlogSpeedFactor.value = envBacklogFactor
    fastForwardToLatest.value = envFastForwardToLatest
    tapeMaxChars.value = envTapeMaxChars
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

/* ------------------------------------------------------------------ */
/* Device disconnected / reconnecting / error                         */
/* ------------------------------------------------------------------ */

/* Disconnected baseline */
.status-badge[data-phase='disconnected'] {
    border-color: #4b5563;
    background: #020617;
}
.status-badge[data-phase='disconnected'] .dot {
    background: #6b7280;
}

/* Disconnected + reconnecting (yellow, like CF "busy") */
.status-badge[data-phase='disconnected'][data-reconnecting='true'] {
    border-color: #facc15;
    background: #3b2900;
}
.status-badge[data-phase='disconnected'][data-reconnecting='true'] .dot {
    background: #facc15;
}

/* Error state (red) */
.status-badge[data-phase='error'] {
    border-color: #ef4444;
    background: #450a0a;
}
.status-badge[data-phase='error'] .dot {
    background: #ef4444;
}

/* ------------------------------------------------------------------ */
/* Ready / Spooling / Printing / Queued                               */
/* ------------------------------------------------------------------ */

/* READY → phase='connected' (blue, mirrors CF "No Media") */
.status-badge[data-phase='connected'] {
    border-color: #38bdf8;
    background: #022c3a;
}
.status-badge[data-phase='connected'] .dot {
    background: #38bdf8;
}

/* SPOOLING → phase='receiving' but not yet streaming (yellow, CF "Busy") */
.status-badge[data-phase='receiving'][data-streaming='false'] {
    border-color: #facc15;
    background: #3b2900;
}
.status-badge[data-phase='receiving'][data-streaming='false'] .dot {
    background: #facc15;
}

/* PRINTING → phase='receiving' while streaming (green, CF "Media Ready") */
.status-badge[data-phase='receiving'][data-streaming='true'] {
    border-color: #22c55e;
    background: #022c22;
}
.status-badge[data-phase='receiving'][data-streaming='true'] .dot {
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

/* Job blocks (one per job) */
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