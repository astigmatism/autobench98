<!-- apps/web/src/components/panes/StreamPane.vue -->
<template>
    <div
        class="stream-pane"
        :style="{ '--pane-fg': paneFg, '--panel-fg': panelFg }"
        @mouseenter="onPaneEnter"
        @mouseleave="onPaneLeave"
    >
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

        <transition name="slide-fade">
            <div v-show="showControls" id="stream-controls-panel" class="controls-panel">
                <div class="toolbar">
                    <div class="left">
                        <div class="controls">
                            <label class="checkbox panel panel-text">
                                <input type="checkbox" v-model="enabled" @change="onEnabledChange" />
                                <span>Show stream</span>
                            </label>

                            <label class="select panel-text">
                                <span>Scale</span>
                                <select v-model="scaleMode">
                                    <option value="fit">Fit</option>
                                    <option value="fill">Fill</option>
                                    <option value="stretch">Stretch</option>
                                    <option value="native">1:1</option>
                                </select>
                            </label>

                            <label class="select panel-text">
                                <span>Background</span>
                                <select v-model="bgMode">
                                    <option value="black">Black</option>
                                    <option value="pane">Pane</option>
                                </select>
                            </label>

                            <!-- Viewer-side fps cap (auto uses health metrics to keep stream live) -->
                            <label class="select panel-text">
                                <span>Viewer FPS</span>
                                <select v-model="fpsMode">
                                    <option value="auto">Auto</option>
                                    <option value="60">60</option>
                                    <option value="30">30</option>
                                    <option value="20">20</option>
                                    <option value="15">15</option>
                                    <option value="8">8</option>
                                    <option value="4">4</option>
                                    <option value="2">2</option>
                                </select>
                            </label>

                            <!-- Power/Reset overlay settings -->
                            <label class="select panel-text">
                                <span>Power/Reset</span>
                                <select v-model="fpButtonsPosition">
                                    <option value="bottom-left">Bottom left</option>
                                    <option value="bottom-right">Bottom right</option>
                                </select>
                            </label>

                            <label class="select panel-text">
                                <span>Visibility</span>
                                <select v-model="fpButtonsVisibility">
                                    <option value="always">Always visible</option>
                                    <option value="hover">Visible on mouse over</option>
                                    <option value="hidden">Not visible</option>
                                </select>
                            </label>

                            <!-- LED indicator overlay settings (position/visibility only) -->
                            <label class="select panel-text">
                                <span>LEDs</span>
                                <select v-model="fpLedsPosition">
                                    <option value="top-left">Top left</option>
                                    <option value="top-right">Top right</option>
                                </select>
                            </label>

                            <label class="select panel-text">
                                <span>LED visibility</span>
                                <select v-model="fpLedsVisibility">
                                    <option value="always">Always visible</option>
                                    <option value="hover">Visible on mouse over</option>
                                    <option value="hidden">Not visible</option>
                                </select>
                            </label>
                        </div>
                    </div>
                    <div class="right"></div>
                </div>

                <div class="health-panel">
                    <div class="health-header">
                        <span class="health-title">Sidecar / Stream health</span>

                        <span class="health-meta">
                            <span v-if="healthLoading" class="health-pill health-pill--loading">
                                Loading…
                            </span>
                            <span v-else-if="health" class="health-pill health-pill--ok">
                                {{ health.status === 'ok' ? 'OK' : health.status }}
                            </span>
                            <span v-else-if="healthError" class="health-pill health-pill--error">
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
                            <span class="label">Viewer cap</span>
                            <span class="value monospace">
                                {{ viewerCapLabel }}
                            </span>
                        </div>

                        <div class="health-row">
                            <span class="label">Resyncs</span>
                            <span class="value monospace">
                                {{ resyncCount }}
                            </span>
                        </div>

                        <div class="health-row">
                            <span class="label">Capture age</span>
                            <span class="value monospace" :data-age="captureAgeBucket">
                                {{ formattedCaptureAge }}
                            </span>
                        </div>

                        <div class="health-row">
                            <span class="label">Backlog est</span>
                            <span class="value monospace" :data-age="backlogBucket">
                                {{ formattedBacklog }}
                            </span>
                        </div>

                        <div class="health-row">
                            <span class="label">Buffered</span>
                            <span class="value monospace">
                                {{ formattedBuffered }}
                            </span>
                        </div>

                        <div class="health-row">
                            <span class="label">Downstream</span>
                            <span class="value monospace">
                                {{ formattedDownstream }}
                            </span>
                        </div>

                        <div class="health-row">
                            <span class="label">Backpressure</span>
                            <span class="value monospace">
                                {{ formattedBackpressure }}
                            </span>
                        </div>

                        <div class="health-row">
                            <span class="label">Avg frame</span>
                            <span class="value monospace">
                                {{ formattedAvgFrame }}
                            </span>
                        </div>

                        <div class="health-row">
                            <span class="label">Health RTT</span>
                            <span class="value monospace">
                                {{ healthRttMs != null ? `${healthRttMs}ms` : '—' }}
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

                    <div v-if="health" class="health-note">
                        If Capture age stays low but Backlog est climbs, the stream path is backlogged
                        (decode/throughput), not capture.
                    </div>
                </div>
            </div>
        </transition>

        <div class="viewport-stack">
            <div class="viewport" :data-bg="bgMode" :data-kb-available="canCapture ? 'true' : 'false'">
                <div v-if="enabled" class="viewport-inner">
                    <div
                        ref="captureRef"
                        class="kb-capture-layer"
                        tabindex="0"
                        role="button"
                        :aria-pressed="isCapturing ? 'true' : 'false'"
                        :data-capturing="isCapturing ? 'true' : 'false'"
                        :data-scale="scaleMode"
                        @mousedown.prevent="armCaptureFromMouse"
                        @focus="onFocusCapture"
                        @blur="onBlurCapture"
                        @keydown="onKeyDown"
                        @keyup="onKeyUp"
                    >
                        <div class="stream-frame" :data-scale="scaleMode" :style="streamFrameStyle">
                            <img
                                :key="reloadKey"
                                class="stream-img"
                                :data-scale="scaleMode"
                                :src="streamSrc"
                                alt="Test machine stream"
                                draggable="false"
                                @load="onStreamLoad"
                            />
                            <div class="stream-glow kb-glow" aria-hidden="true"></div>
                        </div>

                        <div
                            v-if="scaleMode === 'native'"
                            class="capture-glow kb-glow"
                            aria-hidden="true"
                        ></div>

                        <div v-if="isCapturing" class="kb-overlay" aria-hidden="true">
                            <div class="kb-overlay-inner">
                                <span class="kb-hint">Press <b>Ctrl+Esc</b> to cancel input capture</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-else class="viewport-placeholder">
                    <span class="placeholder-text">Stream is hidden (use ⚙️ to show)</span>
                </div>

                <!-- Front panel LED indicators (overlay + position control: top-left / top-right) -->
                <div
                    v-show="fpLedsShouldShow"
                    class="frontpanel-leds frontpanel-leds--overlay"
                    :data-pos="fpLedsPosition"
                >
                    <span class="fp-led-badge" data-kind="power" :data-mode="fpPowerLedMode">
                        <span class="label">PWR</span>
                        <span class="dot" aria-hidden="true"></span>
                    </span>

                    <span class="fp-led-badge" data-kind="hdd" :data-mode="fpHddLedMode">
                        <span class="label">HDD</span>
                        <span class="dot" aria-hidden="true"></span>
                    </span>
                </div>

                <!-- Front panel controls: overlay + position control (bottom-left / bottom-right) -->
                <div
                    v-show="fpButtonsShouldShow"
                    class="frontpanel-controls frontpanel-controls--overlay"
                    :data-pos="fpButtonsPosition"
                >
                    <button
                        class="fp-btn"
                        :data-held="powerHeldByClient ? 'true' : 'false'"
                        :disabled="!fpCanInteract"
                        @mousedown.prevent="onPowerHoldStart"
                        @mouseup.prevent="onPowerHoldEnd"
                        @mouseleave.prevent="onPowerHoldEnd"
                        @touchstart.prevent="onPowerHoldStart"
                        @touchend.prevent="onPowerHoldEnd"
                        @touchcancel.prevent="onPowerHoldEnd"
                    >
                        Power
                    </button>

                    <button
                        class="fp-btn"
                        :data-held="resetHeldByClient ? 'true' : 'false'"
                        :disabled="!fpCanInteract"
                        @mousedown.prevent="onResetHoldStart"
                        @mouseup.prevent="onResetHoldEnd"
                        @mouseleave.prevent="onResetHoldEnd"
                        @touchstart.prevent="onResetHoldStart"
                        @touchend.prevent="onResetHoldEnd"
                        @touchcancel.prevent="onResetHoldEnd"
                    >
                        Reset
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { getRealtimeClient } from '@/bootstrap'
import { useMirror } from '@/stores/mirror'

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

type StreamFpsMode = 'auto' | '60' | '30' | '20' | '15' | '8' | '4' | '2'

type FrontPanelButtonsPosition = 'bottom-left' | 'bottom-right'
type FrontPanelButtonsVisibility = 'always' | 'hover' | 'hidden'

type FrontPanelLedsPosition = 'top-left' | 'top-right'
type FrontPanelLedsVisibility = 'always' | 'hover' | 'hidden'
type FrontPanelLedMode = 'off' | 'on' | 'blink' | 'blink-fast' | 'pulse'

type StreamPanePrefs = {
    enabled?: boolean
    scaleMode?: 'fit' | 'fill' | 'stretch' | 'native'
    bgMode?: 'black' | 'pane'
    fpsMode?: StreamFpsMode

    fpButtonsPosition?: FrontPanelButtonsPosition
    fpButtonsVisibility?: FrontPanelButtonsVisibility

    fpLedsPosition?: FrontPanelLedsPosition
    fpLedsVisibility?: FrontPanelLedsVisibility
}

function isObject(x: any): x is Record<string, unknown> {
    return x !== null && typeof x === 'object' && !Array.isArray(x)
}

const props = defineProps<{
    pane?: PaneInfo
    __streamPaneUi?: StreamPanePrefs
    __streamPaneProfileRev?: number
}>()

const STREAM_ENDPOINT = '/api/sidecar/stream'
const HEALTH_ENDPOINT = '/api/sidecar/health'

type SidecarStreamDiag = {
    clients: number
    lastFrameBytes: number
    avgFrameBytes: number | null
    backpressureEvents: number
    lastBackpressureTs: number | null
    maxClientBufferedBytes: number
    maxClientBufferedRatio: number
    downstreamBps: number | null
    estBacklogMs: number | null
    updatedAt: string | null
}

type SidecarHealthMetrics = {
    frame?: string
    fps?: string
    quality?: string
    time?: string
    size?: string
    bitrate?: string
}

type SidecarHealthCapture = {
    running: boolean
    lastFrameTs: number | null
    lastFrameAgeMs?: number | null
    lastError: string | null
    restartCount: number
    metrics?: SidecarHealthMetrics
    hasLastFrame: boolean
    streamDiag?: SidecarStreamDiag | null
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

const panelFg = '#e6e6e6'

const showControls = ref(false)
const enabled = ref(true)
const scaleMode = ref<'fit' | 'fill' | 'stretch' | 'native'>('fit')
const bgMode = ref<'black' | 'pane'>('black')
const reloadKey = ref(0)

/* -------------------------------------------------------------------------- */
/*  Front panel buttons state (visibility + position + hover)                 */
/* -------------------------------------------------------------------------- */

const fpButtonsPosition = ref<FrontPanelButtonsPosition>('bottom-left')
const fpButtonsVisibility = ref<FrontPanelButtonsVisibility>('hover')

/* -------------------------------------------------------------------------- */
/*  Front panel LED indicators (visibility + position)                        */
/*  LED state is derived STRICTLY from frontPanel.powerSense / frontPanel.hddActive */
/* -------------------------------------------------------------------------- */

const fpLedsPosition = ref<FrontPanelLedsPosition>('top-left')
const fpLedsVisibility = ref<FrontPanelLedsVisibility>('hover')

const isHoveringPane = ref(false)
function onPaneEnter() {
    isHoveringPane.value = true
}
function onPaneLeave() {
    isHoveringPane.value = false
}

const fpButtonsShouldShow = computed(() => {
    if (fpButtonsVisibility.value === 'hidden') return false
    if (fpButtonsVisibility.value === 'always') return true
    return isHoveringPane.value
})

const fpLedsShouldShow = computed(() => {
    if (fpLedsVisibility.value === 'hidden') return false
    if (fpLedsVisibility.value === 'always') return true
    return isHoveringPane.value
})

/* -------------------------------------------------------------------------- */
/*  Front panel readiness + LED state (from mirror)                           */
/* -------------------------------------------------------------------------- */

type FrontPanelPhase = 'disconnected' | 'connecting' | 'identifying' | 'ready' | 'error'
type FrontPanelSnapshot = {
    phase: FrontPanelPhase
    identified: boolean

    // These are the ONLY fields used for the LED indicators.
    powerSense?: boolean
    hddActive?: boolean
}

const mirror = useMirror()
const fp = computed<FrontPanelSnapshot>(() => {
    const root = mirror.data as any
    const slice = root?.frontPanel as FrontPanelSnapshot | undefined
    return slice ?? { phase: 'disconnected', identified: false, powerSense: false, hddActive: false }
})

const fpCanInteract = computed(() => fp.value.phase === 'ready' && fp.value.identified)

// Hard binding as requested:
const fpPowerLedMode = computed<FrontPanelLedMode>(() => (fp.value.powerSense ? 'on' : 'off'))
const fpHddLedMode = computed<FrontPanelLedMode>(() => (fp.value.hddActive ? 'on' : 'off'))

const powerHeldByClient = ref(false)
const resetHeldByClient = ref(false)

/* -------------------------------------------------------------------------- */
/*  Viewer FPS cap (adaptive)                                                 */
/* -------------------------------------------------------------------------- */

const fpsMode = ref<StreamFpsMode>('auto')

// Auto-selected cap (only used when fpsMode === 'auto')
const autoMaxFps = ref<number>(30)

const resyncCount = ref(0)
const lastResyncTs = ref<number>(0)
const stableImproveTicks = ref<number>(0)

const MB = 1024 * 1024

function modeToFps(m: StreamFpsMode): number {
    if (m === 'auto') return autoMaxFps.value
    const n = parseInt(m, 10)
    return Number.isFinite(n) && n > 0 ? n : autoMaxFps.value
}

const effectiveMaxFps = computed(() => modeToFps(fpsMode.value))

const viewerCapLabel = computed(() => {
    if (fpsMode.value === 'auto') return `Auto (${effectiveMaxFps.value})`
    return `${effectiveMaxFps.value}`
})

const streamSrc = computed(() => {
    const params = new URLSearchParams()
    params.set('maxFps', String(effectiveMaxFps.value))
    return `${STREAM_ENDPOINT}?${params.toString()}`
})

function requestStreamResync(reason: string) {
    void reason
    if (!enabled.value) return
    const now = Date.now()
    if (now - lastResyncTs.value < 1500) return

    lastResyncTs.value = now
    resyncCount.value += 1
    reloadStream()
}

/* -------------------------------------------------------------------------- */
/*  WS access                                                                 */
/* -------------------------------------------------------------------------- */

const wsClientRef = ref<any | null>(null)
function refreshWsClient() {
    wsClientRef.value = getRealtimeClient()
}

let wsRetryTimer: number | null = null
let wsRetryStopTimer: number | null = null

onMounted(() => {
    refreshWsClient()

    wsRetryTimer = window.setInterval(() => {
        if (wsClientRef.value) {
            if (wsRetryTimer != null) window.clearInterval(wsRetryTimer)
            wsRetryTimer = null
            return
        }
        refreshWsClient()
    }, 250)

    wsRetryStopTimer = window.setTimeout(() => {
        if (wsRetryTimer != null) window.clearInterval(wsRetryTimer)
        wsRetryTimer = null
    }, 5000)
})

function trySend(obj: any): boolean {
    const ws = wsClientRef.value
    if (!ws) return false

    if (typeof ws.sendPs2KeyboardCommand === 'function') {
        ws.sendPs2KeyboardCommand(obj.payload)
        return true
    }

    if (typeof ws.send === 'function') {
        ws.send(obj)
        return true
    }

    return false
}

function sendKey(action: 'press' | 'hold' | 'release', code: string, key?: string) {
    trySend({
        type: 'ps2-keyboard.command',
        payload: { kind: 'key', action, code, key },
    })
}

/* -------------------------------------------------------------------------- */
/*  Front panel WS send + controls                                            */
/* -------------------------------------------------------------------------- */

function sendFrontPanel(kind: string, payload: Record<string, unknown> = {}) {
    refreshWsClient()
    const ws = wsClientRef.value
    if (!ws) return

    const body = {
        kind,
        requestedBy: 'stream-pane',
        ...payload,
    }

    if (typeof ws.sendFrontPanelCommand === 'function') {
        ws.sendFrontPanelCommand(body)
        return
    }

    if (typeof ws.send === 'function') {
        ws.send({
            type: 'frontpanel.command',
            payload: body,
        })
    }
}

function onPowerHoldStart() {
    if (!fpCanInteract.value) return
    if (powerHeldByClient.value) return
    powerHeldByClient.value = true
    sendFrontPanel('powerHold')
}

function onPowerHoldEnd() {
    const wasHeld = powerHeldByClient.value
    powerHeldByClient.value = false
    if (!wasHeld) return
    sendFrontPanel('powerRelease')
}

function onResetHoldStart() {
    if (!fpCanInteract.value) return
    if (resetHeldByClient.value) return
    resetHeldByClient.value = true
    sendFrontPanel('resetHold')
}

function onResetHoldEnd() {
    const wasHeld = resetHeldByClient.value
    resetHeldByClient.value = false
    if (!wasHeld) return
    sendFrontPanel('resetRelease')
}

watch(
    () => fpCanInteract.value,
    (ok, prev) => {
        if (ok) return
        if (prev) {
            if (powerHeldByClient.value) {
                powerHeldByClient.value = false
                sendFrontPanel('powerRelease')
            }
            if (resetHeldByClient.value) {
                resetHeldByClient.value = false
                sendFrontPanel('resetRelease')
            }
        } else {
            powerHeldByClient.value = false
            resetHeldByClient.value = false
        }
    },
    { immediate: true }
)

/* -------------------------------------------------------------------------- */
/*  Keyboard capture                                                          */
/* -------------------------------------------------------------------------- */

const captureRef = ref<HTMLElement | null>(null)
const isCapturing = ref(false)
const armOnNextFocus = ref(false)

const MODIFIER_CODES = new Set<string>([
    'ShiftLeft',
    'ShiftRight',
    'ControlLeft',
    'ControlRight',
    'AltLeft',
    'AltRight',
    'MetaLeft',
    'MetaRight',
])

const heldModifiers = new Set<string>()
const canCapture = computed(() => enabled.value)

function focusCaptureLayer(): boolean {
    const el = captureRef.value
    if (!el) return false
    try {
        ;(el as any).focus?.({ preventScroll: true })
    } catch {
        try {
            el.focus?.()
        } catch {
            // ignore
        }
    }
    return document.activeElement === el
}

function armCaptureFromMouse() {
    if (!canCapture.value) return

    refreshWsClient()

    isCapturing.value = true
    armOnNextFocus.value = false

    const focused = focusCaptureLayer()
    if (!focused) armOnNextFocus.value = true
}

function releaseCapture(opts?: { fromBlur?: boolean }) {
    const fromBlur = !!opts?.fromBlur

    if (heldModifiers.size > 0) {
        const codes = Array.from(heldModifiers).sort()
        for (const code of codes) sendKey('release', code)
    }
    heldModifiers.clear()

    isCapturing.value = false
    armOnNextFocus.value = false

    if (!fromBlur) {
        try {
            captureRef.value?.blur?.()
        } catch {
            // ignore
        }
    }
}

function onFocusCapture() {
    if (!canCapture.value) {
        releaseCapture()
        return
    }

    refreshWsClient()

    if (armOnNextFocus.value) {
        isCapturing.value = true
        armOnNextFocus.value = false
    }
}

function onBlurCapture() {
    if (!isCapturing.value && !armOnNextFocus.value) return
    releaseCapture({ fromBlur: true })
}

function isReleaseCombo(e: KeyboardEvent): boolean {
    return e.code === 'Escape' && e.ctrlKey
}

function blockBrowser(e: KeyboardEvent) {
    e.preventDefault()
    e.stopPropagation()
}

function onKeyDown(e: KeyboardEvent) {
    if (!isCapturing.value) return

    if (isReleaseCombo(e)) {
        blockBrowser(e)
        releaseCapture()
        return
    }

    const code = e.code || ''
    if (!code) {
        blockBrowser(e)
        return
    }

    if (MODIFIER_CODES.has(code)) {
        if (!e.repeat && !heldModifiers.has(code)) {
            sendKey('hold', code, e.key)
            heldModifiers.add(code)
        }
        blockBrowser(e)
        return
    }

    sendKey('press', code, e.key)
    blockBrowser(e)
}

function onKeyUp(e: KeyboardEvent) {
    if (!isCapturing.value) return

    const code = e.code || ''
    if (!code) {
        blockBrowser(e)
        return
    }

    if (MODIFIER_CODES.has(code) && heldModifiers.has(code)) {
        sendKey('release', code, e.key)
        heldModifiers.delete(code)
    }

    blockBrowser(e)
}

watch(
    () => enabled.value,
    (v) => {
        if (!v && (isCapturing.value || armOnNextFocus.value)) releaseCapture()
    }
)

/* -------------------------------------------------------------------------- */
/*  Stream sizing                                                             */
/* -------------------------------------------------------------------------- */

type StreamMeta = { w: number; h: number; ar: number }
const streamMeta = ref<StreamMeta | null>(null)
const frameBox = ref<{ w: number; h: number } | null>(null)

function clampInt(n: number, min: number, max: number): number {
    if (!Number.isFinite(n)) return min
    return Math.max(min, Math.min(max, Math.round(n)))
}

function updateFrameBox() {
    const el = captureRef.value
    if (!el) return

    const r = el.getBoundingClientRect()
    const cw = Math.max(0, Math.floor(r.width))
    const ch = Math.max(0, Math.floor(r.height))
    if (cw <= 0 || ch <= 0) return

    const meta = streamMeta.value
    const ar = meta?.ar && Number.isFinite(meta.ar) && meta.ar > 0 ? meta.ar : 4 / 3

    if (scaleMode.value === 'fit') {
        const containerAr = cw / ch
        let w = cw
        let h = ch

        if (containerAr > ar) {
            h = ch
            w = Math.floor(h * ar)
        } else {
            w = cw
            h = Math.floor(w / ar)
        }

        frameBox.value = {
            w: clampInt(w, 1, cw),
            h: clampInt(h, 1, ch),
        }
        return
    }

    if (scaleMode.value === 'native') {
        if (meta?.w && meta?.h) {
            frameBox.value = { w: Math.max(1, Math.floor(meta.w)), h: Math.max(1, Math.floor(meta.h)) }
        } else {
            frameBox.value = null
        }
        return
    }

    frameBox.value = null
}

function onStreamLoad(e: Event) {
    const img = e.target as HTMLImageElement | null
    if (!img) return
    const w = img.naturalWidth
    const h = img.naturalHeight
    if (w && h) streamMeta.value = { w, h, ar: w / h }
    updateFrameBox()
}

const streamFrameStyle = computed(() => {
    const mode = scaleMode.value
    if (mode === 'fit' || mode === 'native') {
        const b = frameBox.value
        if (b) return { width: `${b.w}px`, height: `${b.h}px` }
        return { width: '100%', height: '100%' }
    }
    return { width: '100%', height: '100%' }
})

let frameResizeObs: ResizeObserver | null = null

onMounted(() => {
    const el = captureRef.value
    if (el && typeof ResizeObserver !== 'undefined') {
        frameResizeObs = new ResizeObserver(() => updateFrameBox())
        frameResizeObs.observe(el)
    }
    updateFrameBox()
})

watch(
    () => scaleMode.value,
    () => updateFrameBox()
)

/* -------------------------------------------------------------------------- */
/*  Per-pane persistence                                                      */
/* -------------------------------------------------------------------------- */

function isValidScaleMode(x: any): x is 'fit' | 'fill' | 'stretch' | 'native' {
    return x === 'fit' || x === 'fill' || x === 'stretch' || x === 'native'
}
function isValidBgMode(x: any): x is 'black' | 'pane' {
    return x === 'black' || x === 'pane'
}
function isValidFpsMode(x: any): x is StreamFpsMode {
    return (
        x === 'auto' ||
        x === '60' ||
        x === '30' ||
        x === '20' ||
        x === '15' ||
        x === '8' ||
        x === '4' ||
        x === '2'
    )
}
function isValidFpPos(x: any): x is FrontPanelButtonsPosition {
    return x === 'bottom-left' || x === 'bottom-right'
}
function isValidFpVis(x: any): x is FrontPanelButtonsVisibility {
    return x === 'always' || x === 'hover' || x === 'hidden'
}

function isValidFpLedsPos(x: any): x is FrontPanelLedsPosition {
    return x === 'top-left' || x === 'top-right'
}
function isValidFpLedsVis(x: any): x is FrontPanelLedsVisibility {
    return x === 'always' || x === 'hover' || x === 'hidden'
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
        const raw = JSON.stringify(p)
        localStorage.setItem(key, raw)
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

    const nextFps = (prefs as any).fpsMode
    if (isValidFpsMode(nextFps)) fpsMode.value = nextFps

    const nextFpPos = (prefs as any).fpButtonsPosition
    if (isValidFpPos(nextFpPos)) fpButtonsPosition.value = nextFpPos

    const nextFpVis = (prefs as any).fpButtonsVisibility
    if (isValidFpVis(nextFpVis)) fpButtonsVisibility.value = nextFpVis

    const nextLedsPos = (prefs as any).fpLedsPosition
    if (isValidFpLedsPos(nextLedsPos)) fpLedsPosition.value = nextLedsPos

    const nextLedsVis = (prefs as any).fpLedsVisibility
    if (isValidFpLedsVis(nextLedsVis)) fpLedsVisibility.value = nextLedsVis
}

function exportPanePrefs(): StreamPanePrefs {
    return {
        enabled: !!enabled.value,
        scaleMode: scaleMode.value,
        bgMode: bgMode.value,
        fpsMode: fpsMode.value,
        fpButtonsPosition: fpButtonsPosition.value,
        fpButtonsVisibility: fpButtonsVisibility.value,
        fpLedsPosition: fpLedsPosition.value,
        fpLedsVisibility: fpLedsVisibility.value,
    }
}

const lastHydratedSig = ref<string>('')

function hydrateForPane() {
    const key = storageKey.value
    const rev = typeof props.__streamPaneProfileRev === 'number' ? props.__streamPaneProfileRev : 0
    const hasEmbed = isObject(props.__streamPaneUi)

    if (!key) {
        const sig = `nokey|rev:${rev}|embed:${hasEmbed ? 1 : 0}`
        if (lastHydratedSig.value === sig) return
        lastHydratedSig.value = sig
        if (hasEmbed) applyPanePrefs(props.__streamPaneUi as StreamPanePrefs)
        return
    }

    const sig = `${key}|rev:${rev}|embed:${hasEmbed ? 1 : 0}`
    if (lastHydratedSig.value === sig) return
    lastHydratedSig.value = sig

    if (hasEmbed) {
        applyPanePrefs(props.__streamPaneUi as StreamPanePrefs)
        writePanePrefs(exportPanePrefs())
        return
    }

    const stored = readPanePrefs()
    if (stored) applyPanePrefs(stored)
}

onMounted(() => hydrateForPane())
watch([paneId, () => props.__streamPaneUi, () => props.__streamPaneProfileRev], () => hydrateForPane())
watch(
    [
        () => enabled.value,
        () => scaleMode.value,
        () => bgMode.value,
        () => fpsMode.value,
        () => fpButtonsPosition.value,
        () => fpButtonsVisibility.value,
        () => fpLedsPosition.value,
        () => fpLedsVisibility.value,
    ],
    () => writePanePrefs(exportPanePrefs())
)

/* -------------------------------------------------------------------------- */
/*  Health state + formatting                                                 */
/* -------------------------------------------------------------------------- */

const health = ref<SidecarHealth | null>(null)
const healthLoading = ref(false)
const healthError = ref<string | null>(null)

const healthRttMs = ref<number | null>(null)
let healthInFlight = false
let healthPollTimer: number | null = null

function clampNonNeg(n: number): number {
    if (!Number.isFinite(n)) return 0
    return Math.max(0, Math.floor(n))
}

function formatAge(ms: number): string {
    const v = clampNonNeg(ms)
    if (v < 1000) return `${v}ms`
    const s = v / 1000
    if (s < 60) return `${s.toFixed(1)}s`
    const m = Math.floor(s / 60)
    const rs = Math.floor(s % 60)
    return `${m}m${String(rs).padStart(2, '0')}s`
}

function formatBytes(n: number): string {
    const v = Math.max(0, Math.floor(n))
    if (v < 1024) return `${v}B`
    const kb = v / 1024
    if (kb < 1024) return `${kb.toFixed(0)}KB`
    const mb = kb / 1024
    return `${mb.toFixed(1)}MB`
}

function formatBps(bps: number): string {
    const v = Math.max(0, Math.floor(bps))
    if (v < 1024) return `${v}B/s`
    const kb = v / 1024
    if (kb < 1024) return `${kb.toFixed(0)}KB/s`
    const mb = kb / 1024
    return `${mb.toFixed(1)}MB/s`
}

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

const captureAgeMs = computed(() => {
    const ms = health.value?.capture?.lastFrameAgeMs
    if (ms == null || !Number.isFinite(ms)) return null
    return clampNonNeg(ms)
})
const formattedCaptureAge = computed(() =>
    captureAgeMs.value == null ? '—' : formatAge(captureAgeMs.value)
)
const captureAgeBucket = computed(() => {
    const ms = captureAgeMs.value
    if (ms == null) return 'unknown'
    if (ms <= 250) return 'ok'
    if (ms <= 1000) return 'warn'
    return 'bad'
})

const streamDiag = computed(() => health.value?.capture?.streamDiag ?? null)

const backlogMs = computed(() => {
    const ms = streamDiag.value?.estBacklogMs
    if (ms == null || !Number.isFinite(ms)) return null
    return clampNonNeg(ms)
})
const formattedBacklog = computed(() => (backlogMs.value == null ? '—' : formatAge(backlogMs.value)))
const backlogBucket = computed(() => {
    const ms = backlogMs.value
    if (ms == null) return 'unknown'
    if (ms <= 250) return 'ok'
    if (ms <= 1000) return 'warn'
    return 'bad'
})

const formattedBuffered = computed(() => {
    const d = streamDiag.value
    if (!d) return '—'
    const ratio = Number.isFinite(d.maxClientBufferedRatio) ? d.maxClientBufferedRatio : 0
    return `${formatBytes(d.maxClientBufferedBytes)} · x${ratio.toFixed(2)}`
})

const formattedDownstream = computed(() => {
    const d = streamDiag.value
    if (!d || d.downstreamBps == null) return '—'
    return formatBps(d.downstreamBps)
})

const formattedBackpressure = computed(() => {
    const d = streamDiag.value
    if (!d) return '—'
    return `${d.backpressureEvents}`
})

const formattedAvgFrame = computed(() => {
    const d = streamDiag.value
    if (!d) return '—'
    const avg = d.avgFrameBytes
    if (avg == null) return `${formatBytes(d.lastFrameBytes)}`
    return `${formatBytes(avg)}`
})

async function loadHealth(opts?: { silent?: boolean }) {
    if (healthInFlight) return
    healthInFlight = true

    const silent = !!opts?.silent
    if (!silent) healthLoading.value = true
    healthError.value = null

    const t0 = performance.now()

    try {
        const res = await fetch(HEALTH_ENDPOINT, {
            method: 'GET',
            headers: { Accept: 'application/json' },
        })

        const t1 = performance.now()
        healthRttMs.value = Math.max(0, Math.round(t1 - t0))

        let json: unknown = null
        try {
            json = await res.json()
        } catch {
            json = null
        }

        if (json && typeof json === 'object') {
            health.value = json as SidecarHealth
        } else if (res.ok) {
            health.value = null
        }

        if (!res.ok) {
            healthError.value = `Sidecar unhealthy (HTTP ${res.status})`
            return
        }

        healthError.value = null
        return
    } catch (err: any) {
        healthError.value = err?.message ? `Failed to load health: ${err.message}` : 'Failed to load health'
        return
    } finally {
        healthInFlight = false
        if (!silent) healthLoading.value = false
    }
}

/* -------------------------------------------------------------------------- */
/*  Auto throttle logic                                                       */
/* -------------------------------------------------------------------------- */

function nextHigherFps(cur: number): number {
    const levels = [2, 4, 8, 15, 20, 30, 60] as const
    for (const lvl of levels) {
        if (cur <= lvl) return lvl
    }
    return levels[levels.length - 1]!
}

function suggestFpsFromDiag(d: SidecarStreamDiag | null): number {
    if (!d) return autoMaxFps.value

    const backlog = Number.isFinite(d.estBacklogMs as any) ? (d.estBacklogMs as number) : 0
    const buffered = Number.isFinite(d.maxClientBufferedBytes as any) ? d.maxClientBufferedBytes : 0
    const ratio = Number.isFinite(d.maxClientBufferedRatio as any) ? d.maxClientBufferedRatio : 0

    if (backlog >= 5000 || buffered >= 64 * MB || ratio >= 64) return 2
    if (backlog >= 3000 || buffered >= 32 * MB || ratio >= 32) return 4
    if (backlog >= 2000 || buffered >= 24 * MB || ratio >= 24) return 8

    if (backlog >= 900 || buffered >= 12 * MB || ratio >= 12) return 15
    if (backlog >= 450 || buffered >= 6 * MB || ratio >= 6) return 20

    if (backlog >= 200 || buffered >= 2 * MB || ratio >= 3) return 30
    return 60
}

function maybeAutoAdjust() {
    if (!enabled.value) return
    if (fpsMode.value !== 'auto') return

    const d = streamDiag.value
    if (!d) return

    const suggested = suggestFpsFromDiag(d)
    const current = autoMaxFps.value

    const backlog = typeof d.estBacklogMs === 'number' ? d.estBacklogMs : 0
    const buffered = typeof d.maxClientBufferedBytes === 'number' ? d.maxClientBufferedBytes : 0
    if (backlog >= 1000 || buffered >= 8 * MB) {
        requestStreamResync('backlog_high')
    }

    if (suggested < current) {
        stableImproveTicks.value = 0
        autoMaxFps.value = suggested
        requestStreamResync('cap_downshift')
        return
    }

    if (suggested > current) {
        stableImproveTicks.value += 1
        if (stableImproveTicks.value >= 5) {
            stableImproveTicks.value = 0
            autoMaxFps.value = nextHigherFps(current)
            requestStreamResync('cap_upshift')
        }
        return
    }

    stableImproveTicks.value = 0
}

watch(
    () => health.value,
    () => {
        maybeAutoAdjust()
    }
)

watch(
    () => fpsMode.value,
    () => {
        if (!enabled.value) return
        requestStreamResync('fps_mode_changed')
    }
)

watch(
    () => effectiveMaxFps.value,
    (next, prev) => {
        if (!enabled.value) return
        if (next === prev) return
        if (fpsMode.value === 'auto') return
        requestStreamResync('max_fps_changed')
    }
)

/* -------------------------------------------------------------------------- */
/*  Polling control                                                           */
/* -------------------------------------------------------------------------- */

function setHealthPollingActive(active: boolean) {
    if (active) {
        if (healthPollTimer != null) return
        void loadHealth({ silent: !showControls.value })
        healthPollTimer = window.setInterval(() => void loadHealth({ silent: true }), 1000)
        return
    }

    if (healthPollTimer != null) window.clearInterval(healthPollTimer)
    healthPollTimer = null
}

function toggleControls() {
    showControls.value = !showControls.value
}

watch(
    () => showControls.value,
    (open) => {
        if (open) void loadHealth({ silent: false })
    }
)

watch(
    [() => enabled.value, () => showControls.value],
    ([en, open]) => {
        setHealthPollingActive(!!en || !!open)
    },
    { immediate: true }
)

function onEnabledChange() {
    if (enabled.value) {
        reloadStream()
    } else {
        if (isCapturing.value || armOnNextFocus.value) releaseCapture()
    }
}

function reloadStream() {
    reloadKey.value++
}

onBeforeUnmount(() => {
    if (isCapturing.value || armOnNextFocus.value || heldModifiers.size > 0) releaseCapture()

    // best-effort: release front panel holds if pane unmounts mid-hold
    if (powerHeldByClient.value) {
        powerHeldByClient.value = false
        sendFrontPanel('powerRelease')
    }
    if (resetHeldByClient.value) {
        resetHeldByClient.value = false
        sendFrontPanel('resetRelease')
    }

    if (wsRetryTimer != null) window.clearInterval(wsRetryTimer)
    if (wsRetryStopTimer != null) window.clearTimeout(wsRetryStopTimer)
    wsRetryTimer = null
    wsRetryStopTimer = null

    if (frameResizeObs) frameResizeObs.disconnect()
    frameResizeObs = null

    if (healthPollTimer != null) window.clearInterval(healthPollTimer)
    healthPollTimer = null
})
</script>

<style scoped>
/* (styles unchanged from your provided file) */
.stream-pane {
    --pane-fg: #111;
    --panel-fg: #e6e6e6;

    --kb-accent: #ef4444;
    --kb-accent-rgb: 239, 68, 68;

    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: 100%;
    width: 100%;
}

.stream-advanced-hotspot {
    position: absolute;
    top: 0;
    right: 0;
    width: 3.2rem;
    height: 2.4rem;
    pointer-events: auto;
    z-index: 30;
}

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

.stream-advanced-hotspot:hover .gear-btn {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
}

.gear-btn:hover {
    background: #1a1a1a;
    transform: translateY(-1px);
}

.slide-fade-enter-active,
.slide-fade-leave-active {
    transition: opacity 180ms ease, transform 180ms ease;
}
.slide-fade-enter-from,
.slide-fade-leave-to {
    opacity: 0;
    transform: translateY(-6px);
}

.controls-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.toolbar {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 8px;
    font-size: 14px;
}

.panel-text span {
    color: var(--panel-fg);
}

.toolbar .left {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
}

.toolbar .controls {
    --control-h: 30px;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}

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

.health-panel {
    margin-top: 4px;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px dashed #4b5563;
    background: #020617;
    display: flex;
    flex-direction: column;
    gap: 6px;
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

.health-note {
    opacity: 0.72;
    line-height: 1.35;
    font-size: 0.72rem;
}

.health-empty {
    opacity: 0.7;
}

/* stack wrapper */
.viewport-stack {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
}

/* viewport owns the background/border area */
.viewport {
    position: relative; /* overlay anchor */
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

.viewport[data-bg='pane'] {
    background: transparent;
    border-color: transparent;
}

.viewport-inner {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
}

.kb-capture-layer {
    position: relative;
    flex: 1;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    outline: none;
    cursor: pointer;
    user-select: none;
    border-radius: 6px;
}

.stream-frame {
    position: relative;
    display: inline-flex;
    align-items: stretch;
    justify-content: stretch;
    background-color: #000;
    border-radius: 6px;
    overflow: hidden;
    flex: 0 0 auto;
}

.stream-img {
    display: block;
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    border-radius: inherit;
    image-rendering: auto;
}

.stream-img[data-scale='fit'] {
    object-fit: contain;
}
.stream-img[data-scale='fill'] {
    object-fit: cover;
}
.stream-img[data-scale='stretch'] {
    object-fit: fill;
}
.stream-img[data-scale='native'] {
    object-fit: none;
}

.kb-glow {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    opacity: 0;
    transition: opacity 120ms ease;
    background-image:
        linear-gradient(to bottom, rgba(var(--kb-accent-rgb), 0.75), rgba(var(--kb-accent-rgb), 0) 15px),
        linear-gradient(to top, rgba(var(--kb-accent-rgb), 0.75), rgba(var(--kb-accent-rgb), 0) 15px),
        linear-gradient(to right, rgba(var(--kb-accent-rgb), 0.75), rgba(var(--kb-accent-rgb), 0) 15px),
        linear-gradient(to left, rgba(var(--kb-accent-rgb), 0.75), rgba(var(--kb-accent-rgb), 0) 15px);
    background-repeat: no-repeat;
    background-size: 100% 15px, 100% 15px, 15px 100%, 15px 100%;
    background-position: top, bottom, left, right;
}

.stream-glow {
    z-index: 2;
}

.capture-glow {
    z-index: 3;
    border-radius: 6px;
}

.kb-capture-layer[data-capturing='true'] .stream-glow {
    opacity: 1;
}
.kb-capture-layer[data-capturing='true'] .capture-glow {
    opacity: 1;
}

.kb-overlay {
    position: absolute;
    left: 50%;
    top: 5px;
    bottom: auto;
    transform: translateX(-50%);
    pointer-events: none;
    z-index: 5;
}

.kb-overlay-inner {
    display: inline-flex;
    align-items: center;
    padding: 4px 10px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: rgba(2, 6, 23, 0.62);
    color: var(--panel-fg);
    font-size: 0.74rem;
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.22);
    backdrop-filter: blur(2px);
}

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

/* -------------------------------------------------------------------------- */
/* Front panel LED overlay indicators                                         */
/* -------------------------------------------------------------------------- */

.frontpanel-leds {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: flex-start;
    min-height: 0;
}

.frontpanel-leds[data-pos='top-right'] {
    justify-content: flex-end;
}

.frontpanel-leds--overlay {
    position: absolute;
    left: 8px;
    right: 8px;
    top: 8px;
    z-index: 6;
    pointer-events: none; /* indicators only */
}

.fp-led-badge {
    --fp-led-rgb: 156, 163, 175; /* fallback gray */
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid #374151;
    background: rgba(2, 6, 23, 0.72);
    color: var(--panel-fg);
    font-size: 0.74rem;
    line-height: 1.3;
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.22);
    backdrop-filter: blur(2px);
}

.fp-led-badge[data-kind='power'] {
    --fp-led-rgb: 34, 197, 94; /* green */
}

.fp-led-badge[data-kind='hdd'] {
    --fp-led-rgb: 249, 115, 22; /* orange */
}

.fp-led-badge .dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    display: inline-block;
    background: rgba(148, 163, 184, 0.25);
    opacity: 0.55;
    box-shadow: none;
    transform-origin: center;
}

/* On */
.fp-led-badge[data-mode='on'] .dot {
    background: rgb(var(--fp-led-rgb));
    opacity: 1;
    box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.9), 0 0 10px rgba(var(--fp-led-rgb), 0.35);
}

/* Blink */
@keyframes fp-led-blink {
    0%,
    49% {
        opacity: 1;
    }
    50%,
    100% {
        opacity: 0.15;
    }
}

.fp-led-badge[data-mode='blink'] .dot,
.fp-led-badge[data-mode='blink-fast'] .dot {
    background: rgb(var(--fp-led-rgb));
    box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.9), 0 0 10px rgba(var(--fp-led-rgb), 0.35);
    animation: fp-led-blink 1s steps(2, end) infinite;
}

.fp-led-badge[data-mode='blink-fast'] .dot {
    animation-duration: 350ms;
}

/* Pulse (sleep-ish) */
@keyframes fp-led-pulse {
    0% {
        opacity: 0.22;
        transform: scale(1);
    }
    50% {
        opacity: 1;
        transform: scale(1.35);
    }
    100% {
        opacity: 0.22;
        transform: scale(1);
    }
}

.fp-led-badge[data-mode='pulse'] .dot {
    background: rgb(var(--fp-led-rgb));
    box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.9), 0 0 10px rgba(var(--fp-led-rgb), 0.35);
    animation: fp-led-pulse 900ms ease-in-out infinite;
    opacity: 1;
}

/* -------------------------------------------------------------------------- */
/* Front panel overlay controls                                               */
/* -------------------------------------------------------------------------- */

.frontpanel-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: flex-start;
    min-height: 0;
}
.frontpanel-controls[data-pos='bottom-right'] {
    justify-content: flex-end;
}

/* THIS is the missing piece: actually anchor the controls to the viewport bottom,
   while still letting the select drive left vs right alignment. */
.frontpanel-controls--overlay {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 8px;
    z-index: 6;

    /* Don’t steal mouse events from the capture layer except on the buttons themselves. */
    pointer-events: none;
}
.frontpanel-controls--overlay .fp-btn {
    pointer-events: auto;
}

.fp-btn {
    --control-h: 28px;

    height: var(--control-h);
    line-height: var(--control-h);
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid #374151;
    background: #020617;
    color: var(--panel-fg);
    cursor: pointer;
    font-size: 0.76rem;
    font-weight: 500;
    text-align: center;
    transition:
        background 120ms ease,
        border-color 120ms ease,
        transform 60ms ease,
        box-shadow 120ms ease,
        opacity 120ms ease;
    user-select: none;
    white-space: nowrap;
}

.fp-btn:hover:not(:disabled) {
    background: #030712;
    border-color: #4b5563;
    transform: translateY(-1px);
}

.fp-btn:disabled {
    opacity: 0.5;
    cursor: default;
}

/* Optional: subtle “active/held” state that still fits the btn style */
.fp-btn[data-held='true'] {
    border-color: #4b5563;
    background: #0b1120;
    box-shadow: none;
}
</style>
