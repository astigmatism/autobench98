<!-- apps/web/src/panes/PS2KeyboardTestPane.vue -->
<template>
    <div class="kb-pane" :style="{ '--pane-fg': paneFg, '--panel-fg': panelFg }">
        <div class="panel">
            <!-- Header: title + status -->
            <div class="panel-head">
                <div class="panel-title-group">
                    <span class="panel-title">PS/2 Keyboard Test</span>
                    <span class="panel-subtitle">
                        Click the capture box to arm input · Exit with <b>Ctrl+Esc</b>
                    </span>
                </div>

                <span
                    class="status-badge"
                    :data-status="statusKind"
                    :data-capturing="isCapturing ? 'true' : 'false'"
                >
                    <span class="dot"></span>
                    <span class="label">{{ statusLabel }}</span>
                </span>
            </div>

            <!-- Device details -->
            <div class="device-row">
                <div class="device-kv">
                    <span class="k">Device</span>
                    <span class="v">{{ deviceName }}</span>
                </div>
                <div class="device-kv">
                    <span class="k">Phase</span>
                    <span class="v">{{ kbPhase }}</span>
                </div>
                <div class="device-kv">
                    <span class="k">Power</span>
                    <span class="v">{{ kbPower }}</span>
                </div>
                <div class="device-kv">
                    <span class="k">Queue</span>
                    <span class="v">{{ kbQueueDepth }}</span>
                </div>
            </div>

            <!-- Capture box -->
            <div class="capture-wrap">
                <div class="capture-head">
                    <div class="capture-title">
                        <span class="pill" :data-on="isCapturing ? 'true' : 'false'">
                            {{ isCapturing ? 'CAPTURING' : 'INACTIVE' }}
                        </span>
                        <span class="hint">
                            {{
                                isCapturing
                                    ? 'Keys will be sent to the PS/2 simulator.'
                                    : 'Click inside to start capturing.'
                            }}
                        </span>
                    </div>

                    <div class="capture-actions">
                        <button
                            class="btn"
                            type="button"
                            :disabled="!canCapture"
                            @click="toggleCapture()"
                            :title="!canCapture ? 'Device not ready' : isCapturing ? 'Release capture' : 'Start capture'"
                        >
                            {{ isCapturing ? 'Release' : 'Capture' }}
                        </button>

                        <button class="btn" type="button" @click="clearLog">Clear log</button>
                    </div>
                </div>

                <div
                    ref="captureRef"
                    class="capture-box"
                    tabindex="0"
                    role="button"
                    :aria-pressed="isCapturing ? 'true' : 'false'"
                    :data-capturing="isCapturing ? 'true' : 'false'"
                    @mousedown.prevent="armCaptureFromMouse"
                    @focus="onFocusCapture"
                    @blur="onBlurCapture"
                    @keydown="onKeyDown"
                    @keyup="onKeyUp"
                >
                    <div class="capture-inner">
                        <div class="capture-line">
                            <span class="label">Last key:</span>
                            <span class="value">{{ lastKeyDisplay }}</span>
                        </div>

                        <div class="capture-line">
                            <span class="label">Mode:</span>
                            <label class="radio">
                                <input type="radio" value="press" v-model="sendMode" />
                                <span>press (keydown only)</span>
                            </label>
                            <label class="radio">
                                <input type="radio" value="holdRelease" v-model="sendMode" />
                                <span>hold/release (down+up)</span>
                            </label>
                        </div>

                        <div class="capture-line">
                            <label class="check">
                                <input type="checkbox" v-model="allowRepeat" />
                                <span>allow key repeat</span>
                            </label>

                            <label class="check">
                                <input type="checkbox" v-model="preventBrowserShortcuts" />
                                <span>prevent browser shortcuts while capturing</span>
                            </label>
                        </div>

                        <div class="capture-note" v-if="!wsAvailable">
                            ⚠️ No WS sender detected in this build. The pane will still log keys locally,
                            but won’t send commands to the orchestrator until the app exposes a WS client.
                        </div>
                    </div>
                </div>
            </div>

            <!-- Command buttons -->
            <div class="commands">
                <div class="commands-title">Device controls</div>
                <div class="commands-row">
                    <button class="btn" type="button" :disabled="!wsAvailable" @click="sendPower('on')">
                        Power On
                    </button>
                    <button class="btn" type="button" :disabled="!wsAvailable" @click="sendPower('off')">
                        Power Off
                    </button>
                    <button class="btn" type="button" :disabled="!wsAvailable" @click="sendCancelAll()">
                        Cancel Queue
                    </button>
                </div>
            </div>

            <!-- Local event log -->
            <div class="log">
                <div class="log-head">
                    <span class="log-title">Key events (local)</span>
                    <span class="log-meta">{{ eventLog.length }} entries</span>
                </div>

                <div class="log-body">
                    <div v-if="eventLog.length === 0" class="empty">
                        No keys captured yet.
                    </div>

                    <div v-for="(e, i) in eventLog" :key="`${e.at}-${i}`" class="log-row">
                        <span class="t">{{ fmtTime(e.at) }}</span>
                        <span class="k">{{ e.kind }}</span>
                        <span class="m">
                            code=<b>{{ e.code }}</b>
                            <span v-if="e.key"> key={{ e.key }}</span>
                            <span v-if="e.mods.length"> mods={{ e.mods.join('+') }}</span>
                            <span v-if="e.repeat"> repeat</span>
                        </span>
                    </div>
                </div>
            </div>

            <div class="foot">
                Release capture with <b>Ctrl+Esc</b>.
                While capturing, the pane can optionally block browser shortcuts.
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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

type KbPanePrefs = {
    sendMode?: 'press' | 'holdRelease'
    allowRepeat?: boolean
    preventBrowserShortcuts?: boolean
}

const props = defineProps<{
    pane?: PaneInfo
    __kbPaneUi?: KbPanePrefs
    __kbPaneProfileRev?: number
}>()

function isObject(x: any): x is Record<string, unknown> {
    return x !== null && typeof x === 'object' && !Array.isArray(x)
}

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

const panelFg = '#e6e6e6'

/* -------------------------------------------------------------------------- */
/*  Mirror slice: ps2Keyboard                                                 */
/* -------------------------------------------------------------------------- */

const mirror = useMirror()

type PS2KeyboardMirrorSlice = {
    phase?: string
    power?: string
    device?: { id?: string; path?: string; baudRate?: number } | null
    queueDepth?: number
    lastError?: { message?: string } | null
}

const kb = computed<PS2KeyboardMirrorSlice>(() => {
    const root = mirror.data as any
    return (root?.ps2Keyboard ?? {}) as PS2KeyboardMirrorSlice
})

const kbPhase = computed(() => String(kb.value.phase ?? 'unknown'))
const kbPower = computed(() => String(kb.value.power ?? 'unknown'))
const kbQueueDepth = computed(() => {
    const n = Number((kb.value as any)?.queueDepth)
    return Number.isFinite(n) ? String(n) : '—'
})

const deviceName = computed(() => {
    const dev = kb.value.device ?? null
    const path = (dev as any)?.path
    const id = (dev as any)?.id
    if (typeof path === 'string' && path.trim()) return path.trim()
    if (typeof id === 'string' && id.trim()) return id.trim()
    return '—'
})

const deviceReady = computed(() => {
    const p = kbPhase.value.toLowerCase()
    return p === 'ready' || p === 'connected' || p === 'identifying'
})

/* -------------------------------------------------------------------------- */
/*  Status badge                                                              */
/* -------------------------------------------------------------------------- */

const isCapturing = ref(false)

const statusKind = computed(() => {
    const phase = kbPhase.value.toLowerCase()

    if (!deviceReady.value) {
        if (phase.includes('error')) return 'error'
        if (phase.includes('lost') || phase.includes('disconnect')) return 'disconnected'
        return 'disconnected'
    }

    if (isCapturing.value) return 'capturing'
    if (phase === 'identifying') return 'busy'
    return 'ready'
})

const statusLabel = computed(() => {
    const phase = kbPhase.value.toLowerCase()

    if (!deviceReady.value) {
        if (phase.includes('error')) return 'Error'
        return 'Disconnected'
    }

    if (isCapturing.value) return 'Capturing'
    if (phase === 'identifying') return 'Identifying…'
    return 'Ready'
})

const canCapture = computed(() => deviceReady.value)

/* -------------------------------------------------------------------------- */
/*  WS sender detection + send helpers                                        */
/* -------------------------------------------------------------------------- */

const wsSender = ref<any | null>(null)

function detectWsSender(): any | null {
    const m = mirror as any

    // If your mirror store exposes a client, grab it.
    if (m?.wsClient) return m.wsClient
    if (m?.ws) return m.ws

    // Dev convenience fallback
    const w = window as any
    if (w?.__wsClient) return w.__wsClient

    return null
}

const wsAvailable = computed(() => !!wsSender.value)

function refreshWsSender() {
    wsSender.value = detectWsSender()
}

onMounted(() => {
    // Try immediately, then keep trying briefly (covers “attached after mount”).
    refreshWsSender()

    const t = window.setInterval(() => {
        if (wsSender.value) {
            window.clearInterval(t)
            return
        }
        refreshWsSender()
    }, 250)

    // Safety stop after a few seconds
    window.setTimeout(() => window.clearInterval(t), 5000)
})

function trySend(obj: any) {
    const sender = wsSender.value
    if (!sender) return false

    // Prefer your typed helper
    if (typeof sender.sendPs2KeyboardCommand === 'function') {
        sender.sendPs2KeyboardCommand(obj.payload)
        return true
    }

    // Otherwise generic send
    if (typeof sender.send === 'function') {
        sender.send(obj)
        return true
    }

    return false
}

function sendKey(
    action: 'press' | 'hold' | 'release',
    code: string,
    key?: string,
    mods: string[] = [],
    repeat = false
) {
    trySend({
        type: 'ps2-keyboard.command',
        payload: {
            kind: 'key',
            action,
            code,
            key,
            requestedBy: 'ps2KeyboardTestPane',
            overrides: { mods, repeat },
        },
    })
}

function sendPower(state: 'on' | 'off') {
    trySend({
        type: 'ps2-keyboard.command',
        payload: { kind: 'power', state, requestedBy: 'ps2KeyboardTestPane' },
    })
}

function sendCancelAll() {
    trySend({
        type: 'ps2-keyboard.command',
        payload: { kind: 'cancelAll', reason: 'user', requestedBy: 'ps2KeyboardTestPane' },
    })
}

/* -------------------------------------------------------------------------- */
/*  Capture box behavior                                                      */
/* -------------------------------------------------------------------------- */

const captureRef = ref<HTMLElement | null>(null)
const sendMode = ref<'press' | 'holdRelease'>('press')
const allowRepeat = ref(false)
const preventBrowserShortcuts = ref(true)

const lastKeyDisplay = ref('—')

/**
 * IMPORTANT: Focus is NOT the same as capturing.
 * We only enter capture mode when user explicitly arms it (mouse click / button).
 * This prevents "Release" from instantly re-arming due to focus churn.
 */
const armOnNextFocus = ref(false)

function focusCaptureBox() {
    // Focusing can sometimes happen async; keep intent until focus fires.
    captureRef.value?.focus()
}

function armCaptureFromMouse() {
    if (!canCapture.value) return
    armOnNextFocus.value = true
    focusCaptureBox()
}

function toggleCapture() {
    if (!canCapture.value) return
    if (isCapturing.value) {
        releaseCapture()
    } else {
        armOnNextFocus.value = true
        focusCaptureBox()
    }
}

function releaseCapture() {
    isCapturing.value = false
    armOnNextFocus.value = false

    // Blur the capture box specifically (blurring document.activeElement can be the button).
    try {
        captureRef.value?.blur?.()
    } catch {
        // ignore
    }
}

function onFocusCapture() {
    if (!canCapture.value) return

    // Only start capturing if user explicitly armed.
    if (armOnNextFocus.value) {
        isCapturing.value = true
        // Keep capture active while focused, but we don't need to keep "arm" sticky forever.
        armOnNextFocus.value = false
    }
}

function onBlurCapture() {
    // Losing focus should drop capture (so keys don’t “leak” unexpectedly).
    isCapturing.value = false
    armOnNextFocus.value = false
}

function isReleaseCombo(e: KeyboardEvent): boolean {
    // Release capture ONLY on Ctrl + Escape.
    // Plain Escape must pass through to the PS/2 keyboard (Win98 uses it heavily).
    return e.code === 'Escape' && e.ctrlKey
}

function modsOf(e: KeyboardEvent): string[] {
    const mods: string[] = []
    if (e.ctrlKey) mods.push('Ctrl')
    if (e.altKey) mods.push('Alt')
    if (e.shiftKey) mods.push('Shift')
    if (e.metaKey) mods.push('Meta')
    return mods
}

function maybeBlockBrowser(e: KeyboardEvent) {
    if (!isCapturing.value) return
    if (!preventBrowserShortcuts.value) return
    e.preventDefault()
    e.stopPropagation()
}

function onKeyDown(e: KeyboardEvent) {
    if (!isCapturing.value) return

    // release control combo
    if (isReleaseCombo(e)) {
        maybeBlockBrowser(e)
        pushLog('release', e)
        lastKeyDisplay.value = 'Ctrl+Escape (release capture)'
        releaseCapture()
        return
    }

    if (!allowRepeat.value && e.repeat) {
        pushLog('keydown', e, true)
        lastKeyDisplay.value = `${e.code} (repeat ignored)`
        maybeBlockBrowser(e)
        return
    }

    pushLog('keydown', e)
    lastKeyDisplay.value = `${e.code}${e.key ? ` · key="${e.key}"` : ''}`

    if (!wsAvailable.value) {
        maybeBlockBrowser(e)
        return
    }

    const code = e.code || ''
    if (!code) {
        maybeBlockBrowser(e)
        return
    }

    if (sendMode.value === 'press') {
        sendKey('press', code, e.key, modsOf(e), e.repeat)
    } else {
        sendKey('hold', code, e.key, modsOf(e), e.repeat)
    }

    maybeBlockBrowser(e)
}

function onKeyUp(e: KeyboardEvent) {
    if (!isCapturing.value) return
    pushLog('keyup', e)

    if (!wsAvailable.value) {
        maybeBlockBrowser(e)
        return
    }

    if (sendMode.value !== 'holdRelease') {
        maybeBlockBrowser(e)
        return
    }

    const code = e.code || ''
    if (!code) {
        maybeBlockBrowser(e)
        return
    }

    sendKey('release', code, e.key, modsOf(e), e.repeat)
    maybeBlockBrowser(e)
}

/* -------------------------------------------------------------------------- */
/*  Local event log                                                           */
/* -------------------------------------------------------------------------- */

type LogEvt = {
    at: number
    kind: 'keydown' | 'keyup' | 'release'
    code: string
    key?: string
    mods: string[]
    repeat: boolean
}

const eventLog = ref<LogEvt[]>([])
const MAX_LOG = 80

function pushLog(kind: LogEvt['kind'], e: KeyboardEvent, forceRepeat?: boolean) {
    const row: LogEvt = {
        at: Date.now(),
        kind,
        code: e.code || '(no-code)',
        key: e.key,
        mods: modsOf(e),
        repeat: forceRepeat ? true : !!e.repeat,
    }
    eventLog.value.unshift(row)
    if (eventLog.value.length > MAX_LOG) eventLog.value.length = MAX_LOG
}

function clearLog() {
    eventLog.value = []
    lastKeyDisplay.value = '—'
}

function fmtTime(ts: number) {
    const d = new Date(ts)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    const ms = String(d.getMilliseconds()).padStart(3, '0')
    return `${hh}:${mm}:${ss}.${ms}`
}

/* -------------------------------------------------------------------------- */
/*  Pref persistence (simple, localStorage per pane id)                        */
/* -------------------------------------------------------------------------- */

const paneId = computed(() => String(props.pane?.id ?? '').trim())
const STORAGE_PREFIX = 'kb:pane:ui:'
const storageKey = computed(() => (paneId.value ? `${STORAGE_PREFIX}${paneId.value}` : ''))

function readPrefs(): KbPanePrefs | null {
    const key = storageKey.value
    if (!key) return null
    try {
        const raw = localStorage.getItem(key)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? (parsed as KbPanePrefs) : null
    } catch {
        return null
    }
}

function writePrefs() {
    const key = storageKey.value
    if (!key) return
    try {
        localStorage.setItem(
            key,
            JSON.stringify({
                sendMode: sendMode.value,
                allowRepeat: !!allowRepeat.value,
                preventBrowserShortcuts: !!preventBrowserShortcuts.value,
            } satisfies KbPanePrefs)
        )
    } catch {
        // ignore
    }
}

function applyPrefs(p: KbPanePrefs | null | undefined) {
    if (!p) return
    if (p.sendMode === 'press' || p.sendMode === 'holdRelease') sendMode.value = p.sendMode
    if (typeof p.allowRepeat === 'boolean') allowRepeat.value = p.allowRepeat
    if (typeof p.preventBrowserShortcuts === 'boolean')
        preventBrowserShortcuts.value = p.preventBrowserShortcuts
}

watch([paneId, () => props.__kbPaneUi, () => props.__kbPaneProfileRev], () => {
    if (isObject(props.__kbPaneUi)) {
        applyPrefs(props.__kbPaneUi as KbPanePrefs)
        writePrefs()
        return
    }
    const stored = readPrefs()
    if (stored) applyPrefs(stored)
}, { immediate: true })

watch([sendMode, allowRepeat, preventBrowserShortcuts], () => writePrefs())

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

onMounted(() => {
    watch(
        () => deviceReady.value,
        (ready) => {
            if (!ready && isCapturing.value) {
                releaseCapture()
            }
        },
        { immediate: true }
    )
})

onBeforeUnmount(() => {
    releaseCapture()
})
</script>

<style scoped>
/* (CSS unchanged from your provided file) */
.kb-pane {
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

.panel {
    background: #020617;
    border: 1px solid #1f2933;
    border-radius: 8px;
    padding: 10px;
    color: var(--panel-fg);
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    flex: 1 1 0%;
    min-height: 0;
}

.panel-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
}

.panel-title-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

.panel-title {
    font-weight: 600;
    font-size: 0.85rem;
}

.panel-subtitle {
    font-size: 0.72rem;
    opacity: 0.85;
}

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
    user-select: none;
    white-space: nowrap;
}

.status-badge .dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: #9ca3af;
}

/* status colors */
.status-badge[data-status='disconnected'] { border-color: #4b5563; background: #020617; }
.status-badge[data-status='disconnected'] .dot { background: #6b7280; }

.status-badge[data-status='error'] { border-color: #ef4444; background: #450a0a; }
.status-badge[data-status='error'] .dot { background: #ef4444; }

.status-badge[data-status='busy'] { border-color: #facc15; background: #3b2900; }
.status-badge[data-status='busy'] .dot { background: #facc15; animation: pulse-dot 900ms ease-in-out infinite; }

.status-badge[data-status='ready'] { border-color: #22c55e; background: #022c22; }
.status-badge[data-status='ready'] .dot { background: #22c55e; }

/* CAPTURING → green (like ready) but keep pulsing */
.status-badge[data-status='capturing'] {
    border-color: #22c55e;
    background: #022c22;
}
.status-badge[data-status='capturing'] .dot {
    background: #22c55e;
    animation: pulse-dot 900ms ease-in-out infinite;
}

@keyframes pulse-dot {
    0% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.35); opacity: 0.4; }
    100% { transform: scale(1); opacity: 1; }
}

.device-row {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    border: 1px dashed #334155;
    border-radius: 8px;
    padding: 8px;
    background: rgba(2, 6, 23, 0.6);
}

.device-kv {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

.device-kv .k {
    font-size: 0.68rem;
    opacity: 0.8;
}

.device-kv .v {
    font-size: 0.76rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.capture-wrap {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.capture-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.capture-title {
    display: flex;
    align-items: center;
    gap: 8px;
}

.pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid #334155;
    background: #0b1220;
    font-size: 0.72rem;
    letter-spacing: 0.02em;
}
.pill[data-on='true'] {
    border-color: #38bdf8;
    background: rgba(56, 189, 248, 0.12);
}

.hint {
    font-size: 0.72rem;
    opacity: 0.85;
}

.capture-actions {
    display: flex;
    gap: 8px;
}

.capture-box {
    border: 1px solid #334155;
    border-radius: 10px;
    background: rgba(2, 6, 23, 0.7);
    padding: 10px;
    outline: none;
    cursor: pointer;
    user-select: none;
}

.capture-box:focus {
    border-color: #38bdf8;
    box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.15);
}

.capture-box[data-capturing='true'] {
    border-color: #38bdf8;
    background: rgba(56, 189, 248, 0.06);
}

.capture-inner {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.capture-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    font-size: 0.78rem;
}

.capture-line .label {
    opacity: 0.85;
}

.capture-line .value {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
}

.radio, .check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.75rem;
    opacity: 0.95;
}

.capture-note {
    font-size: 0.72rem;
    opacity: 0.9;
    padding: 8px;
    border-radius: 8px;
    border: 1px dashed #f59e0b;
    background: rgba(245, 158, 11, 0.08);
}

.commands {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.commands-title {
    font-size: 0.75rem;
    opacity: 0.9;
    font-weight: 600;
}

.commands-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.btn {
    border: 1px solid #4b5563;
    background: #020617;
    color: #e5e7eb;
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 0.75rem;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease, transform 60ms ease;
}
.btn:hover {
    background: #111827;
    border-color: #9ca3af;
    transform: translateY(-0.5px);
}
.btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
}

.log {
    border: 1px solid #334155;
    border-radius: 10px;
    background: rgba(2, 6, 23, 0.55);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1 1 auto;
    min-height: 0;
}

.log-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
}

.log-title {
    font-size: 0.78rem;
    font-weight: 600;
}
.log-meta {
    font-size: 0.7rem;
    opacity: 0.8;
}

.log-body {
    overflow: auto;
    border-top: 1px dashed #334155;
    padding-top: 6px;
    min-height: 0;
}

.empty {
    padding: 10px;
    font-size: 0.75rem;
    opacity: 0.85;
    text-align: center;
}

.log-row {
    display: grid;
    grid-template-columns: 110px 70px 1fr;
    gap: 10px;
    font-size: 0.74rem;
    padding: 4px 2px;
    border-bottom: 1px solid rgba(51, 65, 85, 0.35);
}

.log-row .t {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
    opacity: 0.9;
}
.log-row .k {
    font-weight: 600;
    opacity: 0.9;
}
.log-row .m {
    opacity: 0.95;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.foot {
    font-size: 0.72rem;
    opacity: 0.8;
}

@media (max-width: 720px) {
    .panel-head {
        flex-direction: column;
        align-items: flex-start;
    }
    .device-row {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .log-row {
        grid-template-columns: 90px 60px 1fr;
    }
}
</style>
