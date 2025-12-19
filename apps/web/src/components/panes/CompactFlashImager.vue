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
          <span
            class="dot"
            :class="{ 'dot--pulse': view.phase === 'busy' }"
          ></span>
          <span class="label">{{ statusLabel }}</span>
        </span>
      </div>

      <!-- Body (everything below the header, including modal overlays) -->
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

            <label class="fs-path">
              <span class="label">Search:</span>
              <div class="fs-path-input-wrap">
                <input
                  class="fs-path-input"
                  type="text"
                  v-model="pathInput"
                  spellcheck="false"
                  placeholder=""
                />
                <button
                  v-if="pathInput"
                  class="fs-path-clear"
                  type="button"
                  @click="onClearSearchClick"
                  aria-label="Clear search"
                  title="Clear search"
                >
                  ×
                </button>
              </div>
            </label>

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

          <div class="fs-toolbar-right"></div>
        </div>

        <!-- File system browser window -->
        <div class="fs-panel">
          <!-- Empty-state -->
          <div
            v-if="sortedEntries.length === 0 && !searchActive && !canGoUp"
            class="fs-empty"
          >
            No entries in this directory.
          </div>
          <div
            v-else-if="sortedEntries.length === 0 && searchActive"
            class="fs-empty"
          >
            No matching items.
          </div>

          <div v-else class="fs-list">
            <!-- Synthetic parent row always at top when we can go up (but not during search) -->
            <div
              v-if="canGoUp && !searchActive"
              class="fs-row"
              data-kind="dir"
              :data-drop-target="dropTargetName === '..' ? 'true' : 'false'"
              @click.stop.prevent="onParentRowClick"
              @dblclick.stop.prevent="onGoUpClick"
              @dragover="onParentRowDragOver"
              @dragenter="onParentRowDragEnter"
              @dragleave="onParentRowDragLeave"
              @drop="onParentRowDrop"
            >
              <span class="name">
                <span class="icon">📁</span>
                ..
              </span>
              <span class="meta"></span>
            </div>

            <!-- Real entries from the backend (or cached search results) -->
            <div
              v-for="entry in sortedEntries"
              :key="entryKey(entry)"
              class="fs-row"
              :data-kind="entry.kind"
              :data-selected="isSelected(entry) ? 'true' : 'false'"
              :data-drop-target="dropTargetName === entry.name ? 'true' : 'false'"
              draggable="true"
              @click.stop.prevent="onEntryClick($event, entry)"
              @dblclick.stop.prevent="onEntryDblClick(entry)"
              @dragstart="onEntryDragStart($event, entry)"
              @dragend="onEntryDragEnd($event)"
              @dragover="onEntryDragOver($event, entry)"
              @dragenter="onEntryDragEnter($event, entry)"
              @dragleave="onEntryDragLeave($event, entry)"
              @drop="onEntryDrop($event, entry)"
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

          <!-- Shim overlay while FS is busy (dir changes / delete refresh / move refresh / search) -->
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
            <span class="fs-meta-path">
              <span class="fs-meta-path-label">Path:</span>
              <span class="fs-meta-path-value">{{ cwdDisplay }}</span>
            </span>

            <span class="fs-meta-sep">•</span>

            <span class="fs-meta-items">
              {{ sortedEntries.length }} item<span v-if="sortedEntries.length !== 1">s</span>
            </span>

            <span v-if="diskFreeDisplay" class="fs-meta-sep">•</span>
            <span v-if="diskFreeDisplay" class="fs-meta-free">{{ diskFreeDisplay }}</span>
          </div>

          <div class="fs-actions">
            <button
              class="btn"
              type="button"
              :disabled="!canReadImage"
              @click="onReadImageClick"
              title="Read an image file from the CF media into this folder"
            >
              Read image from media
            </button>
            <button
              class="btn"
              type="button"
              :disabled="!canWriteImage"
              @click="onWriteImageClick"
              title="Write the selected image file to the CF media"
            >
              Write image to media
            </button>
          </div>
        </div>

        <!-- Shared modal backdrop: dialog + sticky + progress -->
        <transition name="fade-modal">
          <div
            v-if="overlayActive"
            class="cf-modal-backdrop"
          >
            <!-- General-purpose modal dialog (new folder / rename / delete / read-name / write-confirm) -->
            <div
              v-if="modalVisible"
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
                <!-- Message-only mode (e.g., delete / write confirmation) -->
                <p
                  v-if="!modalHasInput && modalMessage"
                  class="cf-modal-message"
                >
                  {{ modalMessage }}
                </p>

                <!-- Input mode (new folder / rename / read image) -->
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

              <!-- Button row -->
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

            <!-- Progress modal overlay (shown while read/write is in progress) -->
            <div
              v-else-if="opProgressVisible"
              class="cf-modal"
              role="dialog"
              aria-label="CF imaging in progress"
            >
              <h3 class="cf-modal-title">
                {{ opLabel }}
              </h3>

              <div class="cf-modal-body">
                <p class="cf-modal-message" v-if="opPathsDisplay">
                  {{ opPathsDisplay }}
                </p>
                <p
                  v-if="opFinalizingMessage"
                  class="cf-modal-message cf-modal-message--finalizing"
                >
                  {{ opFinalizingMessage }}
                </p>

                <div class="cf-modal-progress-block">
                  <div class="cf-modal-progress-bar">
                    <div
                      class="cf-modal-progress-fill"
                      :style="{ width: progressPctDisplay + '%' }"
                    ></div>
                  </div>
                  <div class="cf-modal-progress-meta">
                    <span class="pct">
                      {{ progressPctInt }}%
                    </span>
                    <span class="rate" v-if="opRateDisplay">
                      {{ opRateDisplay }}
                    </span>
                  </div>
                </div>

                <div class="cf-modal-stats">
                  <div class="cf-modal-stat-row" v-if="opBytesDisplay">
                    <span class="label">Transfer:</span>
                    <span class="value">{{ opBytesDisplay }}</span>
                  </div>
                  <div class="cf-modal-stat-row" v-if="opEtaDisplay">
                    <span class="label">Estimated time:</span>
                    <span class="value">{{ opEtaDisplay }}</span>
                  </div>
                </div>
              </div>

              <!-- No buttons: this dialog is informational and closes automatically
                   when the operation completes. -->
            </div>
            <!-- If overlayActive is true only because of stickyOverlay, we just show
                 the bare backdrop with no inner modal, so the UI is blocked but silent. -->
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

const panelFg = '#e6e6e6'

/* -------------------------------------------------------------------------- */
/*  Snapshot types                                                            */
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
  bytesPerSec?: number
  mbPerSec?: number
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
  diskFreeBytes?: number
}

/* -------------------------------------------------------------------------- */
/*  Helpers for cwd normalization                                             */
/* -------------------------------------------------------------------------- */

function normalizeCwd(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed || trimmed === '/' || trimmed === '.') {
    return '.'
  }
  return trimmed
}

/* -------------------------------------------------------------------------- */
/*  Mirror + initial snapshot                                                 */
/* -------------------------------------------------------------------------- */

const mirror = useMirror()

const initialCfImager: CfImagerSnapshot = {
  phase: 'disconnected',
  media: 'none',
  message: 'Waiting for CF imager…',
  device: undefined,
  fs: {
    rootPath: '.',
    cwd: '.',
    entries: []
  },
  currentOp: undefined,
  lastError: undefined,
  diskFreeBytes: undefined
}

const cfImager = computed<CfImagerSnapshot>(() => {
  const root = mirror.data as any
  const slice = root?.cfImager as Partial<CfImagerSnapshot> | undefined
  if (!slice) return initialCfImager

  const fsRaw = slice.fs

  const fs: CfImagerFsState = {
    rootPath: fsRaw?.rootPath ?? '.',
    cwd: normalizeCwd(fsRaw?.cwd),
    entries: fsRaw?.entries ?? []
  }

  const phase: CfImagerPhase = slice.phase ?? 'disconnected'
  let media: CfImagerMediaStatus = slice.media ?? 'none'

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
    lastError: slice.lastError,
    diskFreeBytes: slice.diskFreeBytes
  }
})

const view = computed(() => cfImager.value)

/* -------------------------------------------------------------------------- */
/*  Derived view model                                                        */
/* -------------------------------------------------------------------------- */

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

const progressPctInt = computed(() => {
  const v = progressPctDisplay.value
  if (!Number.isFinite(v)) return 0
  return Math.round(v)
})

/* Progress modal-specific derived state */

const opProgressVisible = computed(() => {
  return view.value.phase === 'busy' && !!view.value.currentOp
})

const opPathsDisplay = computed(() => {
  const op = view.value.currentOp
  if (!op) return ''
  return `${op.source} → ${op.destination}`
})

const opBytesDisplay = computed(() => {
  const op = view.value.currentOp
  if (!op || op.bytesDone == null || op.bytesTotal == null) return ''
  const doneGiB = formatGiB(op.bytesDone)
  const totalGiB = formatGiB(op.bytesTotal)
  if (!doneGiB || !totalGiB) return ''
  return `${doneGiB} / ${totalGiB} GiB`
})

const opRateDisplay = computed(() => {
  const op = view.value.currentOp
  if (!op) return ''
  let mbPerSec = op.mbPerSec
  if (mbPerSec == null && typeof op.bytesPerSec === 'number') {
    mbPerSec = op.bytesPerSec / (1024 * 1024)
  }
  if (mbPerSec == null || !Number.isFinite(mbPerSec) || mbPerSec <= 0) return ''
  return `~${mbPerSec.toFixed(1)} MB/s`
})

const opEtaDisplay = computed(() => {
  const op = view.value.currentOp
  if (!op) return ''

  const { bytesDone, bytesTotal } = op
  if (
    bytesDone == null ||
    bytesTotal == null ||
    !Number.isFinite(bytesDone) ||
    !Number.isFinite(bytesTotal) ||
    bytesTotal <= 0
  ) {
    return ''
  }

  let bytesPerSec = op.bytesPerSec
  if (
    (bytesPerSec == null || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) &&
    typeof op.mbPerSec === 'number'
  ) {
    bytesPerSec = op.mbPerSec * 1024 * 1024
  }

  if (bytesPerSec == null || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
    return ''
  }

  const remainingBytes = bytesTotal - bytesDone
  if (remainingBytes <= 0) {
    // At this point we're effectively in the "finalizing" phase; hide ETA.
    return ''
  }

  const seconds = remainingBytes / bytesPerSec
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return ''
  }

  return formatEta(seconds)
})

/**
 * Finalizing message shown when a write op reports 100% but the phase
 * is still "busy" (kernel / device is flushing the tail of the write).
 */
const opFinalizingMessage = computed(() => {
  const op = view.value.currentOp
  if (!op || op.kind !== 'write') return ''
  const pct = progressPctDisplay.value
  if (!Number.isFinite(pct)) return ''
  if (view.value.phase === 'busy' && pct >= 100) {
    return 'Finalizing write. Please wait...'
  }
  return ''
})

/* -------------------------------------------------------------------------- */
/*  Entries: directory vs search results                                      */
/* -------------------------------------------------------------------------- */

const displayEntries = computed<CfImagerFsEntry[]>(() => {
  if (searchActive.value) {
    // While a search is active, prefer the cached search results so that
    // periodic directory polling from the backend does not clobber the
    // search view.
    return searchResults.value ?? (view.value.fs?.entries ?? [])
  }
  return view.value.fs?.entries ?? []
})

const sortedEntries = computed<CfImagerFsEntry[]>(() => {
  const entries = displayEntries.value
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

const canGoUp = computed(() => {
  const cwd = view.value.fs.cwd
  return cwd !== '.' && cwd !== '/'
})

/* -------------------------------------------------------------------------- */
/*  Disk free + cwd display                                                   */
/* -------------------------------------------------------------------------- */

const diskFreeDisplay = computed(() => {
  const bytes = view.value.diskFreeBytes
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return ''
  return `${formatSize(bytes)} free`
})

const cwdDisplay = computed(() => {
  let cwd = view.value.fs.cwd || '.'

  if (cwd === '.' || cwd === '/') {
    return '/'
  }

  // Normalize to "/foo/bar" style
  if (!cwd.startsWith('/')) {
    cwd = `/${cwd}`
  }

  return cwd
})

/* -------------------------------------------------------------------------- */
/*  Selection + drag state                                                    */
/* -------------------------------------------------------------------------- */

const selectedNames = ref<string[]>([])

const selectedCount = computed(() => selectedNames.value.length)
const canRename = computed(() => selectedCount.value === 1)
const canDelete = computed(() => selectedCount.value > 0)

function isSelected(entry: CfImagerFsEntry): boolean {
  return selectedNames.value.includes(entry.name)
}

function onEntryClick(ev: MouseEvent, entry: CfImagerFsEntry) {
  // Allow Cmd-click (macOS) and Ctrl-click (Linux/Windows) for multi-select
  const multi = ev.metaKey || ev.ctrlKey
  const name = entry.name

  if (multi) {
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

/**
 * Drag-and-drop selection:
 * - dragSelection: the set of names currently being dragged.
 * - dropTargetName: folder name currently highlighted as a drop target.
 * - dragActive: simple boolean flag to gate dragover/drop handling.
 *
 * We let the browser draw the drag ghost (default behavior) instead of
 * providing a custom drag image. This avoids cross-platform issues where
 * a custom image can end up invisible.
 */
const dragSelection = ref<string[]>([])
const dropTargetName = ref<string | null>(null)
const dragActive = ref(false)

function onEntryDragStart(ev: DragEvent, entry: CfImagerFsEntry) {
  const name = entry.name

  // If the entry is already part of the multi-selection, drag all selected.
  // Otherwise, drag just this one and reset selection to it.
  let names: string[]
  if (selectedNames.value.includes(name) && selectedNames.value.length > 0) {
    names = selectedNames.value.slice()
  } else {
    selectedNames.value = [name]
    names = [name]
  }

  dragSelection.value = names
  dragActive.value = true

  const dt = ev.dataTransfer
  if (!dt) return

  try {
    dt.setData('application/x-cf-imager-names', JSON.stringify({ names }))
    dt.effectAllowed = 'move'
    // Do NOT call setDragImage; rely on the browser's default drag ghost.
  } catch {
    // Ignore; drag will still function even if setData fails.
  }
}

function onEntryDragEnd(_ev: DragEvent) {
  dragSelection.value = []
  dragActive.value = false
  dropTargetName.value = null
}

function onEntryDragOver(ev: DragEvent, entry: CfImagerFsEntry) {
  // Only allow dropping on directories, not on files.
  if (!dragActive.value) return
  if (entry.kind !== 'dir') return
  if (dragSelection.value.includes(entry.name)) return

  ev.preventDefault()
  if (ev.dataTransfer) {
    ev.dataTransfer.dropEffect = 'move'
  }
}

function onEntryDragEnter(ev: DragEvent, entry: CfImagerFsEntry) {
  if (!dragActive.value) return
  if (entry.kind !== 'dir') return
  if (dragSelection.value.includes(entry.name)) return

  ev.preventDefault()
  dropTargetName.value = entry.name
}

function onEntryDragLeave(_ev: DragEvent, entry: CfImagerFsEntry) {
  if (dropTargetName.value === entry.name) {
    dropTargetName.value = null
  }
}

function onEntryDrop(ev: DragEvent, entry: CfImagerFsEntry) {
  if (!dragActive.value) return
  if (entry.kind !== 'dir') return

  ev.preventDefault()

  dragActive.value = false
  dropTargetName.value = null

  let names = dragSelection.value.slice()

  // Prefer names from the DataTransfer payload if available.
  const dt = ev.dataTransfer
  if (dt) {
    const raw = dt.getData('application/x-cf-imager-names')
    if (raw) {
      try {
        const parsed: any = JSON.parse(raw)
        if (parsed && Array.isArray(parsed.names) && parsed.names.length > 0) {
          names = parsed.names
        }
      } catch {
        // fall back to dragSelection
      }
    }
  }

  // Nothing to move
  if (!names || names.length === 0) {
    dragSelection.value = []
    return
  }

  // Don't attempt to move a folder into itself
  if (names.includes(entry.name)) {
    dragSelection.value = []
    return
  }

  dragSelection.value = []
  selectedNames.value = []

  // Moving into a real child directory: use the move command.
  fsBusy.value = true

  sendCfImagerCommand('move', {
    names,
    targetDir: entry.name
  })
}

/* -------------------------------------------------------------------------- */
/*  Parent-row click + DnD                                                    */
/* -------------------------------------------------------------------------- */

function onParentRowClick(_ev: MouseEvent) {
  // Clear selection when clicking the ".." row
  selectedNames.value = []
}

function onParentRowDragOver(ev: DragEvent) {
  if (!dragActive.value) return
  if (dragSelection.value.length === 0) return
  ev.preventDefault()
  if (ev.dataTransfer) {
    ev.dataTransfer.dropEffect = 'move'
  }
}

function onParentRowDragEnter(ev: DragEvent) {
  if (!dragActive.value) return
  ev.preventDefault()
  dropTargetName.value = '..'
}

function onParentRowDragLeave(_ev: DragEvent) {
  if (dropTargetName.value === '..') {
    dropTargetName.value = null
  }
}

function onParentRowDrop(ev: DragEvent) {
  if (!dragActive.value) return

  ev.preventDefault()

  dragActive.value = false
  dropTargetName.value = null

  let names = dragSelection.value.slice()

  const dt = ev.dataTransfer
  if (dt) {
    const raw = dt.getData('application/x-cf-imager-names')
    if (raw) {
      try {
        const parsed: any = JSON.parse(raw)
        if (parsed && Array.isArray(parsed.names) && parsed.names.length > 0) {
          names = parsed.names
        }
      } catch {
        // fall back to dragSelection
      }
    }
  }

  if (!names || names.length === 0) {
    dragSelection.value = []
    return
  }

  dragSelection.value = []
  selectedNames.value = []

  // Move items up one directory: targetDir = ".."
  fsBusy.value = true

  sendCfImagerCommand('move', {
    names,
    targetDir: '..'
  })
}

/* -------------------------------------------------------------------------- */
/*  Search input + FS busy + overlay glue                                     */
/* -------------------------------------------------------------------------- */

const pathInput = ref('') // used as a search query, not the literal cwd
const fsBusy = ref(false)

/**
 * Client-side search state:
 * - searchResults: last set of results returned for the active query.
 * - searchInFlight: we just sent a search command and are waiting for the
 *   next fs snapshot to treat as results.
 *
 * This lets us keep showing search results even when the backend's periodic
 * directory polling emits additional cf-fs-updated events.
 */
const searchResults = ref<CfImagerFsEntry[] | null>(null)
const searchInFlight = ref(false)

const SEARCH_MIN_CHARS = 1
const SEARCH_DEBOUNCE_MS = 300

const searchActive = computed(() => {
  const q = (pathInput.value ?? '').trim()
  return q.length >= SEARCH_MIN_CHARS
})

/**
 * stickyOverlay:
 *  - true while we've sent a read/write command but haven't yet seen
 *    currentOp/phase=busy from the backend.
 *  - keeps the full-panel modal backdrop in place (blocking UI) even
 *    after the input dialog is closed and before the progress modal appears.
 */
const stickyOverlay = ref(false)

/**
 * overlayActive drives the shared modal backdrop:
 *  - dialog visible
 *  - OR progress modal visible
 *  - OR stickyOverlay (in-between state)
 */
const overlayActive = computed(
  () => modalVisible.value || opProgressVisible.value || stickyOverlay.value
)

/**
 * When cwd changes (user navigates), clear selection & drag state.
 * We deliberately do NOT overwrite the search box with cwd anymore.
 * Instead, we clear the search query on navigation.
 */
watch(
  () => view.value.fs.cwd,
  () => {
    pathInput.value = ''
    fsBusy.value = false
    selectedNames.value = []
    dragSelection.value = []
    dragActive.value = false
    dropTargetName.value = null
    searchResults.value = null
    searchInFlight.value = false
  },
  { immediate: true }
)

// Clear busy state and selection when entries list size changes (e.g., delete/move/search completes)
watch(
  () => view.value.fs.entries.length,
  () => {
    fsBusy.value = false
    selectedNames.value = []
    dragSelection.value = []
    dragActive.value = false
    dropTargetName.value = null
  }
)

// Capture search results vs normal directory snapshots.
watch(
  () => view.value.fs.entries,
  (entries) => {
    if (searchActive.value && searchInFlight.value) {
      // First snapshot after a search command: treat as canonical results
      // and clear the shim, even if the length hasn't changed.
      searchResults.value = entries.slice()
      searchInFlight.value = false
      fsBusy.value = false
    } else if (!searchActive.value) {
      // When search is cleared, drop any stale results and clear shim for
      // non-search FS updates (e.g., move, delete) that may not change length.
      searchResults.value = null
      searchInFlight.value = false
      fsBusy.value = false
    }
  },
  { deep: true }
)

// When the backend flips into an active imaging op, we no longer need stickyOverlay
watch(opProgressVisible, (vis) => {
  if (vis) stickyOverlay.value = false
})

// Defensive: if we go idle with no current op, clear sticky overlay too
watch(
  () => view.value.phase,
  (phase) => {
    if (phase === 'idle' && !view.value.currentOp) {
      stickyOverlay.value = false
    }
  }
)

/**
 * Search behavior:
 * - With < 2 characters, we treat it as "no search" and ask backend to clear search
 *   but we DO NOT show the FS shim.
 * - With >= 2 characters, we request a recursive search from the current cwd,
 *   and show the shim while we wait.
 * - We debounce to avoid spamming the backend while typing.
 */
let searchTimeout: number | null = null

watch(
  pathInput,
  (raw) => {
    if (searchTimeout !== null) {
      window.clearTimeout(searchTimeout)
      searchTimeout = null
    }

    const query = (raw ?? '').trim()
    const cwd = view.value.fs.cwd || '.'

    searchTimeout = window.setTimeout(() => {
      // If device isn't present or we're disconnected, don't bother sending.
      if (view.value.phase === 'disconnected' || !view.value.device) {
        return
      }

      if (query.length < SEARCH_MIN_CHARS) {
        // Not enough characters: treat as "no search" locally and send a clear
        // hint to the backend, but don't block the UI with the shim.
        searchInFlight.value = false
        searchResults.value = null
        fsBusy.value = false

        sendCfImagerCommand('search', { cwd, query: '' })
      } else {
        // New / updated search query – capture the next fs snapshot as results,
        // and show the busy shim while we wait.
        fsBusy.value = true
        searchInFlight.value = true
        sendCfImagerCommand('search', { cwd, query })
      }
    }, SEARCH_DEBOUNCE_MS) as unknown as number
  }
)

/**
 * Explicit clear handler for the little "×" inside the search input.
 * This:
 *  - clears the input and local search state immediately
 *  - cancels any pending debounce
 *  - sends a "clear search" command to the backend
 */
function onClearSearchClick() {
  // Local state clear
  pathInput.value = ''
  searchResults.value = null
  searchInFlight.value = false
  fsBusy.value = false

  // Cancel any pending debounced search
  if (searchTimeout !== null) {
    window.clearTimeout(searchTimeout)
    searchTimeout = null
  }

  const cwd = view.value.fs.cwd || '.'

  // If device isn't present or we're disconnected, just clear locally
  if (view.value.phase === 'disconnected' || !view.value.device) {
    return
  }

  sendCfImagerCommand('search', { cwd, query: '' })
}

/* -------------------------------------------------------------------------- */
/*  Media-ready + file selection                                              */
/* -------------------------------------------------------------------------- */

const isMediaReady = computed(() => {
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

type ModalMode =
  | 'new-folder'
  | 'rename'
  | 'delete'
  | 'read-image'
  | 'write-confirm'
  | 'generic'

const modalVisible = ref(false)
const modalMode = ref<ModalMode>('generic')
const modalTitle = ref('')
const modalMessage = ref('')
const modalInput = ref('')
const modalInputRef = ref<HTMLInputElement | null>(null)

/**
 * Pending state for write confirmation:
 * - cwd where the selected image resides
 * - fileName (without any hidden extension munging; this is what the backend expects)
 */
const pendingWriteCwd = ref<string | null>(null)
const pendingWriteFileName = ref<string | null>(null)

const modalHasInput = computed(
  () =>
    modalMode.value === 'new-folder' ||
    modalMode.value === 'rename' ||
    modalMode.value === 'read-image'
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

function openReadImageModal() {
  modalMode.value = 'read-image'
  modalTitle.value = 'Read image from CF media'
  modalMessage.value = 'Enter a name for the new image file (without extension)'
  modalInput.value = ''
  modalVisible.value = true
}

/**
 * Write confirmation modal:
 * - message-only (no input)
 * - Enter = confirm, Escape = cancel
 */
function openWriteConfirmModal(cwd: string, fileName: string) {
  pendingWriteCwd.value = cwd
  pendingWriteFileName.value = fileName
  modalMode.value = 'write-confirm'
  modalTitle.value = 'Write image to CF media'

  const devicePath = view.value.device?.path ?? 'the attached CF reader'
  modalMessage.value =
    `Write “${fileName}” to the CF card at ${devicePath}? ` +
    'This will permanently overwrite all data on the card.'

  modalInput.value = ''
  modalVisible.value = true
}

function closeModal() {
  modalVisible.value = false
  // If user cancels, ensure we don't leave a sticky overlay around
  stickyOverlay.value = false
  // Clear any pending write state on close
  pendingWriteCwd.value = null
  pendingWriteFileName.value = null
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
  if (modalMode.value === 'new-folder') {
    const raw = modalInput.value
    const trimmed = raw.trim()

    if (!trimmed) {
      return
    }

    sendCfImagerCommand('createFolder', { name: trimmed })
    closeModal()
    return
  }

  if (modalMode.value === 'rename') {
    const originalName = selectedNames.value[0] ?? ''
    const raw = modalInput.value
    const trimmed = raw.trim()

    if (!originalName || !trimmed) {
      return
    }

    if (trimmed === originalName) {
      closeModal()
      return
    }

    sendCfImagerCommand('rename', {
      oldName: originalName,
      newName: trimmed
    })
    closeModal()
    return
  }

  if (modalMode.value === 'write-confirm') {
    const cwd = pendingWriteCwd.value
    const fileName = pendingWriteFileName.value

    if (!cwd || !fileName) {
      // Defensive: nothing to act on, just close.
      closeModal()
      return
    }

    // Immediately block the UI while we wait for backend to flip to busy/currentOp
    stickyOverlay.value = true

    sendCfImagerCommand('writeImage', {
      cwd,
      fileName
    })

    // Clear pending state; keep backdrop via stickyOverlay
    pendingWriteCwd.value = null
    pendingWriteFileName.value = null
    modalVisible.value = false
    return
  }

  if (modalMode.value === 'delete') {
    const names = selectedNames.value.slice()
    if (names.length === 0) {
      closeModal()
      return
    }

    // Mark FS as busy while we wait for the backend to process delete
    fsBusy.value = true

    sendCfImagerCommand('delete', { names })
    closeModal()
    return
  }

  if (modalMode.value === 'read-image') {
    const raw = modalInput.value
    const trimmed = raw.trim()

    if (!trimmed) {
      return
    }

    const cwd = view.value.fs.cwd || '.'

    // Immediately block the UI while we wait for backend to flip to busy/currentOp
    stickyOverlay.value = true

    sendCfImagerCommand('readImage', {
      cwd,
      imageName: trimmed
    })

    // Hide the dialog but keep the backdrop (overlayActive thanks to stickyOverlay)
    modalVisible.value = false
    return
  }

  // Other modes (generic) – just close.
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

type CfImagerCommandKind =
  | 'changeDir'
  | 'changeDirUp'
  | 'createFolder'
  | 'rename'
  | 'delete'
  | 'readImage'
  | 'writeImage'
  | 'move'
  | 'search'

type CfImagerCommandPayload = Record<string, unknown>

function sendCfImagerCommand(kind: CfImagerCommandKind, payload?: CfImagerCommandPayload) {
  const ws = getRealtimeClient()
  if (!ws) return

  const body: any = {
    kind,
    ...(payload ?? {})
  }

  ws.send({ type: 'cf-imager.command', payload: body })
}

function onEntryDblClick(entry: CfImagerFsEntry) {
  if (entry.kind === 'dir') {
    fsBusy.value = true
    sendCfImagerCommand('changeDir', { name: entry.name })
  }
}

function onGoUpClick() {
  if (!canGoUp.value) return
  fsBusy.value = true
  sendCfImagerCommand('changeDirUp')
}

/* -------------------------------------------------------------------------- */
/*  Toolbar actions                                                            */
/* -------------------------------------------------------------------------- */

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
  if (!canReadImage.value) return
  openReadImageModal()
}

function onWriteImageClick() {
  if (!canWriteImage.value) return

  const cwd = view.value.fs.cwd || '.'

  const fileName =
    selectedNames.value.find(name =>
      sortedEntries.value.some(e => e.kind === 'file' && e.name === name)
    ) ?? null

  if (!fileName) {
    return
  }

  // Show confirmation modal instead of firing the command directly.
  openWriteConfirmModal(cwd, fileName)
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle: global key listener                                            */
/* -------------------------------------------------------------------------- */

onMounted(() => {
  window.addEventListener('keydown', handleModalKey)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleModalKey)

  // Clean up any pending search timeout
  if (searchTimeout !== null) {
    window.clearTimeout(searchTimeout)
    searchTimeout = null
  }
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

function formatGiB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const gib = bytes / (1024 * 1024 * 1024)
  return gib.toFixed(2)
}

function formatEta(totalSeconds: number): string {
  // Round to nearest second for display
  const secs = Math.round(totalSeconds)
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60

  const parts: string[] = []
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  // Always show seconds if we have no hours, or if seconds are non-zero
  if (s > 0 || parts.length === 0) {
    parts.push(`${s}s`)
  }

  return parts.join(' ')
}
</script>

<style scoped>
/* (styles unchanged – layout-tweaks and modal refinements applied) */

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

.cf-advanced-hotspot {
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
  flex: 1 1 0%;
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

/* Subtle pulse on the status dot while busy */
@keyframes cf-status-dot-pulse {
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

.status-badge .dot--pulse {
  animation: cf-status-dot-pulse 900ms ease-in-out infinite;
}

.status-badge[data-phase='disconnected'] {
  border-color: #4b5563;
  background: #020617;
}
.status-badge[data-phase='disconnected'] .dot {
  background: #6b7280;
}

.status-badge[data-phase='idle'][data-media='none'] {
  border-color: #38bdf8;
  background: #022c3a;
}
.status-badge[data-phase='idle'][data-media='none'] .dot {
  background: #38bdf8;
}

.status-badge[data-phase='idle'][data-media='unknown'] {
  border-color: #6366f1;
  background: #111827;
}
.status-badge[data-phase='idle'][data-media='unknown'] .dot {
  background: #6366f1;
}

.status-badge[data-phase='idle'][data-media='present'] {
  border-color: #22c55e;
  background: #022c22;
}
.status-badge[data-phase='idle'][data-media='present'] .dot {
  background: #22c55e;
}

.status-badge[data-phase='busy'] {
  border-color: #facc15;
  background: #3b2900;
}
.status-badge[data-phase='busy'] .dot {
  background: #facc15;
}

.status-badge[data-phase='error'] {
  border-color: #ef4444;
  background: #450a0a;
}
.status-badge[data-phase='error'] .dot {
  background: #ef4444;
}

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

.error-banner {
  margin-top: 2px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid #ef4444;
  background: #450a0a;
  font-size: 0.76rem;
}

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
  position: relative;
  flex: 1 1 0%;
  min-height: 0;
}

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

.fs-path {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.fs-path .label {
  opacity: 0.7;
}

/* Wrap for input + clear icon */
.fs-path-input-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.fs-path-input {
  --control-h: 28px;

  background: #020617;
  color: var(--panel-fg);
  border: 1px solid #374151;
  border-radius: 6px;
  padding: 0 20px 0 8px; /* extra right padding for clear button */
  min-width: 120px;
  font-size: 0.76rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
    'Courier New', monospace;
  height: var(--control-h);
  line-height: var(--control-h);
}

/* Tiny "×" clear control inside the input */
.fs-path-clear {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  border-radius: 999px;
  border: none;
  padding: 0;
  background: transparent;
  color: #9ca3af;
  cursor: pointer;
  font-size: 0.75rem;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.fs-path-clear:hover {
  background: rgba(148, 163, 184, 0.18);
  color: #e5e7eb;
}

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

.fs-empty {
  opacity: 0.7;
  text-align: center;
  padding: 10px 4px;
}

.fs-list {
  overflow-y: auto;
  border-radius: 4px;
  border: 1px solid #111827;
  background: #020617;
  -webkit-user-select: none;
  user-select: none;
  flex: 1 1 0%;
  min-height: 0;
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

.fs-row[data-selected='true'] {
  background: #0b1120;
  border-bottom-color: #1f2937;
}
.fs-row[data-selected='true'] .name {
  color: #e5e7eb;
}

/* Highlight folder when it's the current drop target */
.fs-row[data-kind='dir'][data-drop-target='true'] {
  background: #052e16;
  border-bottom-color: #14532d;
}
.fs-row[data-kind='dir'][data-drop-target='true'] .name {
  color: #bbf7d0;
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

.fs-shim {
  position: absolute;
  inset: 6px 8px;
  border-radius: 4px;
  background: rgba(15, 23, 42, 0.7);
  backdrop-filter: blur(1px);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: all;
  z-index: 2;
}

.fs-shim-inner {
  display: inline-flex;
  alignments: center;
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
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px;
}

.fs-meta-path-label {
  opacity: 0.8;
  margin-right: 2px;
}

.fs-meta-sep {
  opacity: 0.65;
}

.fs-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

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
  margin: 0 20px 2px 0;
}

.cf-modal-body {
  margin-top: 2px;
}

.cf-modal-message {
  font-size: 0.8rem;
  line-height: 1.4;
  opacity: 0.95;
}

.cf-modal-message--finalizing {
  margin-top: 2px;
  font-size: 0.78rem;
  opacity: 0.9;
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

/* Progress modal extras */

.cf-modal-progress-block {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cf-modal-progress-bar {
  position: relative;
  width: 100%;
  height: 6px;
  border-radius: 999px;
  background: #020617;
  overflow: hidden;
  border: 1px solid #1f2937;
}

.cf-modal-progress-fill {
  position: absolute;
  inset: 0;
  width: 0%;
  background: linear-gradient(90deg, #22c55e, #a3e635);
  transition: width 120ms linear;
}

.cf-modal-progress-meta {
  display: flex;
  justify-content: space-between;
  font-size: 0.8rem;
  opacity: 0.9;
  margin-top: 2px;
}

.cf-modal-progress-meta .pct {
  font-variant-numeric: tabular-nums;
}

.cf-modal-progress-meta .rate {
  font-variant-numeric: tabular-nums;
}

.cf-modal-stats {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* inherit font-size from .cf-modal for consistent text size */
}

.cf-modal-stat-row {
  display: flex;
  justify-content: space-between;
  gap: 6px;
}
.cf-modal-stat-row .label {
  opacity: 0.8;
}
.cf-modal-stat-row .value {
  text-align: right;
}

.monospace {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
    'Courier New', monospace;
}

.fade-modal-enter-active,
.fade-modal-leave-active {
  transition: opacity 160ms ease;
}
.fade-modal-enter-from,
.fade-modal-leave-to {
  opacity: 0;
}

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

/* -------------------------------------------------------------------------- */
/*  Drag preview (multi-item ghost)                                           */
/* -------------------------------------------------------------------------- */

/* Note: currently unused – we rely on the browser's default drag ghost.
   Left in place in case we want to reintroduce a custom preview later. */
.fs-drag-preview {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 9999;
  pointer-events: none;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.96);
  border: 1px solid #4b5563;
  box-shadow:
    0 10px 30px rgba(0, 0, 0, 0.75),
    0 0 0 1px rgba(15, 23, 42, 0.9);
  color: #e5e7eb;
  font-size: 0.76rem;
}

.fs-drag-preview-header {
  font-weight: 600;
  margin-bottom: 4px;
}

.fs-drag-preview-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.fs-drag-preview-row {
  opacity: 0.9;
}

.fs-drag-preview-more {
  opacity: 0.7;
  font-style: italic;
}
</style>
