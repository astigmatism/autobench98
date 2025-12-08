<template>
  <div class="cf-pane" :style="{ '--pane-fg': paneFg, '--panel-fg': panelFg }">
    <!-- Hover gear button -->
    <button
      class="gear-btn"
      :aria-expanded="showAdvanced ? 'true' : 'false'"
      aria-controls="cf-advanced-panel"
      title="Show CF reader details"
      @click="showAdvanced = !showAdvanced"
    >
      ⚙️
    </button>

    <div class="panel">
      <!-- Header: title (left) + status badge (right) -->
      <div class="panel-head">
        <div class="panel-title-group">
          <span class="panel-title">CompactFlash Imager</span>
        </div>

        <span
          class="status-badge"
          :data-phase="view.phase"
          :data-media="view.media"
        >
          <span class="dot"></span>
          <span class="label">{{ statusLabel }}</span>
        </span>
      </div>

      <!-- Advanced device/media details (hidden by default) -->
      <transition name="slide-fade">
        <div
          v-show="showAdvanced"
          id="cf-advanced-panel"
          class="advanced-panel"
        >
          <div class="advanced-row">
            <span class="label">Device</span>
            <span class="value" v-if="view.device">
              {{ view.device.path }}
            </span>
            <span class="value dim" v-else>
              No CF reader detected
            </span>
          </div>

          <div class="advanced-row" v-if="view.device">
            <span class="label">USB IDs</span>
            <span class="value">
              <span v-if="view.device.vendorId">VID {{ view.device.vendorId }}</span>
              <span v-if="view.device.productId">
                <span v-if="view.device.vendorId">&nbsp;•&nbsp;</span>
                PID {{ view.device.productId }}
              </span>
              <span
                v-if="!view.device.vendorId && !view.device.productId"
                class="dim"
              >
                (not reported)
              </span>
            </span>
          </div>

          <div class="advanced-row">
            <span class="label">Media</span>
            <span class="value">
              <template v-if="view.media === 'present'">
                Card present
              </template>
              <template v-else-if="view.media === 'none'">
                No card inserted
              </template>
              <template v-else-if="view.media === 'unknown'">
                Checking / probe in progress
              </template>
              <template v-else>
                Unknown
              </template>
            </span>
          </div>

          <div
            class="advanced-row"
            v-if="view.message"
          >
            <span class="label">Status</span>
            <span class="value">{{ view.message }}</span>
          </div>
        </div>
      </transition>

      <!-- Current operation (if any) -->
      <div v-if="view.currentOp" class="op-panel">
        <div class="op-head">
          <span class="op-kind">
            <span class="dot dot-small"></span>
            {{ opLabel }}
          </span>
          <span class="op-paths">
            {{ view.currentOp.source }} → {{ view.currentOp.destination }}
          </span>
        </div>

        <div class="op-progress-row">
          <div class="op-progress-bar">
            <div
              class="op-progress-fill"
              :style="{ width: progressPctDisplay + '%' }"
            ></div>
          </div>
          <div class="op-progress-meta">
            <span class="pct">{{ progressPctDisplay.toFixed(1) }}%</span>
            <span v-if="bytesDisplay" class="bytes">
              {{ bytesDisplay }}
            </span>
          </div>
        </div>

        <div v-if="view.currentOp.message" class="op-message">
          {{ view.currentOp.message }}
        </div>
      </div>

      <!-- Last error (if any and not already shown in currentOp) -->
      <div v-if="view.lastError && !view.currentOp" class="error-banner">
        ⚠️ {{ view.lastError }}
      </div>

      <!-- File system browser (very simple, read-only for now) -->
      <div class="fs-panel">
        <div class="fs-header">
          <div class="fs-path">
            <span class="label">Path:</span>
            <span class="value">{{ view.fs.cwd }}</span>
          </div>
          <div class="fs-meta">
            <span class="chip">
              {{ view.fs.entries.length }} item<span v-if="view.fs.entries.length !== 1">s</span>
            </span>
          </div>
        </div>

        <div v-if="view.fs.entries.length === 0" class="fs-empty">
          <template v-if="view.phase === 'disconnected'">
            No CF device connected.
          </template>
          <template v-else-if="view.media === 'none'">
            CF reader detected, but no card inserted.
          </template>
          <template v-else>
            No entries in this directory.
          </template>
        </div>

        <div v-else class="fs-list">
          <div
            v-for="entry in view.fs.entries"
            :key="entry.name + '::' + entry.kind"
            class="fs-row"
            :data-kind="entry.kind"
          >
            <span class="name">
              <span class="icon">{{ entry.kind === 'dir' ? '📁' : '📄' }}</span>
              {{ entry.name }}
            </span>
            <span class="meta">
              <span v-if="entry.sizeBytes != null" class="size">
                {{ formatSize(entry.sizeBytes) }}
              </span>
              <span v-if="entry.modifiedAt" class="time">
                {{ formatDate(entry.modifiedAt) }}
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMirror } from '@/stores/mirror'

/**
 * Pane context (same as other panes)
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
/*  Types matching orchestrator CfImagerSnapshot                              */
/* -------------------------------------------------------------------------- */

type CfImagerMediaStatus = 'none' | 'present' | 'unknown'

type CfImagerFsEntry = {
  name: string
  kind: 'file' | 'dir'
  sizeBytes?: number
  modifiedAt?: string
}

type CfImagerFsState = {
  rootPath: string
  cwd: string
  entries: CfImagerFsEntry[]
}

type CfImagerDeviceSnapshot = {
  id: string
  path: string
  vendorId?: string
  productId?: string
  serialNumber?: string
}

type CfImagerCurrentOpSnapshot = {
  kind: 'read' | 'write'
  source: string
  destination: string
  startedAt: string
  progressPct: number
  bytesDone?: number
  bytesTotal?: number
  message?: string
}

type CfImagerPhase = 'disconnected' | 'idle' | 'busy' | 'error'

type CfImagerSnapshot = {
  phase: CfImagerPhase
  media: CfImagerMediaStatus
  message?: string
  device?: CfImagerDeviceSnapshot
  fs: CfImagerFsState
  currentOp?: CfImagerCurrentOpSnapshot
  lastError?: string
}

/* -------------------------------------------------------------------------- */
/*  Mirror + safe initial snapshot                                            */
/* -------------------------------------------------------------------------- */

const mirror = useMirror()

const initialCfImager: CfImagerSnapshot = {
  phase: 'disconnected',
  media: 'none',
  message: 'Waiting for CF imager…',
  device: undefined,
  fs: {
    rootPath: '/',
    cwd: '/',
    entries: []
  },
  currentOp: undefined,
  lastError: undefined
}

const cfImager = computed<CfImagerSnapshot>(() => {
  const root = mirror.data as any
  const slice = root?.cfImager as Partial<CfImagerSnapshot> | undefined
  if (!slice) return initialCfImager

  const fs: CfImagerFsState = slice.fs ?? {
    rootPath: '/',
    cwd: '/',
    entries: []
  }

  const phase: CfImagerPhase = slice.phase ?? 'disconnected'
  let media: CfImagerMediaStatus = slice.media ?? 'none'

  // Reasonable defaults if backend is still catching up:
  if (phase === 'disconnected') {
    media = 'none'
  }

  return {
    phase,
    media,
    message: slice.message,
    device: slice.device,
    fs,
    currentOp: slice.currentOp,
    lastError: slice.lastError
  }
})

/* -------------------------------------------------------------------------- */
/*  Derived view model                                                        */
/* -------------------------------------------------------------------------- */

const view = computed(() => cfImager.value)

const statusLabel = computed(() => {
  const { phase, media, device } = view.value

  // Reader not present at all
  if (phase === 'disconnected' || !device) {
    return 'Disconnected'
  }

  // Operations trump everything else
  if (phase === 'busy') {
    return 'Busy'
  }

  if (phase === 'error') {
    return 'Error'
  }

  // phase === 'idle' (or similar non-terminal)
  if (media === 'unknown') {
    return 'Checking...'
  }

  if (media === 'none') {
    // Reader is present, no card: "No Media"
    return 'No Media'
  }

  if (media === 'present') {
    // Reader + card present, idle: "Ready"
    return 'Media Ready'
  }

  // Fallback
  return 'No Media'
})

const opLabel = computed(() => {
  const op = view.value.currentOp
  if (!op) return ''
  return op.kind === 'read' ? 'Reading CF card' : 'Writing CF card'
})

const progressPctDisplay = computed(() => {
  const op = view.value.currentOp
  if (!op || typeof op.progressPct !== 'number') return 0
  if (!Number.isFinite(op.progressPct)) return 0
  if (op.progressPct < 0) return 0
  if (op.progressPct > 100) return 100
  return op.progressPct
})

const bytesDisplay = computed(() => {
  const op = view.value.currentOp
  if (!op || op.bytesDone == null || op.bytesTotal == null) return ''
  return `${formatSize(op.bytesDone)} / ${formatSize(op.bytesTotal)}`
})

/* -------------------------------------------------------------------------- */
/*  Advanced toggle                                                           */
/* -------------------------------------------------------------------------- */

const showAdvanced = ref(false)

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let b = bytes
  let idx = 0
  while (b >= 1024 && idx < units.length - 1) {
    b /= 1024
    idx++
  }
  return `${b.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
  } catch {
    return iso
  }
}
</script>

<style scoped>
.cf-pane {
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

/* Gear button (same interaction pattern as logs pane) */
.gear-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  height: 26px;
  min-width: 26px;
  padding: 0 6px;
  border-radius: 6px;
  border: 1px solid #333;
  background: #050816;
  color: #e5e7eb;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 120ms ease,
    background 120ms ease,
    border-color 120ms ease,
    transform 60ms ease;
  z-index: 3;
}
.cf-pane:hover .gear-btn,
.gear-btn:focus,
.gear-btn:focus-visible {
  opacity: 1;
}
.gear-btn:hover {
  background: #0f172a;
  border-color: #4b5563;
  transform: translateY(-1px);
}

/* Slide-fade transition for advanced panel */
.slide-fade-enter-active,
.slide-fade-leave-active {
  transition: opacity 180ms ease, transform 180ms ease;
}
.slide-fade-enter-from,
.slide-fade-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.panel {
  background: #0b0d12;
  border: 1px solid #1f2933;
  border-radius: 8px;
  padding: 8px;
  color: var(--panel-fg);
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}

/* Header */
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

/* Base: disconnected (gray) */
.status-badge[data-phase='disconnected'] {
  border-color: #4b5563;
  background: #020617;
}
.status-badge[data-phase='disconnected'] .dot {
  background: #6b7280;
}

/* Idle + media-aware colors */

/* Reader present, no card: Idle (blue-ish) */
.status-badge[data-phase='idle'][data-media='none'] {
  border-color: #38bdf8;
  background: #022c3a;
}
.status-badge[data-phase='idle'][data-media='none'] .dot {
  background: #38bdf8;
}

/* Reader present, card status unknown: Checking... (indigo) */
.status-badge[data-phase='idle'][data-media='unknown'] {
  border-color: #6366f1;
  background: #111827;
}
.status-badge[data-phase='idle'][data-media='unknown'] .dot {
  background: #6366f1;
}

/* Reader present, card present, idle: Ready (green) */
.status-badge[data-phase='idle'][data-media='present'] {
  border-color: #22c55e;
  background: #022c22;
}
.status-badge[data-phase='idle'][data-media='present'] .dot {
  background: #22c55e;
}

/* Busy (yellow/amber) */
.status-badge[data-phase='busy'] {
  border-color: #facc15;
  background: #3b2900;
}
.status-badge[data-phase='busy'] .dot {
  background: #facc15;
}

/* Error (red) */
.status-badge[data-phase='error'] {
  border-color: #ef4444;
  background: #450a0a;
}
.status-badge[data-phase='error'] .dot {
  background: #ef4444;
}

/* Advanced panel */
.advanced-panel {
  margin-top: 4px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px dashed #4b5563;
  background: #020617;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.76rem;
}

.advanced-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.advanced-row .label {
  opacity: 0.7;
  min-width: 64px;
}
.advanced-row .value {
  text-align: right;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
    'Courier New', monospace;
}
.dim {
  opacity: 0.6;
}

/* Chips */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid #374151;
  background: #020617;
  font-size: 0.72rem;
}

/* Current op */
.op-panel {
  border-radius: 6px;
  border: 1px solid #374151;
  background: #020617;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.78rem;
}

.op-head {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  align-items: baseline;
}

.op-kind {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.dot-small {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: #22c55e;
}

.op-paths {
  opacity: 0.8;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
    'Courier New', monospace;
  font-size: 0.72rem;
}

.op-progress-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.op-progress-bar {
  position: relative;
  width: 100%;
  height: 6px;
  border-radius: 999px;
  background: #020617;
  overflow: hidden;
  border: 1px solid #1f2937;
}
.op-progress-fill {
  position: absolute;
  inset: 0;
  width: 0%;
  background: linear-gradient(90deg, #22c55e, #a3e635);
  transition: width 120ms linear;
}

.op-progress-meta {
  display: flex;
  justify-content: space-between;
  font-size: 0.72rem;
  opacity: 0.85;
}
.op-progress-meta .pct {
  font-variant-numeric: tabular-nums;
}
.op-progress-meta .bytes {
  font-variant-numeric: tabular-nums;
}

.op-message {
  font-size: 0.76rem;
  opacity: 0.9;
}

/* Error banner */
.error-banner {
  margin-top: 2px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid #ef4444;
  background: #450a0a;
  font-size: 0.76rem;
}

/* FS panel */
.fs-panel {
  margin-top: 4px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px dashed #4b5563;
  background: #020617;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.78rem;
}

.fs-header {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: baseline;
}

.fs-path .label {
  opacity: 0.7;
  margin-right: 4px;
}
.fs-path .value {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
    'Courier New', monospace;
}

.fs-empty {
  opacity: 0.7;
  text-align: center;
  padding: 10px 4px;
}

.fs-list {
  max-height: 200px;
  overflow-y: auto;
  border-radius: 4px;
  border: 1px solid #111827;
  background: #020617;
}

.fs-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid #030712;
}
.fs-row:last-child {
  border-bottom: none;
}

.fs-row .name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.fs-row .icon {
  width: 16px;
  text-align: center;
}

.fs-row .meta {
  display: inline-flex;
  gap: 6px;
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
  font-size: 0.72rem;
}

.fs-row[data-kind='dir'] .name {
  color: #e5e7eb;
}
.fs-row[data-kind='file'] .name {
  color: #d1d5db;
}

/* Responsive */
@media (max-width: 720px) {
  .fs-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .op-head {
    flex-direction: column;
    align-items: flex-start;
  }

  .advanced-row {
    flex-direction: column;
    align-items: flex-start;
  }
  .advanced-row .value {
    text-align: left;
  }
}
</style>