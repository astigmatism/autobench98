<template>
    <div class="screen-match-pane" :style="{ '--pane-fg': paneFg, '--panel-fg': panelFg }">
        <div class="panel">
            <div class="panel-head">
                <div class="panel-title-group">
                    <span class="panel-title">Screen Matching Test</span>
                    <span class="panel-subtitle">SSIM diagnostics for captured Windows 98 frames</span>
                </div>

                <span class="status-badge" :data-status="overallStatus">
                    <span class="dot"></span>
                    <span class="label">{{ overallStatusLabel }}</span>
                </span>
            </div>

            <div class="panel-body">
                <section class="match-card">
                    <div class="card-head">
                        <div>
                            <h3>Static screen detection</h3>
                            <p>Compares the current captured frame against the previous check.</p>
                        </div>
                        <div class="actions">
                            <label class="live-toggle">
                                <input v-model="liveStatic" type="checkbox" />
                                <span>Poll every {{ STATIC_POLL_SECONDS }}s</span>
                            </label>
                            <button class="btn" type="button" :disabled="staticLoading" @click="checkStatic">
                                {{ staticLoading ? 'Checking…' : 'Check now' }}
                            </button>
                            <button class="btn secondary" type="button" :disabled="staticLoading" @click="resetStaticHistory">
                                Reset previous
                            </button>
                        </div>
                    </div>

                    <div v-if="staticError" class="error-box">{{ staticError }}</div>

                    <div class="result-grid">
                        <div class="metric">
                            <span class="metric-label">Status</span>
                            <strong :data-result="staticStatusKind">{{ staticStatusLabel }}</strong>
                        </div>
                        <div class="metric">
                            <span class="metric-label">SSIM score</span>
                            <strong>{{ formatScore(staticResult?.score) }}</strong>
                        </div>
                        <div class="metric">
                            <span class="metric-label">Threshold</span>
                            <strong>{{ formatScore(staticResult?.threshold ?? config?.staticThreshold) }}</strong>
                        </div>
                        <div class="metric">
                            <span class="metric-label">Last checked</span>
                            <strong>{{ formatDate(staticResult?.checkedAt) }}</strong>
                        </div>
                    </div>

                    <div class="fine-print">
                        <span>Previous frame available: {{ staticResult?.previousFrameAvailable ? 'yes' : 'no' }}</span>
                        <span v-if="staticResult?.currentFrameAgeMs != null">
                            Current frame age: {{ Math.round(staticResult.currentFrameAgeMs) }} ms
                        </span>
                    </div>
                </section>

                <section class="match-card">
                    <div class="card-head">
                        <div>
                            <h3>Reference image match</h3>
                            <p>Compares the current captured frame against a stored server-side reference image.</p>
                        </div>
                        <div class="actions">
                            <button class="btn secondary" type="button" :disabled="referencesLoading" @click="loadReferences">
                                {{ referencesLoading ? 'Loading…' : 'Refresh references' }}
                            </button>
                            <button class="btn" type="button" :disabled="referenceLoading || !referenceName" @click="compareReference">
                                {{ referenceLoading ? 'Comparing…' : 'Compare' }}
                            </button>
                        </div>
                    </div>

                    <div class="form-grid">
                        <label class="field">
                            <span>Reference image</span>
                            <select v-if="references.length > 0" v-model="selectedReference">
                                <option value="">Manual entry…</option>
                                <option v-for="item in references" :key="item.name" :value="item.name">
                                    {{ item.name }}
                                </option>
                            </select>
                            <input
                                v-else
                                v-model="referenceInput"
                                type="text"
                                spellcheck="false"
                                placeholder="windows98-desktop.png"
                            />
                        </label>

                        <label v-if="references.length > 0" class="field">
                            <span>Manual reference path</span>
                            <input
                                v-model="referenceInput"
                                type="text"
                                spellcheck="false"
                                placeholder="Used when selector is Manual entry"
                            />
                        </label>

                        <label class="field narrow">
                            <span>Threshold</span>
                            <input
                                v-model="thresholdInput"
                                type="number"
                                min="0"
                                max="1"
                                step="0.001"
                                inputmode="decimal"
                            />
                        </label>
                    </div>

                    <div class="fine-print">
                        <span>Reference dir: {{ config?.referenceDir ?? 'not loaded' }}</span>
                        <span>{{ references.length }} image{{ references.length === 1 ? '' : 's' }} listed</span>
                    </div>

                    <div v-if="referenceError" class="error-box">{{ referenceError }}</div>

                    <div class="result-grid">
                        <div class="metric">
                            <span class="metric-label">Status</span>
                            <strong :data-result="referenceStatusKind">{{ referenceStatusLabel }}</strong>
                        </div>
                        <div class="metric">
                            <span class="metric-label">SSIM score</span>
                            <strong>{{ formatScore(referenceResult?.score) }}</strong>
                        </div>
                        <div class="metric">
                            <span class="metric-label">Threshold</span>
                            <strong>{{ formatScore(referenceResult?.threshold ?? config?.defaultReferenceThreshold) }}</strong>
                        </div>
                        <div class="metric">
                            <span class="metric-label">Last checked</span>
                            <strong>{{ formatDate(referenceResult?.checkedAt) }}</strong>
                        </div>
                    </div>

                    <div v-if="referenceResult" class="fine-print">
                        <span>Reference: {{ referenceResult.referenceImage }}</span>
                        <span v-if="referenceResult.currentFrameAgeMs != null">
                            Current frame age: {{ Math.round(referenceResult.currentFrameAgeMs) }} ms
                        </span>
                    </div>
                </section>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

type Direction = 'row' | 'col'
type Constraints = {
    widthPx?: number | null
    heightPx?: number | null
    widthPct?: number | null
    heightPct?: number | null
}
type Appearance = {
    bg?: string | null
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

type PublicConfig = {
    staticThreshold: number
    defaultReferenceThreshold: number
    referenceDir: string
}

type StaticScreenCheckResult = {
    isStatic: boolean
    score: number | null
    threshold: number
    previousFrameAvailable: boolean
    currentFrameCapturedAt: string
    currentFrameAgeMs?: number
    checkedAt: string
}

type ReferenceImageEntry = {
    name: string
    sizeBytes: number
    modifiedAt: string
}

type ReferenceScreenMatchResult = {
    matched: boolean
    score: number
    threshold: number
    referenceImage: string
    currentFrameCapturedAt: string
    currentFrameAgeMs?: number
    checkedAt: string
}

type ApiError = {
    ok: false
    error: {
        code: string
        message: string
        detail?: Record<string, unknown>
    }
}

type ApiSuccess<T extends object> = T & { ok: true }

const STATIC_POLL_SECONDS = 5

const props = defineProps<{
    pane?: PaneInfo
}>()

const panelFg = '#e6e6e6'
const config = ref<PublicConfig | null>(null)
const references = ref<ReferenceImageEntry[]>([])
const referencesLoading = ref(false)
const staticLoading = ref(false)
const referenceLoading = ref(false)
const staticError = ref<string | null>(null)
const referenceError = ref<string | null>(null)
const staticResult = ref<StaticScreenCheckResult | null>(null)
const referenceResult = ref<ReferenceScreenMatchResult | null>(null)
const selectedReference = ref('')
const referenceInput = ref('')
const thresholdInput = ref('')
const liveStatic = ref(false)
let staticPollHandle: number | null = null

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
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
    return 0.2126 * srgbToLinear(rgb.r) + 0.7152 * srgbToLinear(rgb.g) + 0.0722 * srgbToLinear(rgb.b)
}

function contrastRatio(l1: number, l2: number): number {
    const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1]
    return (lighter + 0.05) / (darker + 0.05)
}

const paneFg = computed(() => {
    const bg = props.pane?.appearance?.bg ?? '#ffffff'
    const backgroundLum = relLuminance(bg)
    const whiteContrast = contrastRatio(relLuminance('#ffffff'), backgroundLum)
    const blackContrast = contrastRatio(relLuminance('#000000'), backgroundLum)
    return whiteContrast >= blackContrast ? '#ffffff' : '#111111'
})

const referenceName = computed(() => {
    return (selectedReference.value || referenceInput.value).trim()
})

const overallStatus = computed(() => {
    if (staticLoading.value || referenceLoading.value || referencesLoading.value) return 'busy'
    if (staticError.value || referenceError.value) return 'error'
    return 'ready'
})

const overallStatusLabel = computed(() => {
    if (overallStatus.value === 'busy') return 'busy'
    if (overallStatus.value === 'error') return 'error'
    return 'ready'
})

const staticStatusKind = computed(() => {
    if (!staticResult.value) return 'unknown'
    if (!staticResult.value.previousFrameAvailable) return 'unknown'
    return staticResult.value.isStatic ? 'matched' : 'not-matched'
})

const staticStatusLabel = computed(() => {
    if (!staticResult.value) return 'not checked'
    if (!staticResult.value.previousFrameAvailable) return 'needs previous frame'
    return staticResult.value.isStatic ? 'static' : 'not static'
})

const referenceStatusKind = computed(() => {
    if (!referenceResult.value) return 'unknown'
    return referenceResult.value.matched ? 'matched' : 'not-matched'
})

const referenceStatusLabel = computed(() => {
    if (!referenceResult.value) return 'not checked'
    return referenceResult.value.matched ? 'matched' : 'no match'
})

async function apiJson<T extends object>(
    url: string,
    init?: RequestInit
): Promise<ApiSuccess<T>> {
    const headers = new Headers(init?.headers)
    headers.set('accept', 'application/json')
    const res = await fetch(url, {
        ...init,
        headers,
    })
    const data = (await res.json().catch(() => null)) as ApiSuccess<T> | ApiError | null

    if (!res.ok || !data || data.ok !== true) {
        const message = data && data.ok === false
            ? `${data.error.message} (${data.error.code})`
            : `Request failed with HTTP ${res.status}`
        throw new Error(message)
    }

    return data
}

async function loadConfig(): Promise<void> {
    const data = await apiJson<{ config: PublicConfig }>('/api/screen-matching/config')
    config.value = data.config
    if (!thresholdInput.value) thresholdInput.value = String(data.config.defaultReferenceThreshold)
}

async function loadReferences(): Promise<void> {
    referencesLoading.value = true
    referenceError.value = null
    try {
        const data = await apiJson<{ items: ReferenceImageEntry[] }>('/api/screen-matching/references')
        references.value = data.items
        if (data.items.length === 0) {
            selectedReference.value = ''
        } else if (!data.items.some((item) => item.name === selectedReference.value) && !referenceInput.value) {
            selectedReference.value = data.items[0]?.name ?? ''
        }
    } catch (err) {
        referenceError.value = err instanceof Error ? err.message : String(err)
    } finally {
        referencesLoading.value = false
    }
}

async function checkStatic(): Promise<void> {
    staticLoading.value = true
    staticError.value = null
    try {
        const data = await apiJson<{ result: StaticScreenCheckResult }>('/api/screen-matching/static')
        staticResult.value = data.result
    } catch (err) {
        staticError.value = err instanceof Error ? err.message : String(err)
    } finally {
        staticLoading.value = false
    }
}

async function resetStaticHistory(): Promise<void> {
    staticLoading.value = true
    staticError.value = null
    try {
        await apiJson<Record<string, unknown>>('/api/screen-matching/static/reset', { method: 'POST' })
        staticResult.value = null
    } catch (err) {
        staticError.value = err instanceof Error ? err.message : String(err)
    } finally {
        staticLoading.value = false
    }
}

function parseReferenceThreshold(): number | undefined {
    const raw = thresholdInput.value.trim()
    if (!raw) return undefined
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error('Reference threshold must be a number between 0 and 1.')
    }
    return value
}

async function compareReference(): Promise<void> {
    referenceLoading.value = true
    referenceError.value = null
    try {
        const threshold = parseReferenceThreshold()
        const data = await apiJson<{ result: ReferenceScreenMatchResult }>('/api/screen-matching/reference', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                referenceImage: referenceName.value,
                ...(threshold !== undefined ? { threshold } : {}),
            }),
        })
        referenceResult.value = data.result
    } catch (err) {
        referenceError.value = err instanceof Error ? err.message : String(err)
    } finally {
        referenceLoading.value = false
    }
}

function formatScore(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—'
    return value.toFixed(5)
}

function formatDate(value: string | undefined): string {
    if (!value) return '—'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleTimeString()
}

function stopStaticPolling(): void {
    if (staticPollHandle !== null) {
        window.clearInterval(staticPollHandle)
        staticPollHandle = null
    }
}

function updateStaticPolling(): void {
    stopStaticPolling()
    if (!liveStatic.value) return
    void checkStatic()
    staticPollHandle = window.setInterval(() => {
        void checkStatic()
    }, STATIC_POLL_SECONDS * 1000)
}

watch(liveStatic, updateStaticPolling)

onMounted(() => {
    void loadConfig().catch((err) => {
        referenceError.value = err instanceof Error ? err.message : String(err)
    })
    void loadReferences()
})

onBeforeUnmount(() => {
    stopStaticPolling()
})
</script>

<style scoped>
.screen-match-pane {
    height: 100%;
    min-height: 0;
    color: var(--pane-fg);
    display: flex;
    padding: 10px;
    box-sizing: border-box;
}

.panel {
    width: 100%;
    min-height: 0;
    border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(12, 14, 18, 0.92);
    color: var(--panel-fg);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
    overflow: hidden;
    display: flex;
    flex-direction: column;
}

.panel-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.04);
}

.panel-title-group {
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.panel-title {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.01em;
}

.panel-subtitle {
    color: rgba(230, 230, 230, 0.72);
    font-size: 12px;
}

.status-badge {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 5px 9px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
    background: rgba(255, 255, 255, 0.08);
    color: rgba(230, 230, 230, 0.82);
    white-space: nowrap;
}

.status-badge .dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: currentColor;
}

.status-badge[data-status='ready'] {
    color: #8ef2a0;
}

.status-badge[data-status='busy'] {
    color: #ffd36e;
}

.status-badge[data-status='error'] {
    color: #ff8f8f;
}

.panel-body {
    padding: 12px;
    overflow: auto;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 12px;
}

.match-card {
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.045);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
}

.card-head h3 {
    margin: 0 0 4px;
    font-size: 14px;
}

.card-head p {
    margin: 0;
    color: rgba(230, 230, 230, 0.66);
    font-size: 12px;
    line-height: 1.35;
}

.actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
}

.btn {
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(72, 128, 255, 0.28);
    color: var(--panel-fg);
    border-radius: 9px;
    padding: 7px 10px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
}

.btn.secondary {
    background: rgba(255, 255, 255, 0.08);
}

.btn:disabled {
    opacity: 0.55;
    cursor: default;
}

.live-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: rgba(230, 230, 230, 0.78);
    white-space: nowrap;
}

.result-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 8px;
}

.metric {
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.22);
    border: 1px solid rgba(255, 255, 255, 0.08);
    padding: 9px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.metric-label {
    color: rgba(230, 230, 230, 0.62);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
}

.metric strong {
    font-size: 14px;
    color: var(--panel-fg);
}

.metric strong[data-result='matched'] {
    color: #8ef2a0;
}

.metric strong[data-result='not-matched'] {
    color: #ffb36e;
}

.metric strong[data-result='unknown'] {
    color: rgba(230, 230, 230, 0.78);
}

.form-grid {
    display: grid;
    grid-template-columns: minmax(180px, 1fr) minmax(180px, 1fr) minmax(100px, 0.45fr);
    gap: 10px;
}

.field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 12px;
    color: rgba(230, 230, 230, 0.72);
}

.field.narrow {
    min-width: 100px;
}

.field input,
.field select {
    min-width: 0;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(0, 0, 0, 0.24);
    color: var(--panel-fg);
    padding: 7px 9px;
    font: inherit;
}

.fine-print {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
    color: rgba(230, 230, 230, 0.56);
    font-size: 11px;
}

.error-box {
    border-radius: 9px;
    border: 1px solid rgba(255, 120, 120, 0.35);
    background: rgba(255, 70, 70, 0.12);
    color: #ffb8b8;
    padding: 9px 10px;
    font-size: 12px;
    line-height: 1.35;
}

@media (max-width: 760px) {
    .panel-body,
    .form-grid {
        grid-template-columns: 1fr;
    }

    .card-head {
        flex-direction: column;
    }

    .actions {
        justify-content: flex-start;
    }
}
</style>
