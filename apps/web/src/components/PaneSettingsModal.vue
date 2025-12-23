<template>
    <div v-show="isOpen" class="modal-backdrop" @click.self="$emit('close')">
        <div class="modal-card">
            <div class="modal-head">
                <h2>Pane settings</h2>
                <div class="row nowrap">
                    <button class="btn" @click="$emit('close')" aria-label="Close">✕</button>
                </div>
            </div>

            <div class="modal-scroll">
                <section class="section">
                    <h3>Session</h3>
                    <div class="row">
                        <WsStatusBadge />
                        <button
                            class="btn danger"
                            :disabled="!canEdit"
                            @click="$emit('clearLayout')"
                        >
                            Clear layout
                        </button>
                    </div>
                </section>

                <section class="section">
                    <h3>Layouts</h3>

                    <!-- Saved profiles + actions on the SAME line -->
                    <div class="row nowrap spaced" style="align-items: center">
                        <span class="label inline">Saved profiles</span>

                        <select
                            :value="selectedProfileId"
                            @change="
                                $emit(
                                    'update:selectedProfileId',
                                    ($event.target as HTMLSelectElement).value
                                )
                            "
                            class="select"
                            style="min-width: 18rem"
                        >
                            <option value="">— none loaded —</option>
                            <option v-if="layoutList.length === 0" disabled value="">
                                — none saved on server —
                            </option>
                            <option v-for="p in layoutList" :key="p.id" :value="p.id">
                                {{ p.name }} • {{ formatDate(p.updatedAt) }}
                            </option>
                        </select>

                        <button
                            class="btn"
                            :disabled="!selectedProfileId"
                            @click="$emit('loadProfile', selectedProfileId)"
                        >
                            Load
                        </button>
                        <button
                            class="btn"
                            :disabled="!selectedProfileId || !canEdit"
                            @click="$emit('overwriteSelected')"
                            title="Update the selected profile on server to match the current layout"
                        >
                            Overwrite
                        </button>

                        <!-- Export BEFORE Delete -->
                        <button
                            class="btn"
                            :disabled="!selectedProfileId"
                            @click="exportSelectedProfile"
                            title="Download the selected profile JSON"
                        >
                            Export
                        </button>
                        <button
                            class="btn danger"
                            :disabled="!selectedProfileId || !canEdit"
                            @click="$emit('deleteSelected')"
                        >
                            Delete
                        </button>
                    </div>

                    <div class="row nowrap save-line spaced">
                        <span class="label inline">Save current as…</span>
                        <input
                            class="input wide"
                            type="text"
                            v-model="newProfileNameLocal"
                            placeholder="e.g., 2×2 logs + stats"
                            :disabled="!canEdit"
                        />
                        <button
                            class="btn primary"
                            :disabled="!canEdit"
                            @click="$emit('saveCurrentAs', newProfileNameLocal)"
                        >
                            Save
                        </button>

                        <span class="sep" aria-hidden="true">|</span>

                        <!-- Import profile JSON (file picker + POST) -->
                        <input
                            ref="importFile"
                            type="file"
                            accept="application/json"
                            style="display: none"
                            @change="onPickImport"
                        />
                        <button
                            class="btn"
                            title="Import a profile JSON and save to server"
                            @click="triggerImport"
                        >
                            Import JSON
                        </button>
                    </div>

                    <p class="hint tight">
                        Profiles are saved on the server and available to any client.
                    </p>
                    <p class="hint" v-if="importHint">
                        {{ importHint }}
                    </p>
                </section>

                <!-- SPLIT SECTION: one input, two actions -->
                <section class="section">
                    <h3>Split</h3>
                    <div class="row inputs wrap" style="gap: 0.5rem">
                        <label class="row" style="gap: 0.35rem; align-items: center">
                            <span class="label">Number of panes</span>
                            <input
                                v-model="working.splitCount"
                                type="number"
                                min="2"
                                class="input sm"
                                :disabled="!canEdit"
                                placeholder="2"
                            />
                        </label>

                        <button class="btn" :disabled="!canEdit" @click="emitSplitRow">
                            Split into Columns (side-by-side)
                        </button>
                        <button class="btn" :disabled="!canEdit" @click="emitSplitCol">
                            Split into Rows (stacked)
                        </button>
                    </div>

                    <p class="hint">
                        Use a single count (minimum <strong>2</strong>) and choose whether to split
                        this pane into <strong>columns</strong> (side-by-side) or
                        <strong>rows</strong> (stacked). The first child keeps the current pane’s
                        component; additional panes start empty.
                    </p>
                </section>

                <section class="section">
                    <h3>Constraints (size)</h3>
                    <div class="row inputs wrap" style="gap: 0.5rem">
                        <label class="row" style="gap: 0.35rem; align-items: center">
                            <span class="label">Width</span>
                            <input
                                v-model="working.widthValue"
                                type="number"
                                min="0"
                                :max="working.widthUnit === 'pct' ? 100 : undefined"
                                :placeholder="
                                    working.widthUnit === 'pct'
                                        ? 'auto (unset) or 0–100'
                                        : 'auto (unset)'
                                "
                                class="input sm"
                                :disabled="
                                    !canEdit || working.lockWidthCross || working.mustBeFluidWidth
                                "
                                :title="
                                    working.lockWidthCross
                                        ? 'Width is inherited from container (rows split).'
                                        : working.mustBeFluidWidth
                                        ? 'At least one sibling must remain fluid (auto) on the width.'
                                        : ''
                                "
                            />
                            <select
                                v-model="working.widthUnit"
                                class="select"
                                :disabled="
                                    !canEdit || working.lockWidthCross || working.mustBeFluidWidth
                                "
                            >
                                <option value="px">px</option>
                                <option value="pct">%</option>
                            </select>
                        </label>

                        <label class="row" style="gap: 0.35rem; align-items: center">
                            <span class="label">Height</span>
                            <input
                                v-model="working.heightValue"
                                type="number"
                                min="0"
                                :max="working.heightUnit === 'pct' ? 100 : undefined"
                                :placeholder="
                                    working.heightUnit === 'pct'
                                        ? 'auto (unset) or 0–100'
                                        : 'auto (unset)'
                                "
                                class="input sm"
                                :disabled="
                                    !canEdit || working.lockHeightCross || working.mustBeFluidHeight
                                "
                                :title="
                                    working.lockHeightCross
                                        ? 'Height is inherited from container (columns split).'
                                        : working.mustBeFluidHeight
                                        ? 'At least one sibling must remain fluid (auto) on the height.'
                                        : ''
                                "
                            />
                            <select
                                v-model="working.heightUnit"
                                class="select"
                                :disabled="
                                    !canEdit || working.lockHeightCross || working.mustBeFluidHeight
                                "
                            >
                                <option value="px">px</option>
                                <option value="pct">%</option>
                            </select>
                        </label>
                    </div>

                    <p class="hint">
                        Leave inputs blank for <strong>auto</strong> sizing. Use % to size relative
                        to the split container’s axis (e.g., 30% width within a columns split or 40%
                        height within a rows split).
                    </p>

                    <p class="hint">
                        <span v-if="working.lockHeightCross"
                            >You’re inside a <strong>columns</strong> split — height is inherited
                            from the container.</span
                        >
                        <span v-else-if="working.lockWidthCross"
                            >You’re inside a <strong>rows</strong> split — width is inherited from
                            the container.</span
                        >
                        <span v-if="working.mustBeFluidWidth || working.mustBeFluidHeight">
                            &nbsp;At least one sibling must remain <strong>auto</strong> on the
                            split’s main axis.
                        </span>
                    </p>
                </section>

                <section class="section">
                    <h3>Padding (px)</h3>
                    <div class="row inputs wrap">
                        <label
                            >Top
                            <input
                                v-model="working.mTop"
                                type="number"
                                min="0"
                                class="input sm"
                                :disabled="!canEdit"
                        /></label>
                        <label
                            >Right
                            <input
                                v-model="working.mRight"
                                type="number"
                                min="0"
                                class="input sm"
                                :disabled="!canEdit"
                        /></label>
                        <label
                            >Bottom
                            <input
                                v-model="working.mBottom"
                                type="number"
                                min="0"
                                class="input sm"
                                :disabled="!canEdit"
                        /></label>
                        <label
                            >Left
                            <input
                                v-model="working.mLeft"
                                type="number"
                                min="0"
                                class="input sm"
                                :disabled="!canEdit"
                        /></label>
                    </div>
                    <p class="hint">
                        Pane padding (inside spacing). Defaults to <em>1px</em> on all sides.
                    </p>
                </section>

                <section v-if="working.hasContainer" class="section">
                    <h3>This split (container)</h3>
                    <div class="row inputs">
                        <label
                            >Width
                            <input
                                v-model="working.containerWidthPx"
                                type="number"
                                min="0"
                                placeholder="auto"
                                class="input sm"
                                :disabled="!canEdit"
                        /></label>
                        <label
                            >Height
                            <input
                                v-model="working.containerHeightPx"
                                type="number"
                                min="0"
                                placeholder="auto"
                                class="input sm"
                                :disabled="!canEdit"
                        /></label>
                    </div>
                    <p class="hint">
                        Adjust the split container’s size (e.g., change overall
                        <em>800×600</em> after splitting). Children inherit the container along the
                        split’s cross-axis.
                    </p>
                </section>

                <section class="section">
                    <h3>Appearance</h3>
                    <div class="row">
                        <label class="row" style="gap: 0.35rem">
                            <input
                                type="checkbox"
                                v-model="working.bgEnabled"
                                :disabled="!canEdit"
                            />
                            Use custom pane background
                        </label>
                        <input
                            type="color"
                            class="color"
                            :value="working.bgHex"
                            @input="working.bgHex = ($event.target as HTMLInputElement).value"
                            :disabled="!canEdit || !working.bgEnabled"
                            aria-label="Pane background color"
                        />
                        <button class="btn" :disabled="!canEdit" @click="working.bgEnabled = false">
                            Clear color
                        </button>
                    </div>
                </section>

                <section class="section">
                    <h3>Component</h3>
                    <select v-model="working.componentKey" class="select" :disabled="!canEdit">
                        <option v-for="opt in paneOptions" :key="opt.id" :value="opt.id">
                            {{ opt.label }}
                        </option>
                    </select>
                </section>
            </div>

            <div class="modal-foot">
                <div class="row">
                    <button class="btn primary" :disabled="!canEdit" @click="emitApply">
                        Apply
                    </button>
                    <button class="btn" @click="$emit('close')">Cancel</button>
                </div>
                <div class="row">
                    <button
                        v-if="targetId && targetId !== (rootId || '')"
                        class="btn danger"
                        title="Remove this pane"
                        :disabled="!canEdit"
                        @click="$emit('deletePane')"
                    >
                        Delete Pane
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import WsStatusBadge from '@/components/WsStatusBadge.vue'
import { reactive, watch, ref } from 'vue'

type PaneOption = { id: string; label: string }
type Profile = { id: string; name: string; createdAt: string; updatedAt: string }

// Modal model, including splitCount
type ModalModel = {
    componentKey: string
    // unified inputs for width/height with unit
    widthValue: string | number
    widthUnit: 'px' | 'pct'
    heightValue: string | number
    heightUnit: 'px' | 'pct'
    // split count (single input)
    splitCount: string | number
    // existing fields
    bgEnabled: boolean
    bgHex: string
    mTop: string | number
    mRight: string | number
    mBottom: string | number
    mLeft: string | number
    lockWidthCross: boolean
    lockHeightCross: boolean
    mustBeFluidWidth: boolean
    mustBeFluidHeight: boolean
    hasContainer: boolean
    containerWidthPx: string | number
    containerHeightPx: string | number
}

const props = defineProps<{
    isOpen: boolean
    canEdit: boolean
    targetId: string | null
    rootId: string
    paneOptions: PaneOption[]
    layoutList: Profile[]
    selectedProfileId: string
    initialModel: ModalModel
}>()

const emit = defineEmits<{
    (e: 'close'): void
    (e: 'clearLayout'): void
    (e: 'splitRow', count: string | number): void
    (e: 'splitCol', count: string | number): void
    (e: 'deletePane'): void
    (e: 'apply', model: ModalModel): void
    (e: 'loadProfile', id: string): void
    (e: 'overwriteSelected'): void
    (e: 'deleteSelected'): void
    (e: 'saveCurrentAs', name: string): void
    (e: 'update:selectedProfileId', id: string): void
    (e: 'refreshLayouts'): void
}>()

// Local form state (copied from parent initialModel whenever modal opens or model changes)
const working = reactive<ModalModel>({ ...(props.initialModel as any) })

watch(
    () => [props.isOpen, props.initialModel],
    () => {
        Object.assign(working, props.initialModel)
    },
    { deep: false }
)

// "Save current as…" input
const newProfileNameLocal = ref('')

// --- Import/Export helpers ---
const importFile = ref<HTMLInputElement | null>(null)
const importHint = ref('')

function emitApply() {
    emit('apply', { ...(working as any) })
}

// Emit split signals with the current splitCount
function emitSplitRow() {
    emit('splitRow', working.splitCount)
}
function emitSplitCol() {
    emit('splitCol', working.splitCount)
}

// tiny util for date formatting
function formatDate(iso?: unknown): string {
    if (typeof iso !== 'string' || !iso) return ''
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? String(iso ?? '') : d.toLocaleString()
}

// Download a blob with a filename
function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
}

// Extract filename from Content-Disposition
function filenameFromDisposition(dispo?: string | null, fallback = 'layout.json'): string {
    if (!dispo) return fallback
    const m = /filename\*?=(?:UTF-8''|")?([^\";]+)/i.exec(dispo)
    if (m && m[1]) {
        try {
            return decodeURIComponent(m[1].replace(/["']/g, ''))
        } catch {
            return m[1].replace(/["']/g, '')
        }
    }
    return fallback
}

// Export selected profile via server
async function exportSelectedProfile() {
    const id = props.selectedProfileId
    if (!id) return
    try {
        const res = await fetch(`/api/layouts/${id}/export`, { method: 'GET' })
        if (!res.ok) throw new Error(await res.text())
        const dispo = res.headers.get('content-disposition')
        const fname = filenameFromDisposition(dispo, `layout-${id}.json`)
        const blob = await res.blob()
        downloadBlob(blob, fname)
        importHint.value = ''
    } catch (err: any) {
        console.error('Export failed:', err)
        importHint.value = 'Export failed — check server logs.'
    }
}

// Open file picker
function triggerImport() {
    importFile.value?.click()
}

function isObject(x: any): x is Record<string, any> {
    return x !== null && typeof x === 'object' && !Array.isArray(x)
}
function looksLikeLayoutRoot(x: any): boolean {
    if (!isObject(x)) return false
    // minimal heuristic: layout nodes have kind leaf/split
    if (typeof x.kind === 'string' && (x.kind === 'leaf' || x.kind === 'split')) return true
    // tolerate older exports that might just be the root node shape
    if ('children' in x || 'component' in x) return true
    return false
}
function looksLikeProfile(x: any): boolean {
    return (
        isObject(x) &&
        typeof x.id === 'string' &&
        typeof x.name === 'string' &&
        typeof x.createdAt === 'string' &&
        typeof x.updatedAt === 'string' &&
        isObject(x.layout)
    )
}
function looksLikeStoreShape(x: any): boolean {
    return isObject(x) && isObject(x.items)
}

// Normalize possible import payloads into something the server import endpoint accepts,
// WITHOUT stripping extra fields (e.g. logsUiPrefs).
function normalizeImportPayloadAny(raw: any, fileName?: string): any {
    const now = new Date().toISOString()
    const baseName =
        (typeof raw?.name === 'string' && raw.name.trim()) ||
        (fileName ? fileName.replace(/\.[^/.]+$/, '') : '') ||
        `Imported ${now}`

    // If user imported a full store export ({ items, defaultId? }), pass through unchanged.
    if (looksLikeStoreShape(raw)) return raw

    // If user imported a full profile export ({ id, name, createdAt, updatedAt, layout, logsUiPrefs? }), pass through unchanged.
    if (looksLikeProfile(raw)) return raw

    // If user imported a profile-like wrapper ({ name?, layout, logsUiPrefs? }), pass through unchanged.
    if (isObject(raw) && isObject(raw.layout)) return raw

    // If user imported a bare layout root node, wrap it.
    if (looksLikeLayoutRoot(raw)) return { name: baseName, layout: raw }

    throw new Error('Invalid JSON: unsupported payload shape')
}

// Handle file selection → POST /api/layouts/import
async function onPickImport(ev: Event) {
    const input = ev.target as HTMLInputElement
    const file = input.files?.[0]
    // reset for next selection
    if (input) input.value = ''
    if (!file) return

    try {
        const text = await file.text()
        const json = JSON.parse(text)
        const payload = normalizeImportPayloadAny(json, file.name)

        const res = await fetch('/api/layouts/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
        })
        if (!res.ok) throw new Error(await res.text())
        const data: any = await res.json()
        if (!data?.ok) throw new Error('Import endpoint returned ok: false')

        // Handle server’s actual response shape: { ok, mode, created: string[], defaultId }
        if (Array.isArray(data.created) && data.created.length > 0) {
            const createdIds: string[] = data.created
            const preferred =
                data.defaultId && createdIds.includes(data.defaultId)
                    ? data.defaultId
                    : createdIds[createdIds.length - 1]

            // Refresh so dropdown contains the new entry, then select + load it
            emit('refreshLayouts')
            emit('update:selectedProfileId', preferred)
            emit('loadProfile', preferred)

            importHint.value =
                createdIds.length > 1
                    ? `Import completed — ${createdIds.length} profiles added.`
                    : 'Import completed.'
        } else if (data?.profile?.id) {
            // Back-compat: if server ever returns { profile }
            const id = data.profile.id as string
            emit('refreshLayouts')
            emit('update:selectedProfileId', id)
            emit('loadProfile', id)
            importHint.value = 'Import completed.'
        } else {
            emit('refreshLayouts')
            importHint.value =
                'Import completed — no created ids were returned. Check server logs if unexpected.'
        }
    } catch (err: any) {
        console.error('Import failed:', err)
        importHint.value =
            'Import failed — JSON must be: a profile export, a full store export, a {name, layout} wrapper (optionally with logsUiPrefs), or a bare layout root.'
    }
}
</script>

<style scoped>
.modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: grid;
    place-items: center;
    z-index: 50;
}
.modal-card {
    background: #0f1115;
    color: #e5e7eb;
    width: min(760px, 94vw);
    max-height: 86vh;
    border-radius: 0.6rem;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
    border: 1px solid #2a2f35;
    display: grid;
    grid-template-rows: auto 1fr auto;
}
.modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.85rem 1rem;
    border-bottom: 1px solid #2a2f35;
    position: sticky;
    top: 0;
    background: #0f1115;
    z-index: 1;
}
.modal-head h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
}
.modal-scroll {
    padding: 1rem;
    overflow: auto;
    max-height: 70vh;
}
.modal-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-top: 1px solid #2a2f35;
    position: sticky;
    bottom: 0;
    background: #0f1115;
    z-index: 1;
}
.section {
    border: 1px solid #2a2f35;
    border-radius: 0.45rem;
    padding: 0.8rem;
    background: #0b0d12;
    margin-bottom: 0.9rem;
}
.section h3 {
    margin: 0 0 0.55rem;
    font-size: 0.95rem;
    font-weight: 600;
}
.label {
    opacity: 0.9;
    font-size: 0.85rem;
}
.label.inline {
    min-width: max-content;
}
.hint {
    opacity: 0.75;
    font-size: 0.8rem;
    margin: 0.5rem 0 0;
}
.hint.tight {
    margin-top: 0.35rem;
}
.row {
    display: flex;
    gap: 0.7rem;
    align-items: center;
    flex-wrap: wrap;
}
.row.nowrap {
    flex-wrap: nowrap;
}
.row.spaced {
    margin-top: 0.25rem;
}
.inputs .input.sm {
    width: 4.5rem;
}
.input.wide {
    width: 14rem;
}
.input,
.select,
.btn,
.color {
    height: 2.1rem;
    padding: 0 0.6rem;
    border: 1px solid #2a2f35;
    border-radius: 0.4rem;
    background: #0b0d12;
    color: #e5e7eb;
    font-size: 0.9rem;
    cursor: pointer;
}
.input {
    cursor: text;
}
.color {
    width: 3rem;
    padding: 0;
}
.btn.primary {
    background: #1f2937;
    border-color: #374151;
}
.btn.danger {
    border-color: #ef4444;
    color: #ef4444;
}
.sep {
    opacity: 0.5;
    user-select: none;
}
</style>
