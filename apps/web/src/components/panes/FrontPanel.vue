<!-- apps/web/src/components/panes/FrontPanelPane.vue -->
<template>
  <div class="frontpanel-pane" :style="{ '--pane-fg': paneFg, '--panel-fg': panelFg }">
    <div class="panel">
      <div class="panel-head">
        <span class="panel-title">Front Panel</span>

        <span class="status-badge" :data-phase="fp.phase">
          <span class="dot"></span>
          <span class="label">{{ statusLabel }}</span>
        </span>
      </div>

      <div class="meta-row">
        <div class="meta">
          <div class="k">Device</div>
          <div class="v mono">{{ fp.devicePath ?? '—' }}</div>
        </div>
        <div class="meta">
          <div class="k">Baud</div>
          <div class="v mono">{{ fp.baudRate ?? '—' }}</div>
        </div>
        <div class="meta">
          <div class="k">Queue</div>
          <div class="v mono">{{ fp.queueDepth }}</div>
        </div>
      </div>

      <div class="telemetry">
        <div class="tile">
          <div class="k">PWR Sense</div>
          <div class="v" :data-tone="powerSenseTone">{{ powerSenseLabel }}</div>
        </div>

        <div class="tile">
          <div class="k">HDD</div>
          <div class="v" :data-tone="fp.hddActive ? 'on' : 'off'">
            <span class="dot-sm" :data-on="fp.hddActive ? 'true' : 'false'"></span>
            {{ fp.hddActive ? 'ACTIVE' : 'IDLE' }}
          </div>
        </div>

        <div class="tile">
          <div class="k">PWR Btn</div>
          <div class="v" :data-tone="fp.powerButtonHeld ? 'on' : 'off'">
            {{ fp.powerButtonHeld ? 'ACTIVE' : 'OFF' }}
          </div>
        </div>

        <div class="tile" v-if="fp.lastError">
          <div class="k">Last Error</div>
          <div class="v err">
            {{ fp.lastError.scope }}: {{ fp.lastError.message }}
          </div>
        </div>
      </div>

      <!-- Controls: ONE power button + ONE reset button (hold-down semantics) -->
      <div class="controls">
        <button
          class="btn"
          :data-held="powerHeldByClient ? 'true' : 'false'"
          :disabled="!canInteract"
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
          class="btn danger"
          :data-held="resetHeldByClient ? 'true' : 'false'"
          :disabled="!canInteract"
          @mousedown.prevent="onResetHoldStart"
          @mouseup.prevent="onResetHoldEnd"
          @mouseleave.prevent="onResetHoldEnd"
          @touchstart.prevent="onResetHoldStart"
          @touchend.prevent="onResetHoldEnd"
          @touchcancel.prevent="onResetHoldEnd"
        >
          Reset
        </button>

        <button class="btn subtle" :disabled="!canInteract" @click="onCancelAll">
          Cancel All
        </button>
      </div>

      <!-- Recent ops (compact, last 5) -->
      <div class="ops" v-if="recentOps.length > 0">
        <div class="ops-head">Recent Ops</div>
        <div class="ops-list">
          <div class="op" v-for="op in recentOps" :key="op.id">
            <span class="op-kind mono">{{ op.kind }}</span>
            <span class="op-status" :data-status="op.status">{{ op.status }}</span>
          </div>
        </div>
      </div>

      <div class="hint" v-if="!canInteract">
        Controls are enabled when phase is <span class="mono">ready</span> and <span class="mono">identified</span>.
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useMirror } from '@/stores/mirror'
import { getRealtimeClient } from '@/bootstrap'

/**
 * Pane context (per contract)
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
/*  Front panel state via WS mirror                                           */
/* -------------------------------------------------------------------------- */

type FrontPanelPhase = 'disconnected' | 'connecting' | 'identifying' | 'ready' | 'error'
type FrontPanelPowerSense = 'on' | 'off' | 'unknown'

type FrontPanelError = {
  at: number
  scope: string
  message: string
  retryable?: boolean
}

type FrontPanelOperationSummary = {
  id: string
  kind: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | string
  createdAt: number
  requestedBy?: string
  label?: string
}

type FrontPanelSnapshot = {
  phase: FrontPanelPhase
  identified: boolean

  deviceId: string | null
  devicePath: string | null
  baudRate: number | null

  powerSense: FrontPanelPowerSense
  hddActive: boolean
  powerButtonHeld: boolean

  busy: boolean
  queueDepth: number
  currentOp: FrontPanelOperationSummary | null

  lastError: FrontPanelError | null
  errorHistory: FrontPanelError[]
  operationHistory: FrontPanelOperationSummary[]

  updatedAt: number
}

const mirror = useMirror()

const initialFp: FrontPanelSnapshot = {
  phase: 'connecting',
  identified: false,

  deviceId: null,
  devicePath: null,
  baudRate: null,

  powerSense: 'unknown',
  hddActive: false,
  powerButtonHeld: false,

  busy: false,
  queueDepth: 0,
  currentOp: null,

  lastError: null,
  errorHistory: [],
  operationHistory: [],

  updatedAt: Date.now()
}

const fp = computed<FrontPanelSnapshot>(() => {
  const root = mirror.data as any
  const slice = root?.frontPanel as FrontPanelSnapshot | undefined
  return slice ?? initialFp
})

/* -------------------------------------------------------------------------- */
/*  Derived bits                                                              */
/* -------------------------------------------------------------------------- */

const statusLabel = computed(() => {
  switch (fp.value.phase) {
    case 'ready':
      return 'Connected'
    case 'identifying':
      return 'Identifying…'
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

const canInteract = computed(() => fp.value.phase === 'ready' && fp.value.identified)

const powerSenseLabel = computed(() => {
  if (fp.value.powerSense === 'on') return 'ON'
  if (fp.value.powerSense === 'off') return 'OFF'
  return 'UNKNOWN'
})

const powerSenseTone = computed(() => {
  if (fp.value.powerSense === 'on') return 'on'
  if (fp.value.powerSense === 'off') return 'off'
  return 'unknown'
})

const recentOps = computed(() => (fp.value.operationHistory ?? []).slice(0, 5))

/* -------------------------------------------------------------------------- */
/*  Local client-side hold tracking                                           */
/* -------------------------------------------------------------------------- */

const powerHeldByClient = ref(false)
const resetHeldByClient = ref(false)

watch(
  canInteract,
  (ok) => {
    if (!ok) {
      powerHeldByClient.value = false
      resetHeldByClient.value = false
    }
  },
  { immediate: true }
)

/* -------------------------------------------------------------------------- */
/*  WS send                                                                   */
/* -------------------------------------------------------------------------- */

function sendFrontPanel(kind: string, payload: Record<string, unknown> = {}) {
  const ws = getRealtimeClient()
  if (!ws) return
  ws.send({
    type: 'frontpanel.command',
    payload: {
      kind,
      requestedBy: 'frontpanel-pane',
      ...payload
    }
  })
}

/* -------------------------------------------------------------------------- */
/*  Controls                                                                  */
/* -------------------------------------------------------------------------- */

function onPowerHoldStart() {
  if (!canInteract.value) return
  if (powerHeldByClient.value) return
  powerHeldByClient.value = true
  sendFrontPanel('powerHold')
}

function onPowerHoldEnd() {
  const wasHeld = powerHeldByClient.value
  powerHeldByClient.value = false
  if (!canInteract.value) return
  if (!wasHeld) return
  sendFrontPanel('powerRelease')
}

function onResetHoldStart() {
  if (!canInteract.value) return
  if (resetHeldByClient.value) return
  resetHeldByClient.value = true
  sendFrontPanel('resetHold')
}

function onResetHoldEnd() {
  const wasHeld = resetHeldByClient.value
  resetHeldByClient.value = false
  if (!canInteract.value) return
  if (!wasHeld) return
  sendFrontPanel('resetRelease')
}

function onCancelAll() {
  if (!canInteract.value) return
  sendFrontPanel('cancelAll', { reason: 'cancelled-by-ui' })
}

onBeforeUnmount(() => {
  // Best-effort release to avoid “stuck hold” if the pane unmounts mid-hold.
  if (powerHeldByClient.value) {
    powerHeldByClient.value = false
    sendFrontPanel('powerRelease')
  }
  if (resetHeldByClient.value) {
    resetHeldByClient.value = false
    sendFrontPanel('resetRelease')
  }
})
</script>

<style scoped>
.frontpanel-pane {
  --pane-fg: #111;
  --panel-fg: #e6e6e6;

  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  width: 100%;
  min-width: 0;
  min-height: 0;
  color: var(--pane-fg);
}

.panel {
  background: #0b0d12;
  border: 1px solid #1f2933;
  border-radius: 8px;
  padding: 8px;
  color: var(--panel-fg);
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

/* Header */
.panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
  font-size: 0.8rem;
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
.status-badge[data-phase='ready'] {
  border-color: #22c55e;
  background: #022c22;
}
.status-badge[data-phase='ready'] .dot {
  background: #22c55e;
}
.status-badge[data-phase='connecting'],
.status-badge[data-phase='identifying'] {
  border-color: #facc15;
  background: #3b2900;
}
.status-badge[data-phase='connecting'] .dot,
.status-badge[data-phase='identifying'] .dot {
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

.meta-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.meta {
  border: 1px solid #1f2933;
  background: #020617;
  border-radius: 8px;
  padding: 6px 8px;
  min-width: 0;
}
.meta .k {
  font-size: 0.7rem;
  color: #9ca3af;
}
.meta .v {
  font-size: 0.8rem;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.telemetry {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.tile {
  border: 1px solid #1f2933;
  background: #020617;
  border-radius: 8px;
  padding: 8px;
  min-width: 0;
}
.tile .k {
  font-size: 0.7rem;
  color: #9ca3af;
}
.tile .v {
  font-size: 0.9rem;
  font-weight: 600;
  margin-top: 4px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tile .v[data-tone='on'] {
  color: #86efac;
}
.tile .v[data-tone='off'] {
  color: #e5e7eb;
}
.tile .v[data-tone='unknown'] {
  color: #facc15;
}
.tile .v.err {
  color: #fecaca;
  font-weight: 500;
  font-size: 0.8rem;
}

.dot-sm {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #6b7280;
  display: inline-block;
}
.dot-sm[data-on='true'] {
  background: #22c55e;
}

.controls {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.btn {
  padding: 10px 8px;
  border-radius: 8px;
  border: 1px solid #374151;
  background: #020617;
  color: var(--panel-fg);
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 600;
  text-align: center;
  transition:
    background 120ms ease,
    border-color 120ms ease,
    transform 60ms ease,
    box-shadow 120ms ease;
  user-select: none;
}
.btn:hover:not(:disabled) {
  background: #030712;
  transform: translateY(-1px);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.btn[data-held='true'] {
  border-color: #22c55e;
  background: #064e3b;
  box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.25);
}
.btn.danger {
  border-color: #7f1d1d;
}
.btn.danger:hover:not(:disabled) {
  border-color: #ef4444;
}
.btn.subtle {
  border-color: #334155;
  color: #cbd5e1;
}

.ops {
  border-top: 1px solid #1f2933;
  padding-top: 8px;
}
.ops-head {
  font-size: 0.75rem;
  color: #9ca3af;
  margin-bottom: 6px;
}
.ops-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.op {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  border: 1px solid #1f2933;
  background: #020617;
  border-radius: 8px;
  padding: 6px 8px;
}
.op-kind {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.op-status {
  font-size: 0.75rem;
  color: #cbd5e1;
}
.op-status[data-status='failed'] {
  color: #fecaca;
}
.op-status[data-status='completed'] {
  color: #86efac;
}
.op-status[data-status='running'],
.op-status[data-status='queued'] {
  color: #facc15;
}

.hint {
  font-size: 0.75rem;
  color: #9ca3af;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
}

/* Responsive */
@media (max-width: 720px) {
  .meta-row {
    grid-template-columns: minmax(0, 1fr);
  }
  .telemetry {
    grid-template-columns: minmax(0, 1fr);
  }
  .controls {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
