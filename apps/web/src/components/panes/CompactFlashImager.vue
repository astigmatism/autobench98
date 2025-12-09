<template>
  <div class="cf-pane" :style="{ '--pane-fg': paneFg, '--panel-fg': panelFg }">
    <!-- Hotspot region: only hovering here shows the advanced settings button -->
    <div class="cf-advanced-hotspot">
      <button
        class="gear-btn"
        :aria-expanded="showAdvanced ? 'true' : 'false'"
        aria-controls="cf-advanced-panel"
        title="Show CF reader details"
        @click="showAdvanced = !showAdvanced"
      >
        ⚙️
      </button>
    </div>

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

      <!-- Body (everything below the header, including modal overlay) -->
      <div class="panel-body">
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

        <!-- File system toolbar (outside the browsing window) -->
        <div class="fs-toolbar">
          <div class="fs-toolbar-left">
            <button
              class="btn"
              type="button"
              :disabled="!canGoUp"
              @click="onGoUpClick"
              title="Go to parent folder"
            >
              Parent
            </button>

            <label class="fs-path">
              <span class="label">Path:</span>
              <input
                class="fs-path-input"
                type="text"
                v-model="pathInput"
                spellcheck="false"
              />
            </label>

            <button
              class="btn"
              type="button"
              @click="onNewFolderClick"
              title="Create new folder"
            >
              New Folder
            </button>

            <button
              class="btn"
              type="button"
              :disabled="!canRename"
              @click="onRenameClick"
              title="Rename selected item"
            >
              Rename
            </button>

            <button
              class="btn"
              type="button"
              :disabled="!canDelete"
              @click="onDeleteClick"
              title="Delete selected item(s)"
            >
              Delete
            </button>
          </div>

          <!-- Right side currently unused; kept for layout symmetry -->
          <div class="fs-toolbar-right"></div>
        </div>

        <!-- File system browser window -->
        <div class="fs-panel">
          <div v-if="sortedEntries.length === 0" class="fs-empty">
            No entries in this directory.
          </div>

          <div v-else class="fs-list">
            <div
              v-for="entry in sortedEntries"
              :key="entryKey(entry)"
              class="fs-row"
              :data-kind="entry.kind"
              :data-selected="isSelected(entry) ? 'true' : 'false'"
              @click.stop.prevent="onEntryClick($event, entry)"
              @dblclick.stop.prevent="onEntryDblClick(entry)"
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

          <!-- Shim overlay while FS is busy (blocks clicks, dims content) -->
          <div v-if="fsBusy" class="fs-shim">
            <div class="fs-shim-inner">
              <span class="spinner shim-spinner"></span>
              <span class="fs-shim-text">Refreshing…</span>
            </div>
          </div>
        </div>

        <!-- Footer: metadata (left) + actions (right) -->
        <div class="fs-footer">
          <div class="fs-meta-text">
            {{ sortedEntries.length }} item<span v-if="sortedEntries.length !== 1">s</span>
          </div>

          <div class="fs-actions">
            <button
              class="btn"
              type="button"
              :disabled="!canReadImage"
              @click="onReadImageClick"
              title="Read image from CF media (not yet wired)"
            >
              Read image from media
            </button>
            <button
              class="btn"
              type="button"
              :disabled="!canWriteImage"
              @click="onWriteImageClick"
              title="Write image to CF media (not yet wired)"
            >
              Write image to media
            </button>
          </div>
        </div>

        <!-- General-purpose modal dialog overlay -->
        <transition name="fade-modal">
          <div
            v-if="modalVisible"
            class="cf-modal-backdrop"
          >
            <div
              class="cf-modal"
              role="dialog"
              :aria-label="modalTitle || 'Dialog'"
            >
              <button
                class="cf-modal-close"
                type="button"
                @click="closeModal"
                aria-label="Close dialog"
              >
                ×
              </button>

              <h3 class="cf-modal-title">
                {{ modalTitle || 'Action' }}
              </h3>

              <div class="cf-modal-body">
                <!-- Message-only mode (e.g., delete confirmation) -->
                <p
                  v-if="!modalHasInput && modalMessage"
                  class="cf-modal-message"
                >
                  {{ modalMessage }}
                </p>

                <!-- Input mode (new folder / rename) -->
                <label
                  v-if="modalHasInput"
                  class="cf-modal-field"
                >
                  <span class="cf-modal-field-label">
                    {{ modalMessage || 'Enter a value.' }}
                  </span>
                  <input
                    class="cf-modal-input"
                    type="text"
                    v-model="modalInput"
                    spellcheck="false"
                    ref="modalInputRef"
                  />
                </label>
              </div>

              <!-- Button row kept simple for now; wiring comes later -->
              <div class="cf-modal-actions">
                <button
                  type="button"
                  class="btn cf-modal-btn-secondary"
                  @click="closeModal"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="btn cf-modal-btn-primary"
                  @click="confirmModal"
                >
                  OK
                </button>
              </div>
            </div>
          </div>
        </transition>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useMirror } from '@/stores/mirror'
import { getRealtimeClient } from '@/bootstrap'

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
  const [L1, L2] = l1 >= l2 ? [l1, l2] : [l2, 1]
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
/*  Derived view model + sorted entries                                       */
/* -------------------------------------------------------------------------- */

const view = computed(() => cfImager.value)

const statusLabel = computed(() => {
  const { phase, media, device } = view.value

  if (phase === 'disconnected' || !device) return 'Disconnected'
  if (phase === 'busy') return 'Busy'
  if (phase === 'error') return 'Error'
  if (media === 'unknown') return 'Checking...'
  if (media === 'none') return 'No Media'
  if (media === 'present') return 'Media Ready'
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

const sortedEntries = computed<CfImagerFsEntry[]>(() => {
  const entries = view.value.fs?.entries ?? []
  return [...entries].sort((a, b) => {
    if (a.kind === 'dir' && b.kind !== 'dir') return -1
    if (a.kind !== 'dir' && b.kind === 'dir') return 1
    const an = a.name.toLowerCase()
    const bn = b.name.toLowerCase()
    if (an < bn) return -1
    if (an > bn) return 1
    return 0
  })
})

/**
 * Whether we can navigate up one directory from the current cwd.
 */
const canGoUp = computed(() => {
  const cwd = view.value.fs.cwd
  return cwd !== '.' && cwd !== '/'
})

/* -------------------------------------------------------------------------- */
/*  Selection state (single + Cmd-click multi-select)                         */
/* -------------------------------------------------------------------------- */

const selectedNames = ref<string[]>([])

const selectedCount = computed(() => selectedNames.value.length)
const canRename = computed(() => selectedCount.value === 1)
const canDelete = computed(() => selectedCount.value > 0)

function isSelected(entry: CfImagerFsEntry): boolean {
  return selectedNames.value.includes(entry.name)
}

function onEntryClick(ev: MouseEvent, entry: CfImagerFsEntry) {
  const meta = ev.metaKey // Command on macOS
  const name = entry.name

  if (meta) {
    const idx = selectedNames.value.indexOf(name)
    if (idx >= 0) {
      const next = selectedNames.value.slice()
      next.splice(idx, 1)
      selectedNames.value = next
    } else {
      selectedNames.value = [...selectedNames.value, name]
    }
  } else {
    selectedNames.value = [name]
  }
}

/* -------------------------------------------------------------------------- */
/*  Path input + FS activity spinner                                          */
/* -------------------------------------------------------------------------- */

const pathInput = ref('')
const fsBusy = ref(false)

watch(
  () => view.value.fs.cwd,
  (cwd) => {
    pathInput.value = cwd
    fsBusy.value = false
    selectedNames.value = []
  },
  { immediate: true }
)

/* -------------------------------------------------------------------------- */
/*  Media-ready + file selection helpers for bottom action buttons           */
/* -------------------------------------------------------------------------- */

const isMediaReady = computed(() => {
  // Match the "Media Ready" state: reader present, idle, card present.
  return (
    view.value.phase === 'idle' &&
    view.value.media === 'present' &&
    !!view.value.device
  )
})

const hasSelectedFile = computed(() =>
  sortedEntries.value.some(
    (e) => e.kind === 'file' && selectedNames.value.includes(e.name)
  )
)

const canReadImage = computed(() => isMediaReady.value)
const canWriteImage = computed(() => isMediaReady.value && hasSelectedFile.value)

/* -------------------------------------------------------------------------- */
/*  Modal dialog state (general-purpose)                                      */
/* -------------------------------------------------------------------------- */

type ModalMode = 'new-folder' | 'rename' | 'delete' | 'generic'

const modalVisible = ref(false)
const modalMode = ref<ModalMode>('generic')
const modalTitle = ref('')
const modalMessage = ref('')
const modalInput = ref('')
const modalInputRef = ref<HTMLInputElement | null>(null)

const modalHasInput = computed(
  () => modalMode.value === 'new-folder' || modalMode.value === 'rename'
)

function openNewFolderModal() {
  modalMode.value = 'new-folder'
  modalTitle.value = 'Create new folder'
  modalMessage.value = 'Enter a name for the new folder'
  modalInput.value = ''
  modalVisible.value = true
}

function openRenameModal() {
  const firstSelected = selectedNames.value[0] ?? ''
  modalMode.value = 'rename'
  modalTitle.value = 'Rename item'
  modalMessage.value = firstSelected
    ? `Enter a new name for “${firstSelected}”`
    : 'Enter a new name'
  modalInput.value = firstSelected
  modalVisible.value = true
}

function openDeleteModal() {
  const names = selectedNames.value
  const count = names.length

  modalMode.value = 'delete'
  modalTitle.value = count === 1 ? 'Delete item' : 'Delete items'

  if (count === 1) {
    modalMessage.value = `Are you sure you want to delete “${names[0]}”?`
  } else if (count > 1) {
    const preview = names.slice(0, 3).join('", "')
    const suffix = count > 3 ? `, and ${count - 3} more` : ''
    modalMessage.value = `Are you sure you want to delete “${preview}”${suffix}?`
  } else {
    modalMessage.value = 'Are you sure you want to delete the selected item(s)?'
  }

  modalInput.value = ''
  modalVisible.value = true
}

function closeModal() {
  modalVisible.value = false
}

/* -------------------------------------------------------------------------- */
/*  Modal autofocus + keyboard handling                                       */
/* -------------------------------------------------------------------------- */

watch(modalVisible, (visible) => {
  if (visible && modalHasInput.value) {
    requestAnimationFrame(() => {
      const el = modalInputRef.value
      if (el) {
        el.focus()
        if (modalMode.value === 'rename') {
          const len = el.value.length
          el.setSelectionRange(len, len)
        }
      }
    })
  }
})

function confirmModal() {
  // For now, OK behaves the same as close for all modes.
  // Later we will branch based on modalMode.value to:
  //  - create folder
  //  - rename
  //  - delete
  closeModal()
}

function handleModalKey(ev: KeyboardEvent) {
  if (!modalVisible.value) return

  if (ev.key === 'Escape') {
    ev.preventDefault()
    closeModal()
  }

  if (ev.key === 'Enter') {
    ev.preventDefault()
    confirmModal()
  }
}

/* -------------------------------------------------------------------------- */
/*  Advanced toggle                                                           */
/* -------------------------------------------------------------------------- */

const showAdvanced = ref(false)

/* -------------------------------------------------------------------------- */
/*  WS wiring for CF commands                                                 */
/* -------------------------------------------------------------------------- */

function sendCfImagerCommand(kind: 'changeDir' | 'changeDirUp', name?: string) {
  const ws = getRealtimeClient()
  if (!ws) return
  const payload: any = { kind }
  if (typeof name === 'string') payload.name = name
  ws.send({ type: 'cf-imager.command', payload })
}

function onEntryDblClick(entry: CfImagerFsEntry) {
  if (entry.kind === 'dir') {
    fsBusy.value = true
    sendCfImagerCommand('changeDir', entry.name)
  }
}

function onGoUpClick() {
  if (!canGoUp.value) return
  fsBusy.value = true
  sendCfImagerCommand('changeDirUp')
}

/**
 * Stub actions for future wiring.
 */
function onNewFolderClick() {
  openNewFolderModal()
}

function onRenameClick() {
  if (!canRename.value) return
  openRenameModal()
}

function onDeleteClick() {
  if (!canDelete.value) return
  openDeleteModal()
}

function onReadImageClick() {
  // TODO: implement "read image from media" operation
}

function onWriteImageClick() {
  // TODO: implement "write image to media" operation
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle: global key listener                                            */
/* -------------------------------------------------------------------------- */

onMounted(() => {
  window.addEventListener('keydown', handleModalKey)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleModalKey)
})

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function entryKey(entry: CfImagerFsEntry): string {
  return `${entry.kind}::${entry.name}`
}

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

/* Hotspot area for advanced-settings button (top-right).
   Only hovering this region will reveal the button.
   z-index ensures it floats above pane content. */
.cf-advanced-hotspot {
  position: absolute;
  top: 0;
  right: 0;
  width: 3.2rem;
  height: 2.2rem;
  pointer-events: auto;
  z-index: 30;
}

/* Gear button for advanced settings */
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
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity 120ms ease,
    background 120ms ease,
    border-color 120ms ease,
    transform 60ms ease;
  z-index: 31;
}

/* Show button only when hotspot hovered or button focused */
.cf-advanced-hotspot:hover .gear-btn {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
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

/* Body wraps everything under the header (for modal positioning) */
.panel-body {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
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

/* Generic panel-styled button (similar to logs/Atlona) */
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
    box-shadow 120ms ease,
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

.btn:disabled {
  opacity: 0.5;
  cursor: default;
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
  position: relative; /* anchor for shim overlay */
}

/* Toolbar layout: path first on the left, empty right */
.fs-toolbar {
  margin-top: 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 0.78rem;
}

.fs-toolbar-left {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.fs-toolbar-right {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 40px;
}

/* Path display / input */
.fs-path {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.fs-path .label {
  opacity: 0.7;
}

.fs-path-input {
  --control-h: 28px;

  background: #020617;
  color: var(--panel-fg);
  border: 1px solid #374151;
  border-radius: 6px;
  padding: 0 8px;
  min-width: 180px;
  font-size: 0.76rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
    'Courier New', monospace;
  height: var(--control-h);
  line-height: var(--control-h);
}

/* Spinner (used by shim) */
.spinner {
  width: 16px;
  height: 16px;
  border-radius: 999px;
  border: 2px solid #4b5563;
  border-top-color: #e5e7eb;
  animation: cf-spin 700ms linear infinite;
}

@keyframes cf-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* Empty state */
.fs-empty {
  opacity: 0.7;
  text-align: center;
  padding: 10px 4px;
}

/* List */
.fs-list {
  max-height: 200px;
  overflow-y: auto;
  border-radius: 4px;
  border: 1px solid #111827;
  background: #020617;
  -webkit-user-select: none;
  user-select: none;
}

.fs-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid #030712;
  cursor: default;
  -webkit-user-select: none;
  user-select: none;
}
.fs-row * {
  -webkit-user-select: none;
  user-select: none;
}

.fs-row:last-child {
  border-bottom: none;
}

.fs-row:hover {
  background: #030712;
}

/* Selected rows */
.fs-row[data-selected='true'] {
  background: #0b1120;
  border-bottom-color: #1f2937;
}
.fs-row[data-selected='true'] .name {
  color: #e5e7eb;
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

/* Shim overlay while FS is busy */
.fs-shim {
  position: absolute;
  inset: 6px 8px; /* roughly align with list bounds */
  border-radius: 4px;
  background: rgba(15, 23, 42, 0.7); /* dark, semi-transparent */
  backdrop-filter: blur(1px);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: all; /* block interaction with list */
  z-index: 2;
}

.fs-shim-inner {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8rem;
  color: #e5e7eb;
  opacity: 0.95;
}

.shim-spinner {
  width: 18px;
  height: 18px;
  border-width: 2px;
}

.fs-shim-text {
  letter-spacing: 0.02em;
}

/* Footer: metadata + actions */
.fs-footer {
  margin-top: 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.fs-meta-text {
  font-size: 0.72rem;
  opacity: 0.75;
  align-self: flex-start;
}

.fs-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

/* Modal overlay (blocks panel-body, leaves header visible) */
.cf-modal-backdrop {
  position: absolute;
  inset: 0;
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.92);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  pointer-events: all;
}

.cf-modal {
  position: relative;
  min-width: 260px;
  max-width: 360px;
  padding: 10px 12px 10px 12px;
  border-radius: 10px;
  border: 1px solid #4b5563;
  background: radial-gradient(circle at top left, #111827, #020617 60%);
  box-shadow:
    0 18px 45px rgba(0, 0, 0, 0.65),
    0 0 0 1px rgba(15, 23, 42, 0.9);
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.8rem;
  color: #e5e7eb;
}

.cf-modal-title {
  font-size: 0.86rem;
  font-weight: 600;
  margin-right: 20px;
}

.cf-modal-body {
  margin-top: 4px;
}

.cf-modal-message {
  font-size: 0.8rem;
  line-height: 1.4;
  opacity: 0.95;
}

.cf-modal-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 2px;
}

.cf-modal-field-label {
  font-size: 0.78rem;
  opacity: 0.9;
}

.cf-modal-input {
  --control-h: 28px;

  background: #020617;
  color: #e5e7eb;
  border-radius: 6px;
  border: 1px solid #4b5563;
  padding: 0 8px;
  font-size: 0.76rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
    'Courier New', monospace;
  height: var(--control-h);
  line-height: var(--control-h);
}

.cf-modal-close {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid #4b5563;
  background: #020617;
  color: #e5e7eb;
  cursor: pointer;
  font-size: 0.9rem;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition:
    background 120ms ease,
    border-color 120ms ease,
    transform 60ms ease;
}
.cf-modal-close:hover {
  background: #111827;
  border-color: #9ca3af;
  transform: translateY(-1px);
}

.cf-modal-actions {
  margin-top: 6px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.cf-modal-btn-secondary {
  background: #020617;
}
.cf-modal-btn-secondary:hover:not(:disabled) {
  background: #030712;
}

.cf-modal-btn-primary {
  border-color: #22c55e;
  background: #065f46;
}
.cf-modal-btn-primary:hover:not(:disabled) {
  background: #047857;
}

/* Modal fade transition */
.fade-modal-enter-active,
.fade-modal-leave-active {
  transition: opacity 160ms ease;
}
.fade-modal-enter-from,
.fade-modal-leave-to {
  opacity: 0;
}

/* Responsive */
@media (max-width: 720px) {
  .fs-toolbar {
    flex-direction: column;
    align-items: flex-start;
  }

  .fs-toolbar-right {
    align-self: stretch;
    justify-content: flex-start;
  }

  .fs-footer {
    flex-direction: column;
    align-items: flex-start;
  }

  .fs-actions {
    align-self: flex-end;
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

  .cf-modal {
    width: 100%;
    max-width: none;
    margin: 0 8px;
  }
}
</style>