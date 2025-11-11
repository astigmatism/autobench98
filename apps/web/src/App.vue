<!-- apps/web/src/App.vue -->
<script setup lang="ts">
import { onMounted, ref, reactive, computed, watch } from 'vue'
import { startRealtime } from './bootstrap'
import LogsPane from './components/LogsPane.vue'
import WsStatusBadge from './components/WsStatusBadge.vue'

/** ─────────────────────────────────────────────────────────────────────────
 * Types
 * ─────────────────────────────────────────────────────────────────────────*/
type Direction = 'row' | 'col'

type Constraints = {
    widthPx?: number | null
    heightPx?: number | null
}

type Appearance = {
    bg?: string | null
    // NOTE: legacy field names retained; now applied as *padding*
    mTop?: number | null
    mRight?: number | null
    mBottom?: number | null
    mLeft?: number | null
}

type LeafNode = {
    id: string
    kind: 'leaf'
    component?: string | null
    props?: Record<string, unknown>
    constraints?: Constraints
    appearance?: Appearance
}

type SplitNode = {
    id: string
    kind: 'split'
    direction: Direction
    children: LayoutNode[]
    sizes?: number[]
    constraints?: Constraints
}

type LayoutNode = LeafNode | SplitNode

type Profile = {
    id: string
    name: string
    createdAt: string
    updatedAt: string
    layout: LayoutNode
}

/** ─────────────────────────────────────────────────────────────────────────
 * Utils
 * ─────────────────────────────────────────────────────────────────────────*/
const uid = () => Math.random().toString(36).slice(2, 10)
const deepClone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const parseQuery = () => new URLSearchParams(window.location.search)

function formatDate(iso?: unknown): string {
    if (typeof iso !== 'string' || !iso) return ''
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? String(iso ?? '') : d.toLocaleString()
}

// Base64URL helpers (UTF-8 safe)
function toBase64Url(input: string): string {
    const b64 = btoa(input)
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromBase64Url(b64url: string): string {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : ''
    return atob(b64 + pad)
}
function encodeLayout(obj: unknown): string {
    const json = JSON.stringify(obj)
    const utf8 = encodeURIComponent(json).replace(/%([0-9A-F]{2})/g, (_, m) =>
        String.fromCharCode(parseInt(m, 16))
    )
    return toBase64Url(utf8)
}
function decodeLayout(s: string): unknown | null {
    try {
        const raw = fromBase64Url(s)
        const json = decodeURIComponent(
            Array.prototype.map
                .call(raw, (c: string) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
                .join('')
        )
        return JSON.parse(json)
    } catch {
        return null
    }
}

const OWNER_KEY_LS = 'ab98:studio:ownerKey'
const LAYOUT_LS = 'ab98:studio:layout'
const PROFILES_LS = 'ab98:studio:profiles'

function ensureOwnerKey(): string {
    const existing = localStorage.getItem(OWNER_KEY_LS)
    if (existing) return existing
    const key = crypto.randomUUID?.() ?? `k_${uid()}`
    localStorage.setItem(OWNER_KEY_LS, key)
    return key
}

/** ─────────────────────────────────────────────────────────────────────────
 * Component registry
 * ─────────────────────────────────────────────────────────────────────────*/
const panes = { LogsPane } as const
type PaneKey = keyof typeof panes

/** ─────────────────────────────────────────────────────────────────────────
 * Layout state
 * ─────────────────────────────────────────────────────────────────────────*/
function makeSinglePane(): LeafNode {
    return {
        id: uid(),
        kind: 'leaf',
        component: null,
        props: {},
        constraints: { widthPx: null, heightPx: null },
        // Default 1px padding on all sides (legacy field names)
        appearance: { bg: null, mTop: 1, mRight: 1, mBottom: 1, mLeft: 1 }
    }
}
const root = reactive<LayoutNode>(makeSinglePane())
const rootId = computed<string>(() => (root as any)?.id ?? '')

/** ─────────────────────────────────────────────────────────────────────────
 * Profiles (local library)
 * ─────────────────────────────────────────────────────────────────────────*/
function loadProfiles(): Record<string, Profile> {
    try {
        const raw = localStorage.getItem(PROFILES_LS)
        if (!raw) return {}
        const obj = JSON.parse(raw)
        return obj && typeof obj === 'object' ? obj : {}
    } catch {
        return {}
    }
}
function saveProfiles(profiles: Record<string, Profile>) {
    localStorage.setItem(PROFILES_LS, JSON.stringify(profiles))
}
const nowIso = () => new Date().toISOString()

function addProfile(name: string, layout: LayoutNode): Profile {
    const profiles = loadProfiles()
    const id = uid()
    const p: Profile = {
        id,
        name,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        layout: deepClone(layout)
    }
    profiles[id] = p
    saveProfiles(profiles)
    return p
}
function updateProfile(id: string, layout: LayoutNode) {
    const profiles = loadProfiles()
    const p = profiles[id]
    if (!p) return
    p.layout = deepClone(layout)
    p.updatedAt = nowIso()
    saveProfiles(profiles)
}
function deleteProfile(id: string) {
    const profiles = loadProfiles()
    if (profiles[id]) {
        delete profiles[id]
        saveProfiles(profiles)
    }
}

/** ─────────────────────────────────────────────────────────────────────────
 * Modal state
 * ─────────────────────────────────────────────────────────────────────────*/
const isModalOpen = ref(false)
const modalTargetId = ref<string | null>(null)
const modalWorking = reactive({
    componentKey: 'none' as 'none' | PaneKey,
    widthPx: '' as string | number,
    heightPx: '' as string | number,
    bgEnabled: false,
    bgHex: '#ffffff',

    // padding (legacy names)
    mTop: '1' as string | number,
    mRight: '1' as string | number,
    mBottom: '1' as string | number,
    mLeft: '1' as string | number,

    // locks
    lockWidthCross: false,
    lockHeightCross: false,
    mustBeFluidWidth: false,
    mustBeFluidHeight: false,

    // container (split) constraints
    hasContainer: false,
    containerWidthPx: '' as string | number,
    containerHeightPx: '' as string | number,

    // profiles
    selectedProfileId: '' as string,
    newProfileName: '' as string
})

const profilesList = ref<Profile[]>([])
const profileOptions = computed(() =>
    profilesList.value.map((p) => ({ id: p.id, label: `${p.name} • ${formatDate(p.updatedAt)}` }))
)

/** ─────────────────────────────────────────────────────────────────────────
 * Persistence boot + edit rights
 * ─────────────────────────────────────────────────────────────────────────*/
const ownerKey = ensureOwnerKey()
const urlParams = parseQuery()
const editKeyFromUrl = urlParams.get('edit')
const canEdit = computed<boolean>(() => !!editKeyFromUrl && editKeyFromUrl === ownerKey)

// hydrate from LS if present
const ls = localStorage.getItem(LAYOUT_LS)
if (ls) {
    try {
        const parsed = JSON.parse(ls)
        if (parsed && typeof parsed === 'object') Object.assign(root as any, parsed)
    } catch {}
}

// hydrate from ?layout= and auto-save profile
const layoutParam = urlParams.get('layout')
if (layoutParam) {
    const decoded = decodeLayout(layoutParam)
    if (decoded && typeof decoded === 'object') {
        try {
            const loaded = decoded as LayoutNode
            if (loaded && 'kind' in loaded && 'id' in loaded) {
                Object.keys(root as any).forEach((k) => delete (root as any)[k])
                Object.assign(root as any, deepClone(loaded))
                const stamp = new Date()
                    .toLocaleString(undefined, {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit'
                    })
                    .replace(',', '')
                addProfile(`Imported ${stamp}`, root)
            }
        } catch {}
    }
}

// persist layout
watch(
    () => root,
    () => localStorage.setItem(LAYOUT_LS, JSON.stringify(root)),
    { deep: true }
)

/** ─────────────────────────────────────────────────────────────────────────
 * Share links
 * ─────────────────────────────────────────────────────────────────────────*/
const shareUrl = computed(() => {
    const params = new URLSearchParams()
    params.set('layout', encodeLayout(root))
    if (canEdit.value) params.set('edit', ownerKey)
    return `${location.origin}${location.pathname}?${params.toString()}`
})
function copyShareUrl() {
    navigator.clipboard.writeText(shareUrl.value).catch(() => {})
}
function copyShareUrlForProfile(id: string) {
    if (!id) return
    const p = loadProfiles()[id]
    if (!p) return
    const params = new URLSearchParams()
    params.set('layout', encodeLayout(p.layout))
    if (canEdit.value) params.set('edit', ownerKey)
    navigator.clipboard
        .writeText(`${location.origin}${location.pathname}?${params.toString()}`)
        .catch(() => {})
}

/** Clear to single empty pane */
function clearLayout() {
    if (!canEdit.value) return
    const fresh = makeSinglePane()
    Object.keys(root as any).forEach((k) => delete (root as any)[k])
    Object.assign(root as any, fresh)
}

/** ─────────────────────────────────────────────────────────────────────────
 * Tree helpers
 * ─────────────────────────────────────────────────────────────────────────*/
function findNodeAndParent(
    targetId: string,
    node: LayoutNode,
    parent: SplitNode | null = null
): { node: LayoutNode; parent: SplitNode | null } | null {
    if (node.id === targetId) return { node, parent }
    if (node.kind === 'split' && Array.isArray(node.children)) {
        for (const child of node.children) {
            const found = findNodeAndParent(targetId, child, node)
            if (found) return found
        }
    }
    return null
}
function getParentSplit(leafId: string): SplitNode | null {
    const fp = findNodeAndParent(leafId, root, null)
    return fp ? fp.parent ?? null : null
}

/** ─────────────────────────────────────────────────────────────────────────
 * Split / Delete
 * ─────────────────────────────────────────────────────────────────────────*/
function splitLeaf(targetId: string, direction: Direction) {
    if (!canEdit.value) return
    const found = findNodeAndParent(targetId, root, null)
    if (!found) return
    const { node, parent } = found
    if (node.kind !== 'leaf') return

    const movedConstraints: Constraints = deepClone(
        node.constraints ?? { widthPx: null, heightPx: null }
    )

    const a: LeafNode = {
        id: uid(),
        kind: 'leaf',
        component: node.component ?? null,
        props: deepClone(node.props ?? {}),
        constraints: { widthPx: null, heightPx: null },
        appearance: deepClone(
            (node as LeafNode).appearance ?? { bg: null, mTop: 1, mRight: 1, mBottom: 1, mLeft: 1 }
        )
    }
    const b: LeafNode = makeSinglePane()
    b.constraints = { widthPx: null, heightPx: null }

    const replacement: SplitNode = {
        id: uid(),
        kind: 'split',
        direction,
        children: [a, b],
        sizes: [50, 50],
        constraints: movedConstraints
    }

    if (!parent) {
        Object.keys(root as any).forEach((k) => delete (root as any)[k])
        Object.assign(root as any, replacement)
    } else if (Array.isArray(parent.children)) {
        const idx = parent.children.findIndex((c) => c.id === node.id)
        if (idx >= 0) parent.children.splice(idx, 1, replacement)
    }
}

function deleteLeaf(targetId: string) {
    if (!canEdit.value) return
    if (root.id === targetId) {
        if ((root as any).kind === 'leaf') {
            ;(root as LeafNode).component = null
            ;(root as LeafNode).props = {}
            ;(root as LeafNode).constraints = { widthPx: null, heightPx: null }
            ;(root as LeafNode).appearance = { bg: null, mTop: 1, mRight: 1, mBottom: 1, mLeft: 1 }
        }
        return
    }
    const found = findNodeAndParent(targetId, root, null)
    if (!found) return
    const { node, parent } = found
    if (!parent || !Array.isArray(parent.children)) return
    const idx = parent.children.findIndex((c) => c.id === node.id)
    if (idx === -1) return

    parent.children.splice(idx, 1)
    if (parent.children.length === 1) {
        const survivor = parent.children[0] as LayoutNode
        const parentConstraints = deepClone(parent.constraints ?? undefined)
        if (parentConstraints) {
            if ((survivor as any).kind === 'leaf') {
                ;(survivor as LeafNode).constraints = parentConstraints
            } else {
                ;(survivor as SplitNode).constraints = parentConstraints
            }
        }

        const gpEntry = findNodeAndParent(parent.id, root, null)
        const gp = gpEntry ? gpEntry.parent : null
        if (!gp) {
            Object.keys(root as any).forEach((k) => delete (root as any)[k])
            Object.assign(root as any, deepClone(survivor))
        } else if (Array.isArray(gp.children)) {
            const pidx = gp.children.findIndex((c) => c.id === parent.id)
            if (pidx >= 0) gp.children.splice(pidx, 1, survivor)
        }
    }
}

/** ─────────────────────────────────────────────────────────────────────────
 * Invariants — at least one fluid child on the main axis
 * ─────────────────────────────────────────────────────────────────────────*/
function computeMainAxisFluidRule(parent: SplitNode | null, currentId: string) {
    if (!parent) return { main: null as 'width' | 'height' | null, mustBeFluid: false }
    const isRow = parent.direction === 'row'
    const main: 'width' | 'height' = isRow ? 'width' : 'height'
    const kids = Array.isArray(parent.children) ? parent.children : []
    const others = kids.filter((c) => c.id !== currentId)
    const othersFixed = others.every((c) => {
        const cons: Constraints = (c as any).constraints ?? {}
        return (isRow ? cons.widthPx : cons.heightPx) != null
    })
    return { main, mustBeFluid: othersFixed }
}

function getAxisLocksForLeaf(leafId: string) {
    const parent = getParentSplit(leafId)
    if (!parent) {
        return {
            lockWidthCross: false,
            lockHeightCross: false,
            mustBeFluidWidth: false,
            mustBeFluidHeight: false
        }
    }
    const isRow = parent.direction === 'row'
    const crossWidthLock = !isRow
    const crossHeightLock = isRow
    const { main, mustBeFluid } = computeMainAxisFluidRule(parent, leafId)
    return {
        lockWidthCross: crossWidthLock,
        lockHeightCross: crossHeightLock,
        mustBeFluidWidth: main === 'width' ? mustBeFluid : false,
        mustBeFluidHeight: main === 'height' ? mustBeFluid : false
    }
}

/** ─────────────────────────────────────────────────────────────────────────
 * Modal apply / open
 * ─────────────────────────────────────────────────────────────────────────*/
function toIntOrNull(v: string | number): number | null {
    const s = String(v ?? '').trim()
    return s === '' ? null : Math.max(0, parseInt(s, 10) || 0)
}

function applyModalToLeaf() {
    if (!canEdit.value) return
    const id = modalTargetId.value
    if (!id) return
    const found = findNodeAndParent(id, root, null)
    if (!found) return
    const { node } = found
    if (node.kind !== 'leaf') return

    const locks = getAxisLocksForLeaf(node.id)
    const key = modalWorking.componentKey
    ;(node as LeafNode).component = key === 'none' ? null : key

    let widthPx = toIntOrNull(modalWorking.widthPx)
    let heightPx = toIntOrNull(modalWorking.heightPx)

    if (locks.lockWidthCross) widthPx = null
    if (locks.lockHeightCross) heightPx = null
    if (locks.mustBeFluidWidth) widthPx = null
    if (locks.mustBeFluidHeight) heightPx = null
    ;(node as LeafNode).constraints = { widthPx, heightPx }

    const useBg = !!modalWorking.bgEnabled
    const hex =
        typeof modalWorking.bgHex === 'string' && /^#[0-9a-fA-F]{6}$/.test(modalWorking.bgHex)
            ? modalWorking.bgHex
            : '#ffffff'

    // padding values (legacy keys)
    const pTop = toIntOrNull(modalWorking.mTop) ?? 0
    const pRight = toIntOrNull(modalWorking.mRight) ?? 0
    const pBottom = toIntOrNull(modalWorking.mBottom) ?? 0
    const pLeft = toIntOrNull(modalWorking.mLeft) ?? 0

    ;(node as LeafNode).appearance = {
        bg: useBg ? hex : null,
        mTop: pTop,
        mRight: pRight,
        mBottom: pBottom,
        mLeft: pLeft
    }

    if (modalWorking.hasContainer) {
        const parent = getParentSplit(node.id)
        if (parent) {
            const cWidthPx = toIntOrNull(modalWorking.containerWidthPx)
            const cHeightPx = toIntOrNull(modalWorking.containerHeightPx)
            parent.constraints = { widthPx: cWidthPx, heightPx: cHeightPx }
        }
    }

    closeModal()
}

function openModalForLeaf(leaf: LeafNode) {
    modalTargetId.value = leaf.id

    const currentKey: 'none' | PaneKey =
        leaf.component && (Object.keys(panes) as PaneKey[]).includes(leaf.component as PaneKey)
            ? (leaf.component as PaneKey)
            : 'none'
    modalWorking.componentKey = currentKey
    modalWorking.widthPx = leaf.constraints?.widthPx != null ? String(leaf.constraints.widthPx) : ''
    modalWorking.heightPx =
        leaf.constraints?.heightPx != null ? String(leaf.constraints.heightPx) : ''
    modalWorking.bgEnabled = !!leaf.appearance?.bg
    modalWorking.bgHex = leaf.appearance?.bg ?? '#ffffff'

    // padding fields
    modalWorking.mTop = String(leaf.appearance?.mTop ?? 1)
    modalWorking.mRight = String(leaf.appearance?.mRight ?? 1)
    modalWorking.mBottom = String(leaf.appearance?.mBottom ?? 1)
    modalWorking.mLeft = String(leaf.appearance?.mLeft ?? 1)

    const locks = getAxisLocksForLeaf(leaf.id)
    modalWorking.lockWidthCross = locks.lockWidthCross
    modalWorking.lockHeightCross = locks.lockHeightCross
    modalWorking.mustBeFluidWidth = locks.mustBeFluidWidth
    modalWorking.mustBeFluidHeight = locks.mustBeFluidHeight

    if (modalWorking.lockWidthCross || modalWorking.mustBeFluidWidth) modalWorking.widthPx = ''
    if (modalWorking.lockHeightCross || modalWorking.mustBeFluidHeight) modalWorking.heightPx = ''

    const parent = getParentSplit(leaf.id)
    if (parent) {
        modalWorking.hasContainer = true
        modalWorking.containerWidthPx =
            parent.constraints?.widthPx != null ? String(parent.constraints.widthPx) : ''
        modalWorking.containerHeightPx =
            parent.constraints?.heightPx != null ? String(parent.constraints.heightPx) : ''
    } else {
        modalWorking.hasContainer = false
        modalWorking.containerWidthPx = ''
        modalWorking.containerHeightPx = ''
    }

    // refresh profiles
    const profiles = loadProfiles()
    profilesList.value = Object.values(profiles).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt)
    )
    if (!modalWorking.selectedProfileId) {
        const first = profilesList.value[0]
        modalWorking.selectedProfileId = first ? first.id : ''
    }

    isModalOpen.value = true
}

function closeModal() {
    isModalOpen.value = false
    modalTargetId.value = null
}

// Convenience split/delete (guarded by canEdit via button disabled states too)
function splitRowFromModal() {
    const id = modalTargetId.value
    if (id) splitLeaf(id, 'row')
    closeModal()
}
function splitColFromModal() {
    const id = modalTargetId.value
    if (id) splitLeaf(id, 'col')
    closeModal()
}
function deleteFromModal() {
    const id = modalTargetId.value
    if (id) deleteLeaf(id)
    closeModal()
}

/** Layouts library actions */
function loadSelectedProfile() {
    const id = modalWorking.selectedProfileId
    if (!id) return
    const p = loadProfiles()[id]
    if (!p) return
    const loaded = p.layout
    Object.keys(root as any).forEach((k) => delete (root as any)[k])
    Object.assign(root as any, deepClone(loaded))
}
function saveAsNewProfile() {
    if (!canEdit.value) return
    const name = String(modalWorking.newProfileName || '').trim()
    const chosen = name || `Layout ${new Date().toLocaleString()}`
    const p = addProfile(chosen, root)
    modalWorking.newProfileName = ''
    const profiles = loadProfiles()
    profilesList.value = Object.values(profiles).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt)
    )
    modalWorking.selectedProfileId = p.id
}
function overwriteSelectedProfile() {
    if (!canEdit.value) return
    const id = modalWorking.selectedProfileId
    if (!id) return
    updateProfile(id, root)
    const profiles = loadProfiles()
    profilesList.value = Object.values(profiles).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt)
    )
}
function deleteSelectedProfile() {
    if (!canEdit.value) return
    const id = modalWorking.selectedProfileId
    if (!id) return
    deleteProfile(id)
    const profiles = loadProfiles()
    profilesList.value = Object.values(profiles).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt)
    )
    const first = profilesList.value[0]
    modalWorking.selectedProfileId = first ? first.id : ''
}

/** Realtime (status badge in modal) */
onMounted(() => {
    startRealtime('/ws')
})
</script>

<template>
    <div class="studio-root">
        <div class="tree-root">
            <RenderNode
                :node="root"
                :panes="panes"
                :is-root="true"
                :parent-dir="null"
                :can-edit="canEdit"
                @split="splitLeaf"
                @configure="openModalForLeaf"
                @delete="deleteLeaf"
            />
        </div>

        <!-- Fullscreen modal -->
        <div v-show="isModalOpen" class="modal-backdrop" @click.self="closeModal">
            <div class="modal-card">
                <!-- Sticky header -->
                <div class="modal-head">
                    <h2>Pane settings</h2>
                    <div class="row nowrap">
                        <span v-if="!canEdit" class="view-only">View-only</span>
                        <button class="btn" @click="closeModal" aria-label="Close">✕</button>
                    </div>
                </div>

                <!-- Scrollable middle only -->
                <div class="modal-scroll">
                    <section class="section">
                        <h3>Session</h3>
                        <div class="row">
                            <WsStatusBadge />
                            <button class="btn" @click="copyShareUrl">
                                Copy share link (current)
                            </button>
                            <button class="btn danger" :disabled="!canEdit" @click="clearLayout">
                                Clear layout
                            </button>
                        </div>
                    </section>

                    <section class="section">
                        <h3>Layouts</h3>

                        <div class="row nowrap spaced">
                            <span class="label inline">Saved profiles</span>
                            <select
                                v-model="modalWorking.selectedProfileId"
                                class="select"
                                style="min-width: 18rem"
                            >
                                <option v-if="profileOptions.length === 0" disabled value="">
                                    — none saved yet —
                                </option>
                                <option v-for="opt in profileOptions" :key="opt.id" :value="opt.id">
                                    {{ opt.label }}
                                </option>
                            </select>
                        </div>

                        <div class="row nowrap actions" style="gap: 0.5rem; margin-top: 0.35rem">
                            <button
                                class="btn"
                                :disabled="!modalWorking.selectedProfileId"
                                @click="loadSelectedProfile"
                            >
                                Load
                            </button>
                            <button
                                class="btn"
                                :disabled="!modalWorking.selectedProfileId || !canEdit"
                                @click="overwriteSelectedProfile"
                            >
                                Overwrite
                            </button>
                            <button
                                class="btn"
                                :disabled="!modalWorking.selectedProfileId"
                                @click="copyShareUrlForProfile(modalWorking.selectedProfileId)"
                            >
                                Copy link
                            </button>
                            <button
                                class="btn danger"
                                :disabled="!modalWorking.selectedProfileId || !canEdit"
                                @click="deleteSelectedProfile"
                            >
                                Delete
                            </button>
                        </div>

                        <div class="row nowrap save-line spaced">
                            <span class="label inline">Save current as…</span>
                            <input
                                class="input wide"
                                type="text"
                                v-model="modalWorking.newProfileName"
                                placeholder="e.g., 2×2 logs + stats"
                                :disabled="!canEdit"
                            />
                            <button
                                class="btn primary"
                                :disabled="!canEdit"
                                @click="saveAsNewProfile"
                            >
                                Save
                            </button>
                        </div>

                        <p class="hint tight">
                            Opening a shared link automatically saves a snapshot as an
                            <em>Imported …</em> profile here.
                        </p>
                    </section>

                    <section class="section">
                        <h3>Split</h3>
                        <div class="row">
                            <button class="btn" :disabled="!canEdit" @click="splitRowFromModal">
                                Split into Columns (side-by-side)
                            </button>
                            <button class="btn" :disabled="!canEdit" @click="splitColFromModal">
                                Split into Rows (stacked)
                            </button>
                        </div>
                    </section>

                    <section class="section">
                        <h3>Constraints (px)</h3>
                        <div class="row inputs">
                            <label
                                >Width
                                <input
                                    v-model="modalWorking.widthPx"
                                    type="number"
                                    min="0"
                                    placeholder="auto"
                                    class="input sm"
                                    :disabled="
                                        !canEdit ||
                                        modalWorking.lockWidthCross ||
                                        modalWorking.mustBeFluidWidth
                                    "
                                    :title="
                                        modalWorking.lockWidthCross
                                            ? 'Width is inherited from container (rows split).'
                                            : modalWorking.mustBeFluidWidth
                                            ? 'At least one sibling must remain fluid (auto) on the width.'
                                            : ''
                                    "
                                />
                            </label>
                            <label
                                >Height
                                <input
                                    v-model="modalWorking.heightPx"
                                    type="number"
                                    min="0"
                                    placeholder="auto"
                                    class="input sm"
                                    :disabled="
                                        !canEdit ||
                                        modalWorking.lockHeightCross ||
                                        modalWorking.mustBeFluidHeight
                                    "
                                    :title="
                                        modalWorking.lockHeightCross
                                            ? 'Height is inherited from container (columns split).'
                                            : modalWorking.mustBeFluidHeight
                                            ? 'At least one sibling must remain fluid (auto) on the height.'
                                            : ''
                                    "
                                />
                            </label>
                        </div>
                        <p class="hint">
                            <span v-if="modalWorking.lockHeightCross"
                                >You’re inside a <strong>columns</strong> split — height is
                                inherited from the container.</span
                            >
                            <span v-else-if="modalWorking.lockWidthCross"
                                >You’re inside a <strong>rows</strong> split — width is inherited
                                from the container.</span
                            >
                            <span
                                v-if="
                                    modalWorking.mustBeFluidWidth || modalWorking.mustBeFluidHeight
                                "
                            >
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
                                    v-model="modalWorking.mTop"
                                    type="number"
                                    min="0"
                                    class="input sm"
                                    :disabled="!canEdit"
                                />
                            </label>
                            <label
                                >Right
                                <input
                                    v-model="modalWorking.mRight"
                                    type="number"
                                    min="0"
                                    class="input sm"
                                    :disabled="!canEdit"
                                />
                            </label>
                            <label
                                >Bottom
                                <input
                                    v-model="modalWorking.mBottom"
                                    type="number"
                                    min="0"
                                    class="input sm"
                                    :disabled="!canEdit"
                                />
                            </label>
                            <label
                                >Left
                                <input
                                    v-model="modalWorking.mLeft"
                                    type="number"
                                    min="0"
                                    class="input sm"
                                    :disabled="!canEdit"
                                />
                            </label>
                        </div>
                        <p class="hint">
                            Pane padding (inside spacing). Defaults to <em>1px</em> on all sides.
                        </p>
                    </section>

                    <section v-if="modalWorking.hasContainer" class="section">
                        <h3>This split (container)</h3>
                        <div class="row inputs">
                            <label
                                >Width
                                <input
                                    v-model="modalWorking.containerWidthPx"
                                    type="number"
                                    min="0"
                                    placeholder="auto"
                                    class="input sm"
                                    :disabled="!canEdit"
                                />
                            </label>
                            <label
                                >Height
                                <input
                                    v-model="modalWorking.containerHeightPx"
                                    type="number"
                                    min="0"
                                    placeholder="auto"
                                    class="input sm"
                                    :disabled="!canEdit"
                                />
                            </label>
                        </div>
                        <p class="hint">
                            Adjust the split container’s size (e.g., change overall
                            <em>800×600</em> after splitting). Children inherit the container along
                            the split’s cross-axis.
                        </p>
                    </section>

                    <section class="section">
                        <h3>Appearance</h3>
                        <div class="row">
                            <label class="row" style="gap: 0.35rem">
                                <input
                                    type="checkbox"
                                    v-model="modalWorking.bgEnabled"
                                    :disabled="!canEdit"
                                />
                                Use custom pane background
                            </label>
                            <input
                                type="color"
                                class="color"
                                :value="modalWorking.bgHex"
                                @input="
                                    modalWorking.bgHex = ($event.target as HTMLInputElement).value
                                "
                                :disabled="!canEdit || !modalWorking.bgEnabled"
                                aria-label="Pane background color"
                            />
                            <button
                                class="btn"
                                :disabled="!canEdit"
                                @click="modalWorking.bgEnabled = false"
                            >
                                Clear color
                            </button>
                        </div>
                    </section>

                    <section class="section">
                        <h3>Component</h3>
                        <select
                            v-model="modalWorking.componentKey"
                            class="select"
                            :disabled="!canEdit"
                        >
                            <option value="none">— none —</option>
                            <option value="LogsPane">LogsPane</option>
                        </select>
                    </section>
                </div>

                <!-- Sticky footer -->
                <div class="modal-foot">
                    <div class="row">
                        <button class="btn primary" :disabled="!canEdit" @click="applyModalToLeaf">
                            Apply
                        </button>
                        <button class="btn" @click="closeModal">Cancel</button>
                    </div>
                    <div class="row">
                        <button
                            v-if="modalTargetId && modalTargetId !== (rootId || '')"
                            class="btn danger"
                            title="Remove this pane"
                            :disabled="!canEdit"
                            @click="deleteFromModal"
                        >
                            Delete Pane
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script lang="ts">
import { defineComponent, h, type VNode } from 'vue'
export default { name: 'App' }

function renderLeaf(
    leaf: any,
    parentDir: 'row' | 'col' | null,
    isRoot: boolean,
    panes: any,
    emit: any,
    canEdit: boolean
): VNode {
    const inColumns = parentDir === 'row'
    const inRows = parentDir === 'col'
    const widthPx = leaf?.constraints?.widthPx ?? null
    const heightPx = leaf?.constraints?.heightPx ?? null
    const pTop = leaf?.appearance?.mTop ?? 0
    const pRight = leaf?.appearance?.mRight ?? 0
    const pBottom = leaf?.appearance?.mBottom ?? 0
    const pLeft = leaf?.appearance?.mLeft ?? 0

    const style: Record<string, string> = {
        position: 'relative',
        minWidth: '0',
        minHeight: '0',
        boxSizing: 'border-box',
        overflow: 'hidden',
        background: leaf?.appearance?.bg ?? '#ffffff',
        padding: `${pTop}px ${pRight}px ${pBottom}px ${pLeft}px`
    }

    if (inColumns) {
        style.height = '100%'
        if (widthPx != null) {
            style.flex = '0 0 auto'
            style.width = `${widthPx}px`
        } else {
            style.flex = '1 1 0%'
            style.width = 'auto'
        }
    } else if (inRows) {
        style.width = '100%'
        if (heightPx != null) {
            style.flex = '0 0 auto'
            style.height = `${heightPx}px`
        } else {
            style.flex = '1 1 0%'
            style.height = 'auto'
        }
    } else {
        style.width = widthPx != null ? `${widthPx}px` : '100%'
        style.height = heightPx != null ? `${heightPx}px` : '100%'
        style.flex = widthPx != null || heightPx != null ? '0 0 auto' : '1 1 0%'
        if (widthPx != null || heightPx != null) style.alignSelf = 'center'
    }

    const Comp = leaf?.component ? (panes as any)[leaf.component] ?? null : null
    const content = h('div', { style, class: 'studio-leaf' }, [
        canEdit
            ? h(
                  'button',
                  {
                      title: 'Pane menu',
                      onClick: () => emit('configure', leaf),
                      class: 'cell-gear tl'
                  },
                  '☰'
              )
            : null,
        Comp ? h(Comp) : h('div', { class: 'empty' }, 'Empty pane')
    ])

    const isRootConstrained = isRoot && (widthPx != null || heightPx != null)
    if (isRootConstrained) {
        return h(
            'div',
            { style: { width: '100%', height: '100%', display: 'grid', placeItems: 'center' } },
            [content]
        )
    }
    return content
}

function renderSplit(split: any, isRoot: boolean, panes: any, emit: any, canEdit: boolean): VNode {
    const cW: number | null | undefined = split?.constraints?.widthPx
    const cH: number | null | undefined = split?.constraints?.heightPx
    const hasW = cW != null
    const hasH = cH != null

    const containerStyle: Record<string, string> = {
        display: 'flex',
        flexDirection: split?.direction === 'row' ? 'row' : 'column',
        gap: '0px',
        minWidth: '0',
        minHeight: '0',
        boxSizing: 'border-box'
    }

    containerStyle.width = hasW ? `${cW as number}px` : '100%'
    containerStyle.height = hasH ? `${cH as number}px` : '100%'
    containerStyle.flex = hasW || hasH ? '0 0 auto' : '1 1 0%'
    if (isRoot && (hasW || hasH)) containerStyle.alignSelf = 'center'

    const kids: any[] = Array.isArray(split?.children) ? split.children : []
    const childrenV: VNode[] = kids.map((child: any) =>
        renderNode(child, split?.direction === 'row' ? 'row' : 'col', false, panes, emit, canEdit)
    )

    const container = h('div', { style: containerStyle }, childrenV)

    if (isRoot && (hasW || hasH)) {
        return h(
            'div',
            { style: { width: '100%', height: '100%', display: 'grid', placeItems: 'center' } },
            [container]
        )
    }
    return container
}

function renderNode(
    node: any,
    parentDir: 'row' | 'col' | null,
    isRoot: boolean,
    panes: any,
    emit: any,
    canEdit: boolean
): VNode {
    return node?.kind === 'split'
        ? renderSplit(node, isRoot, panes, emit, canEdit)
        : renderLeaf(node, parentDir, isRoot, panes, emit, canEdit)
}

export const RenderNode = defineComponent({
    name: 'RenderNode',
    props: {
        node: { type: Object, required: true },
        panes: { type: Object, required: true },
        isRoot: { type: Boolean, default: false },
        parentDir: { type: String as () => 'row' | 'col' | null, default: null },
        canEdit: { type: Boolean, required: true }
    },
    emits: ['split', 'configure', 'delete'],
    setup(props, { emit }) {
        return (): VNode =>
            renderNode(props.node, props.parentDir, props.isRoot, props.panes, emit, props.canEdit)
    }
})
</script>

<style>
/* Full dark surround (outside panes) */
html,
body,
#app {
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: #000;
    color-scheme: dark;
}

/* Full-viewport container */
.studio-root,
.tree-root {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: transparent;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}
.tree-root > * {
    flex: 1 1 0%;
    min-width: 0;
    min-height: 0;
}

/* Leaf content */
.studio-leaf {
    display: flex;
    align-items: stretch;
    justify-content: stretch;
}

/* Empty state */
.empty {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    color: #6b7280;
    font-size: 0.95rem;
}

/* Hover menu button (hamburger), top-left */
.cell-gear {
    position: absolute;
    border: 1px solid #d1d5db;
    background: white;
    color: #111827;
    border-radius: 8px;
    padding: 0.2rem 0.45rem;
    cursor: pointer;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 0.15s ease;
    z-index: 10;
    font-size: 0.95rem;
    line-height: 1;
}
.cell-gear.tl {
    top: 0.5rem;
    left: 0.5rem;
}
.studio-leaf:hover .cell-gear {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
}

/* Modal layout: header + scroll + footer (sticky) */
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

    /* sticky header/footer layout */
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
.view-only {
    display: inline-block;
    padding: 0.2rem 0.45rem;
    border: 1px solid #6b7280;
    border-radius: 0.4rem;
    font-size: 0.78rem;
    color: #d1d5db;
    margin-right: 0.5rem;
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

/* Inputs: compact widths */
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
</style>
