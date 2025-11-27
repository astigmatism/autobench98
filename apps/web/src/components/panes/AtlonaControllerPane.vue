<template>
  <div class="atlona-pane" :style="{ '--pane-fg': paneFg, '--panel-fg': panelFg }">
    <div class="panel">
      <!-- Header: title (left) + status badge (right) -->
      <div class="panel-head">
        <span class="panel-title">Atlona Controller</span>

        <span class="status-badge" :data-phase="atlona.phase">
          <span class="dot"></span>
          <span class="label">{{ statusLabel }}</span>
        </span>
      </div>

      <!-- Main control: three buttons only -->
      <div class="switch-row">
        <button
          class="switch-btn"
          :data-held="heldByClient[1] ? 'true' : 'false'"
          :disabled="!canInteract"
          @mousedown.prevent="onHoldStart(1)"
          @mouseup.prevent="onHoldEnd(1)"
          @mouseleave.prevent="onHoldEnd(1)"
          @touchstart.prevent="onHoldStart(1)"
          @touchend.prevent="onHoldEnd(1)"
          @touchcancel.prevent="onHoldEnd(1)"
        >
          Menu
        </button>

        <button
          class="switch-btn"
          :data-held="heldByClient[2] ? 'true' : 'false'"
          :disabled="!canInteract"
          @mousedown.prevent="onHoldStart(2)"
          @mouseup.prevent="onHoldEnd(2)"
          @mouseleave.prevent="onHoldEnd(2)"
          @touchstart.prevent="onHoldStart(2)"
          @touchend.prevent="onHoldEnd(2)"
          @touchcancel.prevent="onHoldEnd(2)"
        >
          −
        </button>

        <button
          class="switch-btn"
          :data-held="heldByClient[3] ? 'true' : 'false'"
          :disabled="!canInteract"
          @mousedown.prevent="onHoldStart(3)"
          @mouseup.prevent="onHoldEnd(3)"
          @mouseleave.prevent="onHoldEnd(3)"
          @touchstart.prevent="onHoldStart(3)"
          @touchend.prevent="onHoldEnd(3)"
          @touchcancel.prevent="onHoldEnd(3)"
        >
          +
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue'
import { useMirror } from '@/stores/mirror'
import { getRealtimeClient } from '@/bootstrap'

/**
 * Pane context (same pattern as logs / power meter panes)
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
/*  Atlona controller state via WS mirror                                     */
/* -------------------------------------------------------------------------- */

type AtlonaControllerPhase = 'disconnected' | 'connecting' | 'ready' | 'error'
type AtlonaSwitchId = 1 | 2 | 3

type AtlonaSwitchState = {
  isHeld: boolean
}

type AtlonaSwitchMap = Record<AtlonaSwitchId, AtlonaSwitchState>

type AtlonaControllerSnapshot = {
  phase: AtlonaControllerPhase
  message?: string
  identified: boolean
  switches: AtlonaSwitchMap
}

const mirror = useMirror()

const initialAtlona: AtlonaControllerSnapshot = {
  phase: 'connecting',
  message: 'Waiting for Atlona controller…',
  identified: false,
  switches: {
    1: { isHeld: false },
    2: { isHeld: false },
    3: { isHeld: false }
  }
}

const atlona = computed<AtlonaControllerSnapshot>(() => {
  const root = mirror.data as any
  const slice = root?.atlonaController as AtlonaControllerSnapshot | undefined
  return slice ?? initialAtlona
})

/* -------------------------------------------------------------------------- */
/*  Derived bits                                                              */
/* -------------------------------------------------------------------------- */

const statusLabel = computed(() => {
  const phase = atlona.value.phase
  const identified = atlona.value.identified

  switch (phase) {
    case 'ready':
      return 'Connected'
    case 'connecting':
      // Once we’ve *ever* identified the controller, treat further connecting
      // as a reconnect attempt.
      return identified ? 'Reconnecting…' : 'Connecting…'
    case 'disconnected':
      return 'Disconnected'
    case 'error':
      return 'Error'
    default:
      return 'Unknown'
  }
})

const canInteract = computed(
  () => atlona.value.phase === 'ready' && atlona.value.identified
)

/* -------------------------------------------------------------------------- */
/*  Local client-side hold tracking                                           */
/* -------------------------------------------------------------------------- */

/**
 * We must only send a "release" after we've sent a "hold" for that switch.
 * Mouseleave / touchend can fire even when the button is not pressed, so we
 * keep a small local map of which switches are currently held *by this client*.
 * This map also drives the green highlight so feedback is instant.
 */
const heldByClient = reactive<Record<AtlonaSwitchId, boolean>>({
  1: false,
  2: false,
  3: false
})

/* -------------------------------------------------------------------------- */
/*  WS wiring: hold / release mapped to WS messages                           */
/* -------------------------------------------------------------------------- */

function sendAtlonaCommand(kind: 'hold' | 'release', switchId: AtlonaSwitchId) {
  const ws = getRealtimeClient()
  if (!ws) return
  ws.send({
    type: 'atlona.command',
    payload: {
      kind,
      switchId
    }
  })
}

function onHoldStart(id: AtlonaSwitchId) {
  if (!canInteract.value) return

  // If we already think this switch is held, don't send duplicate "hold".
  if (heldByClient[id]) return

  heldByClient[id] = true
  sendAtlonaCommand('hold', id)
}

function onHoldEnd(id: AtlonaSwitchId) {
  const wasHeld = heldByClient[id]
  heldByClient[id] = false

  // If the UI isn't in an interactive state, don't send a release.
  if (!canInteract.value) return

  // Only send "release" if we *actually* had a prior "hold" for this switch.
  if (!wasHeld) return

  sendAtlonaCommand('release', id)
}
</script>

<style scoped>
.atlona-pane {
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

/* Header: title left, badge right */
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

/* phase styles */
.status-badge[data-phase='ready'] {
  border-color: #22c55e;
  background: #022c22;
}
.status-badge[data-phase='ready'] .dot {
  background: #22c55e;
}
.status-badge[data-phase='connecting'] {
  border-color: #facc15;
  background: #3b2900;
}
.status-badge[data-phase='connecting'] .dot {
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

/* Main three-button layout */
.switch-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.switch-btn {
  padding: 10px 8px;
  border-radius: 8px;
  border: 1px solid #374151;
  background: #020617;
  color: var(--panel-fg);
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 500;
  text-align: center;
  transition:
    background 120ms ease,
    border-color 120ms ease,
    transform 60ms ease,
    box-shadow 120ms ease;
  user-select: none;
}

.switch-btn:hover:not(:disabled) {
  background: #030712;
  transform: translateY(-1px);
}

/* Immediate “held” feedback driven by heldByClient via data-held */
.switch-btn[data-held='true'] {
  border-color: #22c55e;
  background: #064e3b;
  box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.25);
}

.switch-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* Responsive */
@media (max-width: 720px) {
  .switch-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>