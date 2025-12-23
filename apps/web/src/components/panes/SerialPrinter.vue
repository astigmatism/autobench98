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
                    :data-status="statusKind"
                >
                    <span class="dot"></span>
                    <span class="label">{{ statusLabel }}</span>
                </span>
            </div>

            <!-- Tape viewport (no scrolling here) -->
            <div class="tape-viewport">
                <!-- Simulated continuous tape -->
                <div class="tape">
                    <!-- Subtle perforation at the top -->
                    <div class="tape-perf"></div>

                    <!-- Scrollable job region inside the tape -->
                    <div
                        ref="tapeScrollRef"
                        class="tape-scroll"
                        @scroll="onScroll"
                    >
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
                    </div>

                    <!-- Tape footer shadow (fixed to visual bottom of tape) -->
                    <!-- <div class="tape-footer"></div> -->
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

/**
 * Per-pane UI prefs (Serial Printer pane)
 */
type SpPanePrefs = {
    showOptions?: boolean
    currentIntervalMs?: number
    currentCharsPerTick?: number
    backlogSpeedFactor?: number
    tapeMaxChars?: number
    fastForwardToLatest?: boolean
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
    __spPaneUi?: SpPanePrefs
    /** Monotonic "profile load" revision stamped by App.vue to force rehydrate on load. */
    __spPaneProfileRev?: number
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

// Capture the total job count at mount-time to distinguish a cold start
// (0 jobs when this pane mounted) from a "refresh-with-history" scenario.
const initialTotalJobsAtMount = printer.value.stats?.totalJobs ?? 0

/* -------------------------------------------------------------------------- */
/*  Tape auto-scroll behavior (now on inner scroll region)                    */
/* -------------------------------------------------------------------------- */

const tapeScrollRef = ref<HTMLElement | null>(null)
const autoScrollEnabled = ref(true)

function scrollToBottom() {
    const el = tapeScrollRef.value
    if (!el) return
    el.scrollTop = el.scrollHeight
}

function onScroll(evt: Event) {
    const el = evt.target as HTMLElement | null
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

/**
 * Tracks whether we've already hydrated the tape from the initial snapshot.
 * Also tracks which job IDs have already been fully realized on the tape
 * (either via hydration or streaming), so we never re-enqueue them.
 */
const hasHydratedFromSnapshot = ref(false)
// Non-reactive Set is fine; we only use it for guards.
const realizedJobIds = new Set<number>()

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

/* -------------------------------------------------------------------------- */
/*  Per-pane UI persistence (localStorage + profile round-trip)               */
/* -------------------------------------------------------------------------- */

const showOptions = ref(false)
const currentIntervalMs = ref(envTypingInterval)
const currentCharsPerTick = ref(envCharsPerTick)
const backlogSpeedFactor = ref(envBacklogFactor)
const tapeMaxChars = ref(envTapeMaxChars)
const fastForwardToLatest = ref(envFastForwardToLatest)

const paneId = computed(() => String(props.pane?.id ?? '').trim())
const STORAGE_PREFIX = 'sp:pane:ui:'
const storageKey = computed(() => (paneId.value ? `${STORAGE_PREFIX}${paneId.value}` : ''))

function readPanePrefs(): SpPanePrefs | null {
    const key = storageKey.value
    if (!key) return null
    try {
        const raw = localStorage.getItem(key)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? (parsed as SpPanePrefs) : null
    } catch {
        return null
    }
}

function writePanePrefs(p: SpPanePrefs) {
    const key = storageKey.value
    if (!key) return
    try {
        localStorage.setItem(key, JSON.stringify(p))
    } catch {
        // ignore
    }
}

function exportPanePrefs(): SpPanePrefs {
    return {
        showOptions: !!showOptions.value,
        currentIntervalMs: currentIntervalMs.value,
        currentCharsPerTick: currentCharsPerTick.value,
        backlogSpeedFactor: backlogSpeedFactor.value,
        tapeMaxChars: tapeMaxChars.value,
        fastForwardToLatest: !!fastForwardToLatest.value,
    }
}

function applyPanePrefs(prefs?: SpPanePrefs | null) {
    if (!prefs || typeof prefs !== 'object') return

    const nextShow = (prefs as any).showOptions
    if (typeof nextShow === 'boolean') showOptions.value = nextShow

    const nextInterval = (prefs as any).currentIntervalMs
    if (isFiniteNumber(nextInterval)) currentIntervalMs.value = clampNumber(nextInterval, 1, 5000)

    const nextChars = (prefs as any).currentCharsPerTick
    if (isFiniteNumber(nextChars)) currentCharsPerTick.value = clampNumber(Math.floor(nextChars), 1, 50)

    const nextBacklog = (prefs as any).backlogSpeedFactor
    if (isFiniteNumber(nextBacklog)) backlogSpeedFactor.value = clampNumber(nextBacklog, 1, 1000)

    const nextMax = (prefs as any).tapeMaxChars
    if (isFiniteNumber(nextMax)) tapeMaxChars.value = clampNumber(Math.floor(nextMax), 100, 5_000_000)

    const nextFast = (prefs as any).fastForwardToLatest
    if (typeof nextFast === 'boolean') fastForwardToLatest.value = nextFast
}

const lastHydratedSig = ref<string>('')

function hydrateForPane() {
    const key = storageKey.value
    const rev = typeof props.__spPaneProfileRev === 'number' ? props.__spPaneProfileRev : 0
    const hasEmbed = isObject(props.__spPaneUi)

    // If pane id is missing, we can still apply embedded prefs.
    if (!key) {
        const sig = `nokey|rev:${rev}|embed:${hasEmbed ? 1 : 0}`
        if (lastHydratedSig.value === sig) return
        lastHydratedSig.value = sig

        if (hasEmbed) applyPanePrefs(props.__spPaneUi as SpPanePrefs)
        return
    }

    const sig = `${key}|rev:${rev}|embed:${hasEmbed ? 1 : 0}`
    if (lastHydratedSig.value === sig) return
    lastHydratedSig.value = sig

    // 1) Embedded prefs from profile snapshot win on load
    if (hasEmbed) {
        applyPanePrefs(props.__spPaneUi as SpPanePrefs)
        writePanePrefs(exportPanePrefs())
        return
    }

    // 2) localStorage
    const stored = readPanePrefs()
    if (stored) {
        applyPanePrefs(stored)
        return
    }

    // 3) defaults already in refs
}

// Rehydrate on pane id change OR when profile injects new prefs/rev (profile load)
watch([paneId, () => props.__spPaneUi, () => props.__spPaneProfileRev], () => hydrateForPane(), {
    immediate: true,
})

// Persist per-pane prefs when these change (if pane id exists)
watch(
    [
        () => showOptions.value,
        () => currentIntervalMs.value,
        () => currentCharsPerTick.value,
        () => backlogSpeedFactor.value,
        () => tapeMaxChars.value,
        () => fastForwardToLatest.value,
    ],
    () => {
        writePanePrefs(exportPanePrefs())
    }
)

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
 *   so they do NOT see text "vanish" at the top.
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
 * Hydrate the tape from the backend snapshot:
 * - Use printer.history (full text for older jobs)
 * - Optionally use lastJobFullText for the most recent job
 * This runs once per component lifecycle, and builds the initial
 * non-animated tape state so refreshes don't re-stream old jobs.
 */
function hydrateTapeFromSnapshot(
    snapshot: SerialPrinterSnapshotView,
    opts?: { includeLastJob?: boolean }
) {
    const includeLastJob = opts?.includeLastJob ?? true

    tapeSegments.value = []
    realizedJobIds.clear()

    const history = snapshot.history ?? []
    for (const entry of history) {
        if (!entry || !entry.text) continue
        tapeSegments.value.push({ id: entry.id, text: entry.text })
        realizedJobIds.add(entry.id)
    }

    if (includeLastJob) {
        const lastJob = snapshot.lastJob
        const lastText = snapshot.lastJobFullText

        if (lastJob && lastText && lastText.length > 0 && !realizedJobIds.has(lastJob.id)) {
            tapeSegments.value.push({ id: lastJob.id, text: lastText })
            realizedJobIds.add(lastJob.id)
        }
    }

    trimTapeIfNeeded()
}

/**
 * Ensure hydration happens exactly once.
 *
 * Behavior:
 * - If there were already jobs when this pane mounted (initialTotalJobsAtMount > 0),
 *   we hydrate from history + last job (no replay on refresh).
 * - If there were NO jobs at mount (cold start), we *do not* hydrate any text.
 *   We just mark the snapshot as "hydrated" so that the first job can stream
 *   in via the lastJob watcher.
 */
function ensureHydratedFromSnapshot() {
    if (hasHydratedFromSnapshot.value) return

    const snap = printer.value
    const hasAnyJobs =
        (snap.stats?.totalJobs ?? 0) > 0 ||
        (snap.history?.length ?? 0) > 0 ||
        !!snap.lastJob

    if (!hasAnyJobs) {
        return
    }

    if (initialTotalJobsAtMount > 0) {
        // We loaded the pane with existing history → hydrate fully.
        hydrateTapeFromSnapshot(snap, { includeLastJob: true })
    } else {
        // Cold start: there were no jobs when this pane mounted.
        // Do *not* hydrate any job text; let the first job stream in.
        // (We intentionally leave tapeSegments empty and realizedJobIds clear.)
    }

    hasHydratedFromSnapshot.value = true
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
        realizedJobIds.add(activeJobId.value)
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
            realizedJobIds.add(job.id)
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
            realizedJobIds.add(activeJobId.value)
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

/* -------------------------------------------------------------------------- */
/*  Initial hydration watch                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Watch the snapshot for the first sign of historical data (or a last job),
 * then hydrate exactly once.
 */
watch(
    () => ({
        totalJobs: printer.value.stats.totalJobs,
        historyLen: printer.value.history.length,
        lastJobId: printer.value.lastJob?.id ?? null,
    }),
    () => {
        ensureHydratedFromSnapshot()
    },
    { immediate: true }
)

/* -------------------------------------------------------------------------- */
/*  Job-completed → streaming bridge                                         */
/* -------------------------------------------------------------------------- */

/**
 * Whenever the backend reports a new completed job (via lastJob),
 * enqueue its full text for streaming.
 *
 * IMPORTANT:
 *  - We ignore lastJob updates until after initial hydration, so a refresh
 *    never replays old jobs.
 *  - We also guard with realizedJobIds so we never enqueue the same job twice.
 */
watch(
    () => printer.value.lastJob,
    (job) => {
        if (!job) return

        // Don’t react to lastJob until we’ve hydrated from the snapshot.
        if (!hasHydratedFromSnapshot.value) {
            return
        }

        // If we have already realized this job on the tape (via hydration or
        // a previous stream), do nothing.
        if (realizedJobIds.has(job.id)) {
            return
        }

        const text =
            printer.value.lastJobFullText != null
                ? printer.value.lastJobFullText
                : job.preview ?? ''

        if (!text) return

        realizedJobIds.add(job.id)

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
/*  Status / connection indicators (badge text + status token)               */
/* -------------------------------------------------------------------------- */

const isReconnecting = computed(() => {
    return printer.value.phase === 'disconnected' && printer.value.stats.lastErrorAt != null
})

/**
 * Status "kind" used for styling (data-status).
 * Kept in sync with statusLabel semantics but with stable tokens.
 */
const statusKind = computed(() => {
    if (printer.value.phase === 'error') {
        return 'error'
    }

    if (printer.value.phase === 'disconnected') {
        return isReconnecting.value ? 'reconnecting' : 'disconnected'
    }

    // While the UI is streaming a job onto the tape.
    if (isStreaming.value) {
        return 'printing'
    }

    // Device-level job has started but we're not streaming UI text yet.
    if (printer.value.currentJob) {
        return 'spooling'
    }

    if (printer.value.phase === 'queued') {
        return 'queued'
    }

    // Fully idle but connected (or any other non-terminal steady state).
    return 'ready'
})

/**
 * Status badge label text.
 *
 * - error               → "Error"
 * - disconnected        → "Disconnected" or "Reconnecting…"
 * - streaming text      → "Printing"
 * - backend has job     → "Spooling"
 * - connected & idle    → "Ready"
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
        return 'Spooling'
    }

    // Fully idle but connected.
    return 'Ready'
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
    realizedJobIds.clear()
    hasHydratedFromSnapshot.value = false
})

/* -------------------------------------------------------------------------- */
/*  Options panel toggle + reset                                              */
/* -------------------------------------------------------------------------- */

function resetSpeed() {
    currentIntervalMs.value = envTypingInterval
    currentCharsPerTick.value = envCharsPerTick
    backlogSpeedFactor.value = envBacklogFactor
    fastForwardToLatest.value = envFastForwardToLatest
    tapeMaxChars.value = envTapeMaxChars
}
</script>

<style scoped>
/* (UNCHANGED CSS) */
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
.status-badge[data-status='disconnected'] {
    border-color: #4b5563;
    background: #020617;
}
.status-badge[data-status='disconnected'] .dot {
    background: #6b7280;
}

/* Disconnected + reconnecting (yellow, busy-style) */
.status-badge[data-status='reconnecting'] {
    border-color: #facc15;
    background: #3b2900;
}
.status-badge[data-status='reconnecting'] .dot {
    background: #facc15;
}

/* Error state (red) */
.status-badge[data-status='error'] {
    border-color: #ef4444;
    background: #450a0a;
}
.status-badge[data-status='error'] .dot {
    background: #ef4444;
}

/* ------------------------------------------------------------------ */
/* Ready / Spooling / Printing / Queued                               */
/* ------------------------------------------------------------------ */

/* READY → logical idle, device present (green) */
.status-badge[data-status='ready'] {
    border-color: #22c55e;
    background: #022c22;
}
.status-badge[data-status='ready'] .dot {
    background: #22c55e;
}

/* SPOOLING → job started, not streaming yet (yellow + pulse) */
.status-badge[data-status='spooling'] {
    border-color: #facc15;
    background: #3b2900;
}
.status-badge[data-status='spooling'] .dot {
    background: #facc15;
    animation: pulse-dot 900ms ease-in-out infinite;
}

/* PRINTING → streaming to tape (yellow + pulse, separate rule) */
.status-badge[data-status='printing'] {
    border-color: #facc15;
    background: #3b2900;
}
.status-badge[data-status='printing'] .dot {
    background: #facc15;
    animation: pulse-dot 900ms ease-in-out infinite;
}

/* Optional: keep queued distinct (purple) */
.status-badge[data-status='queued'] {
    border-color: #a855f7;
    background: #2b103f;
}
.status-badge[data-status='queued'] .dot {
    background: #a855f7;
}

/* Pulsing dot for busy states (CF-style: scale + opacity) */
@keyframes pulse-dot {
    0% {
        transform: scale(1);
        opacity: 1;
    }
    50% {
        transform: scale(1.35);
        opacity: 0.4;
    }
    100% {
        transform: scale(1);
        opacity: 1;
    }
}

/* Tape viewport: fills remaining panel space, no scrolling here */
.tape-viewport {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    position: relative;

    padding: 4px 0;

    display: flex;
    align-items: stretch;
}

/* Tape surface: fills the viewport and owns the tape chrome */
.tape {
    position: relative;
    max-width: 100%;
    background: radial-gradient(circle at top left, #fefce8 0, #fefce8 40%, #f9fafb 100%);
    border-radius: 6px;
    padding: 0px 10px;
    box-shadow:
        0 0 0 1px rgba(15, 23, 42, 0.4),
        0 10px 24px rgba(15, 23, 42, 0.7);

    display: flex;
    flex-direction: column;

    height: 100%;
    width: 100%;
    box-sizing: border-box;
    overflow: hidden;
    margin: 0 auto;
}

/* Scrollable content area of the tape (jobs live here) */
.tape-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;

    /* Hide scrollbar – Firefox */
    scrollbar-width: none;
    /* Hide scrollbar – IE/old Edge */
    -ms-overflow-style: none;
}

/* Hide scrollbar – WebKit (Chrome, Safari, Edge Chromium) */
.tape-scroll::-webkit-scrollbar {
    display: none;
}

/* Perforation strip */
.tape-perf {
    position: absolute;
    top: 0px;
    height: 15px;
    width: calc(100% - 20px);
    background: repeating-linear-gradient(
        to right,
        rgba(15, 23, 42, 0.25),
        rgba(15, 23, 42, 0.25) 1px,
        transparent 1px,
        transparent 4px
    );
    mask-image: linear-gradient(to bottom, black, transparent);
}

/* Tape footer deep shadow (now correctly pinned to the visual bottom) */
.tape-footer {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 24px;
    pointer-events: none;
    background: linear-gradient(
        to bottom,
        rgba(0, 0, 0, 0.00),
        rgba(0, 0, 0, 0.30)
    );
}

/* Job blocks (one per job) */
.job-block {
    margin-top: 10px;
}

.job-block.current-job {
    animation: pulse-border 1.4s ease-in-out infinite;
}

/* Job body text (no inner scrolling now; scroll is on .tape-scroll) */
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
    margin: 10px 0px;
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
