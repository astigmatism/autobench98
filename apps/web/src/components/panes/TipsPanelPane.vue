<!-- apps/web/src/components/panes/TipsPanelPane.vue -->
<template>
  <div
    class="tips-pane"
    :style="{
      '--pane-fg': paneFg,
      '--panel-fg': panelFg,
      '--tips-image-col-width': `${imageColWidthPct}%`
    }"
  >
    <!-- Hotspot region: only hovering here shows the advanced settings button -->
    <div class="tips-advanced-hotspot">
      <button
        class="gear-btn"
        :aria-expanded="showAdvanced ? 'true' : 'false'"
        aria-controls="tips-advanced-panel"
        title="Show Tips options"
        @click="showAdvanced = !showAdvanced"
      >
        ⚙️
      </button>
    </div>

    <div class="panel">
      <!-- Header: title only -->
      <div class="panel-head">
        <div class="panel-title-group">
          <span class="panel-title">Tips &amp; Information</span>
        </div>
      </div>

      <div class="panel-body">
        <!-- Advanced panel (height-restricted + scrollable) -->
        <transition name="slide-fade">
          <div v-show="showAdvanced" id="tips-advanced-panel" class="advanced-panel">
            <div class="advanced-scroll">
              <div class="adv-section">
                <div class="adv-section-title">Display</div>

                <div class="adv-row">
                  <div class="adv-row-main">
                    <span class="adv-label">Text size</span>
                    <span class="adv-value mono">{{ textSizePx }} px</span>
                  </div>
                  <input
                    class="adv-slider"
                    type="range"
                    min="10"
                    max="24"
                    step="1"
                    v-model.number="textSizePx"
                  />
                  <div class="adv-hint">Controls the visible tip font size (overflow is clipped).</div>
                </div>

                <div class="adv-row">
                  <div class="adv-row-main">
                    <span class="adv-label">Header text size</span>
                    <span class="adv-value mono">{{ headerSizePx }} px</span>
                  </div>
                  <input
                    class="adv-slider"
                    type="range"
                    min="10"
                    max="28"
                    step="1"
                    v-model.number="headerSizePx"
                  />
                  <div class="adv-hint">Controls the category/header font size.</div>
                </div>

                <div class="adv-row">
                  <div class="adv-row-main">
                    <span class="adv-label">Image column width</span>
                    <span class="adv-value mono">{{ imageColWidthPct }}%</span>
                  </div>
                  <input
                    class="adv-slider"
                    type="range"
                    min="0"
                    max="30"
                    step="1"
                    v-model.number="imageColWidthPct"
                  />
                  <div class="adv-hint">
                    Controls the left image column width. Default is 10%. (0% effectively hides the column.)
                  </div>
                </div>
              </div>

              <div class="adv-section">
                <div class="adv-section-title">Rotation</div>

                <div class="adv-row">
                  <div class="adv-row-main">
                    <span class="adv-label">Mode</span>
                    <span class="adv-value mono">{{ rotationModeLabel }}</span>
                  </div>

                  <div class="segmented">
                    <button
                      class="seg-btn"
                      :class="{ active: rotationMode === 'fixed' }"
                      type="button"
                      @click="rotationMode = 'fixed'"
                    >
                      Fixed
                    </button>
                    <button
                      class="seg-btn"
                      :class="{ active: rotationMode === 'auto' }"
                      type="button"
                      @click="rotationMode = 'auto'"
                    >
                      Auto
                    </button>
                  </div>

                  <div class="adv-hint">
                    Fixed uses one static interval. Auto computes dwell time from the current tip title, text, image presence, review buffer, and a final pause.
                  </div>
                </div>

                <div v-if="rotationMode === 'fixed'" class="adv-row">
                  <div class="adv-row-main">
                    <span class="adv-label">Interval override</span>
                    <span class="adv-value mono">
                      {{ intervalOverrideMs === null ? '(server default)' : `${intervalOverrideMs} ms` }}
                    </span>
                  </div>

                  <input
                    class="adv-slider"
                    type="range"
                    min="0"
                    max="60000"
                    step="250"
                    :value="intervalOverrideMs === null ? 0 : intervalOverrideMs"
                    @input="onIntervalSliderInput"
                  />

                  <div class="adv-hint">
                    0 = follow serverConfig.tips.intervalMs · otherwise overrides client rotation interval
                  </div>
                </div>

                <div v-else class="adv-row">
                  <div class="adv-row-main">
                    <span class="adv-label">Reading pace</span>
                    <span class="adv-value mono">{{ autoPacePercent }}%</span>
                  </div>

                  <input
                    class="adv-slider"
                    type="range"
                    min="70"
                    max="220"
                    step="5"
                    v-model.number="autoPacePercent"
                  />

                  <div class="adv-scale-labels mono">
                    <span>Faster</span>
                    <span>Default</span>
                    <span>Slower</span>
                  </div>

                  <div class="adv-hint">
                    Scales all auto-computed tip times. Lower values rotate sooner; higher values allow more reading, review, and digestion time.
                  </div>
                </div>

                <div class="advanced-row">
                  <span class="label">Effective interval</span>
                  <span class="value mono">{{ effectiveIntervalMs }} ms</span>
                </div>

                <div v-if="rotationMode === 'auto'" class="advanced-row">
                  <span class="label">Auto basis</span>
                  <span class="value mono">{{ autoDurationDebugLabel }}</span>
                </div>

                <div class="adv-row adv-row-inline">
                  <button class="btn pill-btn" type="button" @click="requestNextTip">
                    Next tip now
                  </button>
                  <span class="adv-hint mono">clientId={{ clientIdDisplay }}</span>
                </div>
              </div>

              <div class="adv-section">
                <div class="adv-section-title">Server</div>

                <div class="advanced-row">
                  <span class="label">Config</span>
                  <span class="value" v-if="cfgOk">present</span>
                  <span class="value dim" v-else>missing / invalid</span>
                </div>

                <template v-if="cfgOk">
                  <div class="advanced-row">
                    <span class="label">Enabled</span>
                    <span class="value">{{ tipsCfg!.enabled ? 'true' : 'false' }}</span>
                  </div>
                  <div class="advanced-row">
                    <span class="label">Interval</span>
                    <span class="value">{{ tipsCfg!.intervalMs }} ms</span>
                  </div>
                  <div class="advanced-row">
                    <span class="label">Tab</span>
                    <span class="value">{{ tipsCfg!.tab }}</span>
                  </div>
                  <div class="advanced-row">
                    <span class="label">Strict</span>
                    <span class="value">{{ tipsCfg!.strict ? 'true' : 'false' }}</span>
                  </div>
                  <div class="advanced-row">
                    <span class="label">Cache TTL</span>
                    <span class="value">{{ tipsCfg!.cacheTtlMs }} ms</span>
                  </div>
                </template>

                <div class="advanced-row" v-if="tipsLastError">
                  <span class="label">Last Error</span>
                  <span class="value mono">{{ tipsLastError }}</span>
                </div>
              </div>
            </div>
          </div>
        </transition>

        <!-- Main content (paper-styled full area) -->
        <div class="content">
          <div class="hint" v-if="!cfgOk">
            Tips config is not present in the current snapshot.
            Expected path: <span class="mono">serverConfig.tips</span>
          </div>

          <div class="hint" v-else-if="tipsCfg && !tipsCfg.enabled">
            Tips are disabled by server config (<span class="mono">TIPS_ENABLED=false</span>).
          </div>

          <div class="hint" v-else-if="!liveTip">
            Waiting for first tip…
          </div>

          <!-- Tip view (animated between tips/pages) -->
          <transition name="tip-fade" mode="out-in">
            <div v-if="liveTip" class="tip" :key="tipKey">
              <div class="tip-layout">
                <!-- Left column (width controlled by --tips-image-col-width), only when image is present -->
                <div v-if="liveTip.imageUrl" class="tip-image">
                  <img :src="liveTip.imageUrl" alt="Tip image" />
                </div>

                <!-- Right column: header row + text row + pagination bottom-right -->
                <div class="tip-right">
                  <div class="tip-category mono" :style="categoryHeaderStyle">
                    {{ displayCategoryTitle }}
                  </div>

                  <div class="tip-text mono" :style="{ fontSize: `${textSizePx}px` }">
                    {{ liveTip.text }}
                  </div>

                  <!-- Pagination bottom-right, only if pageCount > 1 -->
                  <div class="tip-page mono" v-if="(liveTip.pageCount ?? 1) > 1">
                    {{ (liveTip.pageIndex ?? 0) + 1 }}/{{ liveTip.pageCount ?? 1 }}
                  </div>
                </div>
              </div>
            </div>
          </transition>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useMirror } from '@/stores/mirror'
import { getRealtimeClient } from '@/bootstrap'

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
 * Per-pane UI prefs (Tips pane)
 * (Footer + reset UI removed per request; we still persist the controls.)
 */
type RotationMode = 'fixed' | 'auto'

type TipsPanePrefs = {
  showAdvanced?: boolean
  intervalOverrideMs?: number | null
  textSizePx?: number
  headerSizePx?: number
  imageColWidthPct?: number
  rotationMode?: RotationMode
  autoPacePercent?: number
}

function isObject(x: any): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}
function isFiniteNumber(x: any): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}
function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  const i = Math.trunc(n)
  return Math.min(max, Math.max(min, i))
}
function countWords(raw: unknown): number {
  if (typeof raw !== 'string') return 0
  const words = raw.trim().match(/\S+/g)
  return words ? words.length : 0
}
function roundToFriendlyMs(ms: number): number {
  if (!Number.isFinite(ms)) return 6000
  const clamped = Math.max(1000, Math.trunc(ms))
  return Math.round(clamped / 250) * 250
}
function isRotationMode(x: unknown): x is RotationMode {
  return x === 'fixed' || x === 'auto'
}

const props = defineProps<{
  pane?: PaneInfo
  __tipsPaneUi?: TipsPanePrefs
  /** Monotonic "profile load" revision stamped by App.vue to force rehydrate on load. */
  __tipsPaneProfileRev?: number
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
  const bg = (props.pane?.appearance?.bg ?? '#111827') as string
  const Lbg = relLuminance(bg)
  const contrastWithWhite = contrastRatio(relLuminance('#ffffff'), Lbg)
  const contrastWithBlack = contrastRatio(relLuminance('#000000'), Lbg)
  return contrastWithWhite >= contrastWithBlack ? '#ffffff' : '#111111'
})

const panelFg = '#e6e6e6'

/* -------------------------------------------------------------------------- */
/*  Snapshot types                                                            */
/* -------------------------------------------------------------------------- */

type TipsServerConfig = {
  enabled: boolean
  intervalMs: number
  pageDelim: string
  tab: string
  cacheTtlMs: number
  strict: boolean
  defaultCategories: string[]
  maxTextChars: number
  maxPagesPerTip: number
}

function isTipsServerConfig(x: unknown): x is TipsServerConfig {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (
    typeof o.enabled === 'boolean' &&
    typeof o.intervalMs === 'number' &&
    typeof o.pageDelim === 'string' &&
    typeof o.tab === 'string' &&
    typeof o.cacheTtlMs === 'number' &&
    typeof o.strict === 'boolean' &&
    Array.isArray(o.defaultCategories) &&
    typeof o.maxTextChars === 'number' &&
    typeof o.maxPagesPerTip === 'number'
  )
}

/* -------------------------------------------------------------------------- */
/*  Live tip WS message type                                                  */
/* -------------------------------------------------------------------------- */

type CategoryProps = Record<string, unknown>

type TipsPanelCurrent = {
  category: string
  tipId: string
  pageIndex: number
  pageCount: number
  text: string
  imageUrl: string | null
  shownAt: number

  // OPTIONAL extras (non-breaking) from backend:
  categoryTitle?: string
  categoryProps?: CategoryProps
}

function isTipsPanelCurrent(x: unknown): x is TipsPanelCurrent {
  if (!x || typeof x !== 'object') return false
  const o = x as any
  const okBase =
    typeof o.category === 'string' &&
    typeof o.tipId === 'string' &&
    typeof o.pageIndex === 'number' &&
    typeof o.pageCount === 'number' &&
    typeof o.text === 'string' &&
    (typeof o.imageUrl === 'string' || o.imageUrl === null || o.imageUrl === undefined) &&
    typeof o.shownAt === 'number'

  if (!okBase) return false

  if (o.categoryTitle !== undefined && typeof o.categoryTitle !== 'string') return false
  if (o.categoryProps !== undefined && !isObject(o.categoryProps)) return false

  return true
}

function safeStr(x: unknown, fallback = ''): string {
  return typeof x === 'string' && x.trim() ? x.trim() : fallback
}

function clampIntervalMs(raw: unknown, def: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n)) return def
  const i = Math.trunc(n)
  if (i < 250) return 250
  return i
}

/* -------------------------------------------------------------------------- */
/*  Mirror                                                                    */
/* -------------------------------------------------------------------------- */

const mirror = useMirror()

const tipsCfg = computed<TipsServerConfig | null>(() => {
  const root = mirror.data as any
  const cfg = root?.serverConfig?.tips
  return isTipsServerConfig(cfg) ? (cfg as TipsServerConfig) : null
})

const cfgOk = computed(() => tipsCfg.value !== null)

/* -------------------------------------------------------------------------- */
/*  Tips-only WS client recognition + scheduling                              */
/* -------------------------------------------------------------------------- */

const clientId = ref<string>('') // populated from WSClient.getTipsClientId()
const clientIdDisplay = computed(() => (clientId.value ? clientId.value : '(none)'))

const liveTip = ref<TipsPanelCurrent | null>(null)
const tipsLastError = ref<string>('')

let wsUnsubs: Array<() => void> = []
let tipsTimer: number | null = null

/* -------------------------------------------------------------------------- */
/*  Category display helpers (title + optional color)                         */
/* -------------------------------------------------------------------------- */

function safeHexColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (/^#[0-9a-fA-F]{3}$/.test(s)) return s
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s
  return null
}

const displayCategoryTitle = computed(() => {
  const t = liveTip.value
  if (!t) return ''
  const title = typeof t.categoryTitle === 'string' ? t.categoryTitle.trim() : ''
  return title || t.category
})

const categoryTitleColor = computed(() => {
  const t = liveTip.value
  if (!t) return null
  const props = t.categoryProps
  if (!props || !isObject(props)) return null
  return safeHexColor((props as any).color)
})

const headerSizePx = ref<number>(16)
const imageColWidthPct = ref<number>(10)

const categoryHeaderStyle = computed(() => {
  const style: Record<string, string> = {}

  const c = categoryTitleColor.value
  if (c) style.color = c

  style.fontSize = `${headerSizePx.value}px`

  return style
})

function clearTipsTimer() {
  if (tipsTimer !== null) {
    clearTimeout(tipsTimer)
    tipsTimer = null
  }
}

function sendTipsHello() {
  const ws = getRealtimeClient()
  if (!ws) return
  ws.sendTipsHello()
}

function sendTipsNext() {
  const ws = getRealtimeClient()
  if (!ws) return
  ws.sendTipsNext()
}

function requestNextTip() {
  const cfg = tipsCfg.value
  if (!cfg || !cfg.enabled) return
  clearTipsTimer()
  sendTipsNext()
}

const intervalOverrideMs = ref<number | null>(null)
const textSizePx = ref<number>(14)

const rotationMode = ref<RotationMode>('fixed')
const autoPacePercent = ref<number>(100)

const autoPaceMultiplier = computed(() => autoPacePercent.value / 100)

const fixedIntervalMs = computed(() => {
  const cfg = tipsCfg.value
  const serverMs = cfg ? clampIntervalMs(cfg.intervalMs, 10_000) : 10_000
  if (intervalOverrideMs.value === null) return serverMs
  return clampIntervalMs(intervalOverrideMs.value, serverMs)
})

const autoDurationBreakdown = computed(() => {
  const tip = liveTip.value

  if (!tip) {
    const baseMs = 1250
    const titleMs = 0
    const bodyMs = 0
    const imageMs = 0
    const reviewMs = 0
    const pauseMs = 2000
    const rawMs = baseMs + titleMs + bodyMs + imageMs + reviewMs + pauseMs
    const pacedMs = rawMs * autoPaceMultiplier.value
    const finalMs = roundToFriendlyMs(Math.max(6000, Math.min(22000, pacedMs)))

    return {
      titleWords: 0,
      bodyWords: 0,
      hasImage: false,
      baseMs,
      titleMs,
      bodyMs,
      imageMs,
      reviewMs,
      pauseMs,
      rawMs,
      pacedMs: Math.round(pacedMs),
      finalMs
    }
  }

  const titleWords = countWords(displayCategoryTitle.value)
  const bodyWords = countWords(tip.text)
  const hasImage = !!tip.imageUrl

  // Re-balanced for technical reading rather than casual skimming.
  const baseMs = 1250
  const titleMs = Math.max(1000, Math.round(titleWords * 320))
  const bodyMs = Math.round(bodyWords * 420)
  const imageMs = hasImage ? 1500 : 0

  // Explicit review buffer: gives time to re-scan terms, versions, and model names.
  const reviewMs = Math.round((titleMs + bodyMs + imageMs) * 0.22)

  // Explicit end pause: gives time to digest before the next tip replaces this one.
  const pauseMs = 2000

  const rawMs = baseMs + titleMs + bodyMs + imageMs + reviewMs + pauseMs
  const pacedMs = rawMs * autoPaceMultiplier.value
  const finalMs = roundToFriendlyMs(Math.max(6000, Math.min(22000, pacedMs)))

  return {
    titleWords,
    bodyWords,
    hasImage,
    baseMs,
    titleMs,
    bodyMs,
    imageMs,
    reviewMs,
    pauseMs,
    rawMs,
    pacedMs: Math.round(pacedMs),
    finalMs
  }
})

const effectiveIntervalMs = computed(() => {
  if (rotationMode.value === 'auto') return autoDurationBreakdown.value.finalMs
  return fixedIntervalMs.value
})

const rotationModeLabel = computed(() => (rotationMode.value === 'auto' ? 'Auto' : 'Fixed'))

const autoDurationDebugLabel = computed(() => {
  const b = autoDurationBreakdown.value
  return `titleWords=${b.titleWords} bodyWords=${b.bodyWords} image=${b.hasImage ? 'yes' : 'no'} reviewMs=${b.reviewMs} pauseMs=${b.pauseMs} rawMs=${b.rawMs} pacedMs=${b.pacedMs}`
})

function scheduleNextTip(ms: number) {
  clearTipsTimer()
  const safeMs = clampIntervalMs(ms, 10_000)
  tipsTimer = window.setTimeout(() => {
    const cfg = tipsCfg.value
    if (!cfg || !cfg.enabled) return
    sendTipsNext()
  }, safeMs) as unknown as number
}

function stopTipsWs() {
  clearTipsTimer()
  for (const off of wsUnsubs) {
    try {
      off()
    } catch {}
  }
  wsUnsubs = []
}

function handleWsMessage(m: any) {
  if (!m || typeof m !== 'object') return

  if (m.type === 'tips.tip') {
    const tip = m?.payload?.tip
    if (isTipsPanelCurrent(tip)) {
      liveTip.value = tip
      tipsLastError.value = ''
      scheduleNextTip(effectiveIntervalMs.value)
    }
    return
  }

  if (m.type === 'tips.error') {
    const err = safeStr(m?.payload?.error, 'tips error')
    tipsLastError.value = err
    return
  }
}

function bindTipsWsIfAvailable() {
  stopTipsWs()

  const ws = getRealtimeClient()
  if (!ws) {
    clientId.value = ''
    return
  }

  clientId.value = String(ws.getTipsClientId() ?? '').trim()

  wsUnsubs.push(
    ws.on('open', () => {
      const cfg = tipsCfg.value
      if (cfg?.enabled) {
        sendTipsHello()
        sendTipsNext()
      }
    })
  )

  wsUnsubs.push(
    ws.on('status', (payload: any) => {
      const st = payload?.state
      if (st !== 'connected') {
        clearTipsTimer()
        return
      }

      const cfg = tipsCfg.value
      if (cfg?.enabled) {
        sendTipsHello()
        sendTipsNext()
      }
    })
  )

  wsUnsubs.push(
    ws.on('message', (m: any) => {
      handleWsMessage(m)
    })
  )

  const cfg = tipsCfg.value
  if (cfg?.enabled) {
    sendTipsHello()
    sendTipsNext()
  }
}

onMounted(() => {
  bindTipsWsIfAvailable()
})

onBeforeUnmount(() => {
  stopTipsWs()
})

watch(
  () => tipsCfg.value?.enabled,
  (enabled) => {
    if (!enabled) {
      clearTipsTimer()
      return
    }
    sendTipsHello()
    sendTipsNext()
  }
)

watch(
  () => effectiveIntervalMs.value,
  (ms) => {
    const cfg = tipsCfg.value
    if (!cfg || !cfg.enabled) return
    if (!liveTip.value) return
    scheduleNextTip(ms)
  }
)

/* -------------------------------------------------------------------------- */
/*  Per-pane UI persistence (localStorage + profile round-trip)               */
/* -------------------------------------------------------------------------- */

const showAdvanced = ref(false)

const paneId = computed(() => String(props.pane?.id ?? '').trim())

const STORAGE_PREFIX = 'tips:pane:ui:'
const storageKey = computed(() => (paneId.value ? `${STORAGE_PREFIX}${paneId.value}` : ''))

function readPanePrefs(): TipsPanePrefs | null {
  const key = storageKey.value
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as TipsPanePrefs) : null
  } catch {
    return null
  }
}

function writePanePrefs(p: TipsPanePrefs) {
  const key = storageKey.value
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify(p))
  } catch {
    // ignore
  }
}

function exportPanePrefs(): TipsPanePrefs {
  return {
    showAdvanced: !!showAdvanced.value,
    intervalOverrideMs: intervalOverrideMs.value,
    textSizePx: textSizePx.value,
    headerSizePx: headerSizePx.value,
    imageColWidthPct: imageColWidthPct.value,
    rotationMode: rotationMode.value,
    autoPacePercent: autoPacePercent.value
  }
}

function applyPanePrefs(prefs?: TipsPanePrefs | null) {
  if (!prefs || typeof prefs !== 'object') return

  const adv = (prefs as any).showAdvanced
  if (typeof adv === 'boolean') showAdvanced.value = adv

  const override = (prefs as any).intervalOverrideMs
  if (override === null) intervalOverrideMs.value = null
  else if (isFiniteNumber(override)) intervalOverrideMs.value = clampInt(override, 0, 60000)

  const ts = (prefs as any).textSizePx
  if (isFiniteNumber(ts)) textSizePx.value = clampInt(ts, 10, 24)

  const hs = (prefs as any).headerSizePx
  if (isFiniteNumber(hs)) headerSizePx.value = clampInt(hs, 10, 28)

  const iw = (prefs as any).imageColWidthPct
  if (isFiniteNumber(iw)) imageColWidthPct.value = clampInt(iw, 0, 30)

  const rm = (prefs as any).rotationMode
  if (isRotationMode(rm)) rotationMode.value = rm

  const ap = (prefs as any).autoPacePercent
  if (isFiniteNumber(ap)) autoPacePercent.value = clampInt(ap, 70, 220)
}

const lastHydratedSig = ref<string>('')

function hydrateForPane() {
  const key = storageKey.value
  const rev = typeof props.__tipsPaneProfileRev === 'number' ? props.__tipsPaneProfileRev : 0
  const hasEmbed = isObject(props.__tipsPaneUi)

  if (!key) {
    const sig = `nokey|rev:${rev}|embed:${hasEmbed ? 1 : 0}`
    if (lastHydratedSig.value === sig) return
    lastHydratedSig.value = sig
    if (hasEmbed) applyPanePrefs(props.__tipsPaneUi as TipsPanePrefs)
    return
  }

  const sig = `${key}|rev:${rev}|embed:${hasEmbed ? 1 : 0}`
  if (lastHydratedSig.value === sig) return
  lastHydratedSig.value = sig

  if (hasEmbed) {
    applyPanePrefs(props.__tipsPaneUi as TipsPanePrefs)
    writePanePrefs(exportPanePrefs())
    return
  }

  const stored = readPanePrefs()
  if (stored) {
    applyPanePrefs(stored)
    return
  }
}

watch([paneId, () => props.__tipsPaneUi, () => props.__tipsPaneProfileRev], () => hydrateForPane(), {
  immediate: true
})

watch(
  [
    () => showAdvanced.value,
    () => intervalOverrideMs.value,
    () => textSizePx.value,
    () => headerSizePx.value,
    () => imageColWidthPct.value,
    () => rotationMode.value,
    () => autoPacePercent.value
  ],
  () => {
    headerSizePx.value = clampInt(headerSizePx.value, 10, 28)
    imageColWidthPct.value = clampInt(imageColWidthPct.value, 0, 30)
    textSizePx.value = clampInt(textSizePx.value, 10, 24)
    autoPacePercent.value = clampInt(autoPacePercent.value, 70, 220)

    if (!isRotationMode(rotationMode.value)) {
      rotationMode.value = 'fixed'
    }

    writePanePrefs(exportPanePrefs())
  }
)

/* -------------------------------------------------------------------------- */
/*  UI helpers                                                                */
/* -------------------------------------------------------------------------- */

const tipKey = computed(() => {
  const t = liveTip.value
  if (!t) return 'none'
  return `${t.tipId}::${t.pageIndex}`
})

function onIntervalSliderInput(e: Event) {
  const el = e.target as HTMLInputElement | null
  const raw = el ? Number(el.value) : NaN
  if (!Number.isFinite(raw)) return

  if (raw <= 0) {
    intervalOverrideMs.value = null
    return
  }

  intervalOverrideMs.value = clampInt(raw, 250, 60000)
}
</script>

<style scoped>
.tips-pane {
  --pane-fg: #111;
  --panel-fg: #e6e6e6;
  --tips-image-col-width: 10%;

  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  width: 100%;
  min-height: 0;
  color: var(--pane-fg);
}

.tips-advanced-hotspot {
  position: absolute;
  top: 0;
  right: 0;
  width: 3.2rem;
  height: 2.2rem;
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
  transition:
    opacity 120ms ease,
    background 120ms ease,
    border-color 120ms ease,
    transform 60ms ease;
  z-index: 31;
}

.tips-advanced-hotspot:hover .gear-btn {
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

.tip-fade-enter-active,
.tip-fade-leave-active {
  transition: opacity 220ms ease, transform 220ms ease;
}
.tip-fade-enter-from,
.tip-fade-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

.panel {
  background: #020617;
  border: 1px solid #1f2933;
  border-radius: 8px;
  padding: 8px;
  color: var(--panel-fg);
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1 1 0%;
  min-height: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.8rem;
}

.panel-title-group {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.panel-title {
  font-weight: 500;
  font-size: 0.8rem;
}

.panel-body {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1 1 0%;
  min-height: 0;
}

.advanced-panel {
  margin-top: 4px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px dashed #374151;
  background: #020617;
  font-size: 0.75rem;
}

.advanced-scroll {
  max-height: 220px;
  overflow: auto;
  padding-right: 4px;
}

.adv-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px dashed rgba(55, 65, 81, 0.6);
}
.adv-section:last-child {
  border-bottom: none;
}

.adv-section-title {
  font-weight: 600;
  font-size: 0.78rem;
  opacity: 0.95;
}

.adv-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.adv-row-inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.adv-row-main {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}

.adv-label {
  font-weight: 500;
}

.adv-value {
  font-variant-numeric: tabular-nums;
}

.adv-slider {
  width: 100%;
}

.adv-hint {
  opacity: 0.7;
  font-size: 0.7rem;
}

.adv-scale-labels {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  opacity: 0.8;
  font-size: 0.68rem;
}

.segmented {
  display: inline-flex;
  width: 100%;
  border: 1px solid #374151;
  border-radius: 8px;
  overflow: hidden;
  background: #030712;
}

.seg-btn {
  flex: 1 1 0%;
  height: 30px;
  border: 0;
  background: transparent;
  color: var(--panel-fg);
  cursor: pointer;
  font-size: 0.75rem;
  transition:
    background 120ms ease,
    color 120ms ease;
}

.seg-btn + .seg-btn {
  border-left: 1px solid #374151;
}

.seg-btn.active {
  background: #111827;
  color: #ffffff;
}

.advanced-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 2px;
}
.advanced-row .label {
  opacity: 0.7;
  min-width: 90px;
}
.advanced-row .value {
  text-align: right;
}
.dim {
  opacity: 0.6;
}

.content {
  margin-top: 4px;
  padding: 10px;
  border-radius: 6px;

  background: radial-gradient(circle at top left, #fefce8 0, #fefce8 45%, #f9fafb 100%);
  color: #4b5563;
  border: 1px solid rgba(209, 213, 219, 0.9);

  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  flex: 1 1 0%;
  overflow: hidden;
}

.hint {
  font-size: 0.78rem;
  opacity: 0.85;
  line-height: 1.35;
}

.tip {
  min-height: 0;
  flex: 1 1 0%;
  display: flex;
}

.tip-layout {
  display: flex;
  gap: 10px;
  flex: 1 1 0%;
  min-height: 0;
}

.tip-image {
  flex: 0 0 var(--tips-image-col-width);
  max-width: var(--tips-image-col-width);
  min-height: 0;
  overflow: hidden;
  border-radius: 4px;
}
.tip-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.tip-right {
  flex: 1 1 0%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tip-category {
  font-weight: 700;
  color: #374151;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tip-text {
  flex: 1 1 0%;
  min-height: 0;

  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
    monospace;
  line-height: 1.35;

  overflow: hidden;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.tip-page {
  margin-top: auto;
  align-self: flex-end;
  font-size: 0.78rem;
  color: #6b7280;
  font-variant-numeric: tabular-nums;
}

.btn {
  --control-h: 28px;

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
    opacity 120ms ease;
  user-select: none;
  white-space: nowrap;
  height: var(--control-h);
  line-height: var(--control-h);
}

.btn:hover:not(:disabled) {
  background: #030712;
  border-color: #4b5563;
  transform: translateY(-1px);
}

.pill-btn {
  border-radius: 999px;
  padding: 0 10px;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
    'Courier New', monospace;
}
</style>
