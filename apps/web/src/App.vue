<!-- apps/web/src/App.vue -->
<script setup lang="ts">
import { onMounted, ref, reactive, computed, watch } from 'vue'
import { startRealtime } from './bootstrap'
import { listPanes, hasPane } from './panes/registry'
import PaneSettingsModal from './components/PaneSettingsModal.vue'

/** Types */
type Direction = 'row' | 'col'
type Constraints = {
    widthPx?: number | null
    heightPx?: number | null
    /** percentage sizing relative to split container’s axis (0–100) */
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

/** Utils */
const uid = () => Math.random().toString(36).slice(2, 10)
const deepClone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

/** Local layout persistence */
const LAYOUT_LS = 'ab98:studio:layout'

/** Base layout */
function makeSinglePane(): LeafNode {
    return {
        id: uid(),
        kind: 'leaf',
        component: null,
        props: {},
        constraints: { widthPx: null, heightPx: null, widthPct: null, heightPct: null },
        appearance: { bg: null, mTop: 1, mRight: 1, mBottom: 1, mLeft: 1 }
    }
}
const root = reactive<LayoutNode>(makeSinglePane())
const rootId = computed<string>(() => (root as any)?.id ?? '')
const canEdit = computed<boolean>(() => true)

/** Pane options */
const paneOptions = computed(() => [{ id: 'none', label: '— none —' }, ...listPanes()])

/** Server layouts (profiles) */
const layoutList = ref<Profile[]>([])
const selectedProfileId = ref<string>('')

async function apiJSON<T = any>(url: string, init?: RequestInit): Promise<T> {
    const hasBody = init && 'body' in init && init.body != null
    const headers: Record<string, string> = { ...(init?.headers as any) }
    if (hasBody) headers['content-type'] = headers['content-type'] || 'application/json'
    const res = await fetch(url, { ...init, headers })
    if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
            msg = (await res.text()) || msg
        } catch {}
        throw new Error(msg)
    }
    if (res.status === 204) return undefined as unknown as T
    return res.json() as Promise<T>
}

async function refreshLayouts() {
    try {
        const data = await apiJSON<{ ok: boolean; items: Profile[] }>('/api/layouts')
        layoutList.value = Array.isArray(data.items) ? data.items : []
        if (!layoutList.value.find((p) => p.id === selectedProfileId.value)) {
            selectedProfileId.value = ''
        }
    } catch {
        layoutList.value = []
        selectedProfileId.value = ''
    }
}
async function loadProfile(id: string) {
    if (!id) return
    const data = await apiJSON<{ ok: boolean; profile: Profile }>(`/api/layouts/${id}`)
    const loaded = data.profile?.layout
    if (!loaded || typeof loaded !== 'object') return
    Object.keys(root as any).forEach((k) => delete (root as any)[k])
    Object.assign(root as any, deepClone(loaded))
}
async function saveCurrentAs(name: string) {
    if (!canEdit.value) return
    const body = { name: String(name || '').trim(), layout: deepClone(root) }
    const data = await apiJSON<{ ok: boolean; profile: Profile }>('/api/layouts', {
        method: 'POST',
        body: JSON.stringify(body)
    })
    await refreshLayouts()
    selectedProfileId.value = data.profile.id
}
async function overwriteSelected() {
    if (!canEdit.value) return
    const id = selectedProfileId.value
    if (!id) return
    const body = { layout: deepClone(root) }
    await apiJSON<{ ok: boolean; profile: Profile }>(`/api/layouts/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body)
    })
    await refreshLayouts()
}
async function deleteSelected() {
    if (!canEdit.value) return
    const id = selectedProfileId.value
    if (!id) return
    await apiJSON<{ ok: boolean; defaultId: string | null }>(`/api/layouts/${id}`, {
        method: 'DELETE'
    })
    const fresh = makeSinglePane()
    Object.keys(root as any).forEach((k) => delete (root as any)[k])
    Object.assign(root as any, fresh)
    selectedProfileId.value = ''
    await refreshLayouts()
}

/** Modal control (lifted state) */
const isModalOpen = ref(false)
const modalTargetId = ref<string | null>(null)
type ModalModel = {
    componentKey: string
    // unified inputs with unit for width/height
    widthValue: string | number
    widthUnit: 'px' | 'pct'
    heightValue: string | number
    heightUnit: 'px' | 'pct'
    // existing
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
const initialModel = ref<ModalModel>({
    componentKey: 'none',
    widthValue: '',
    widthUnit: 'px',
    heightValue: '',
    heightUnit: 'px',
    bgEnabled: false,
    bgHex: '#ffffff',
    mTop: '1',
    mRight: '1',
    mBottom: '1',
    mLeft: '1',
    lockWidthCross: false,
    lockHeightCross: false,
    mustBeFluidWidth: false,
    mustBeFluidHeight: false,
    hasContainer: false,
    containerWidthPx: '',
    containerHeightPx: ''
})

/** Tree helpers */
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

/** Split/Delete */
function splitLeaf(targetId: string, direction: Direction) {
    if (!canEdit.value) return
    const found = findNodeAndParent(targetId, root, null)
    if (!found) return
    const { node, parent } = found
    if (node.kind !== 'leaf') return

    const movedConstraints: Constraints = deepClone(
        node.constraints ?? { widthPx: null, heightPx: null, widthPct: null, heightPct: null }
    )
    const a: LeafNode = {
        id: uid(),
        kind: 'leaf',
        component: node.component ?? null,
        props: deepClone(node.props ?? {}),
        constraints: { widthPx: null, heightPx: null, widthPct: null, heightPct: null },
        appearance: deepClone(
            (node as LeafNode).appearance ?? { bg: null, mTop: 1, mRight: 1, mBottom: 1, mLeft: 1 }
        )
    }
    const b: LeafNode = makeSinglePane()
    b.constraints = { widthPx: null, heightPx: null, widthPct: null, heightPct: null }

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
            ;(root as LeafNode).constraints = {
                widthPx: null,
                heightPx: null,
                widthPct: null,
                heightPct: null
            }
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

/** Axis locking rules */
function computeMainAxisFluidRule(parent: SplitNode | null, currentId: string) {
    if (!parent) return { main: null as 'width' | 'height' | null, mustBeFluid: false }
    const isRow = parent.direction === 'row'
    const main: 'width' | 'height' = isRow ? 'width' : 'height'
    const kids = Array.isArray(parent.children) ? parent.children : []
    const others = kids.filter((c) => c.id !== currentId)
    const othersFixed = others.every((c) => {
        const cons: Constraints = (c as any).constraints ?? {}
        const fixedPx = isRow ? cons.widthPx != null : cons.heightPx != null
        const fixedPct = isRow ? cons.widthPct != null : cons.heightPct != null
        return fixedPx || fixedPct
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

/** Modal open/close + initial model creation */
function openModalForLeaf(leaf: LeafNode) {
    modalTargetId.value = leaf.id

    const currentKey =
        leaf.component && hasPane(String(leaf.component)) ? String(leaf.component) : 'none'
    const locks = getAxisLocksForLeaf(leaf.id)

    // decide units from constraints
    const wPx = leaf.constraints?.widthPx
    const wPct = leaf.constraints?.widthPct
    const hPx = leaf.constraints?.heightPx
    const hPct = leaf.constraints?.heightPct

    const widthUnit: 'px' | 'pct' = wPx != null ? 'px' : wPct != null ? 'pct' : 'px'
    const heightUnit: 'px' | 'pct' = hPx != null ? 'px' : hPct != null ? 'pct' : 'px'
    const widthValue = wPx != null ? String(wPx) : wPct != null ? String(wPct) : ''
    const heightValue = hPx != null ? String(hPx) : hPct != null ? String(hPct) : ''

    const parent = getParentSplit(leaf.id)
    const hasContainer = !!parent
    const containerWidthPx =
        hasContainer && parent?.constraints?.widthPx != null
            ? String(parent!.constraints!.widthPx)
            : ''
    const containerHeightPx =
        hasContainer && parent?.constraints?.heightPx != null
            ? String(parent!.constraints!.heightPx)
            : ''

    initialModel.value = {
        componentKey: currentKey,
        widthValue,
        widthUnit,
        heightValue,
        heightUnit,
        bgEnabled: !!leaf.appearance?.bg,
        bgHex: leaf.appearance?.bg ?? '#ffffff',
        mTop: String(leaf.appearance?.mTop ?? 1),
        mRight: String(leaf.appearance?.mRight ?? 1),
        mBottom: String(leaf.appearance?.mBottom ?? 1),
        mLeft: String(leaf.appearance?.mLeft ?? 1),
        lockWidthCross: locks.lockWidthCross,
        lockHeightCross: locks.lockHeightCross,
        mustBeFluidWidth: locks.mustBeFluidWidth,
        mustBeFluidHeight: locks.mustBeFluidHeight,
        hasContainer,
        containerWidthPx,
        containerHeightPx
    }

    if (initialModel.value.lockWidthCross || initialModel.value.mustBeFluidWidth)
        initialModel.value.widthValue = ''
    if (initialModel.value.lockHeightCross || initialModel.value.mustBeFluidHeight)
        initialModel.value.heightValue = ''

    isModalOpen.value = true
}
function closeModal() {
    isModalOpen.value = false
    modalTargetId.value = null
}

/** Modal callbacks */
function clearLayout() {
    if (!canEdit.value) return
    const fresh = makeSinglePane()
    Object.keys(root as any).forEach((k) => delete (root as any)[k])
    Object.assign(root as any, fresh)
}
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
function toIntOrNull(v: string | number): number | null {
    const s = String(v ?? '').trim()
    return s === '' ? null : Math.max(0, parseInt(s, 10) || 0)
}
function clampPct(v: number | null): number | null {
    if (v == null) return null
    if (!Number.isFinite(v)) return null
    return Math.max(0, Math.min(100, Math.floor(v)))
}
function applyModal(model: any) {
    if (!canEdit.value) return
    const id = modalTargetId.value
    if (!id) return
    const found = findNodeAndParent(id, root, null)
    if (!found) return
    const { node } = found
    if (node.kind !== 'leaf') return

    const key = String(model.componentKey || 'none')
    ;(node as LeafNode).component = key === 'none' ? null : key

    // Resolve width/height to px or %
    let widthPx: number | null = null
    let heightPx: number | null = null
    let widthPct: number | null = null
    let heightPct: number | null = null

    if (!model.lockWidthCross && !model.mustBeFluidWidth) {
        if (model.widthUnit === 'px') {
            widthPx = toIntOrNull(model.widthValue)
            widthPct = null
        } else {
            widthPct = clampPct(toIntOrNull(model.widthValue))
            widthPx = null
        }
    }
    if (!model.lockHeightCross && !model.mustBeFluidHeight) {
        if (model.heightUnit === 'px') {
            heightPx = toIntOrNull(model.heightValue)
            heightPct = null
        } else {
            heightPct = clampPct(toIntOrNull(model.heightValue))
            heightPx = null
        }
    }

    // If locked or must-be-fluid, force auto (null for both px/pct)
    if (model.lockWidthCross || model.mustBeFluidWidth) {
        widthPx = null
        widthPct = null
    }
    if (model.lockHeightCross || model.mustBeFluidHeight) {
        heightPx = null
        heightPct = null
    }

    ;(node as LeafNode).constraints = { widthPx, heightPx, widthPct, heightPct }

    const useBg = !!model.bgEnabled
    const hex =
        typeof model.bgHex === 'string' && /^#[0-9a-fA-F]{6}$/.test(model.bgHex)
            ? model.bgHex
            : '#ffffff'
    const pTop = toIntOrNull(model.mTop) ?? 0
    const pRight = toIntOrNull(model.mRight) ?? 0
    const pBottom = toIntOrNull(model.mBottom) ?? 0
    const pLeft = toIntOrNull(model.mLeft) ?? 0
    ;(node as LeafNode).appearance = {
        bg: useBg ? hex : null,
        mTop: pTop,
        mRight: pRight,
        mBottom: pBottom,
        mLeft: pLeft
    }

    if (model.hasContainer) {
        const parent = getParentSplit(node.id)
        if (parent) {
            const cWidthPx = toIntOrNull(model.containerWidthPx)
            const cHeightPx = toIntOrNull(model.containerHeightPx)
            parent.constraints = {
                widthPx: cWidthPx,
                heightPx: cHeightPx,
                widthPct: null,
                heightPct: null
            }
        }
    }

    closeModal()
}

/** Bootstrap */
const urlParams = new URLSearchParams(window.location.search)
const layoutParam = urlParams.get('layout')
if (layoutParam) {
    try {
        const raw = atob(
            layoutParam
                .replace(/-/g, '+')
                .replace(/_/g, '/')
                .padEnd(Math.ceil(layoutParam.length / 4) * 4, '=')
        )
        const json = decodeURIComponent(
            Array.prototype.map
                .call(raw, (c: string) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
                .join('')
        )
        const decoded = JSON.parse(json)
        if (decoded && typeof decoded === 'object') {
            Object.keys(root as any).forEach((k) => delete (root as any)[k])
            Object.assign(root as any, deepClone(decoded))
        }
    } catch {}
}
const ls = localStorage.getItem(LAYOUT_LS)
if (ls) {
    try {
        const parsed = JSON.parse(ls)
        if (parsed && typeof parsed === 'object') Object.assign(root as any, parsed)
    } catch {}
}
watch(
    () => root,
    () => localStorage.setItem(LAYOUT_LS, JSON.stringify(root)),
    { deep: true }
)

onMounted(async () => {
    startRealtime('/ws')
    await refreshLayouts()
})
</script>

<template>
    <div class="studio-root">
        <div class="tree-root">
            <RenderNode
                :node="root"
                :is-root="true"
                :parent-dir="null"
                :can-edit="canEdit"
                @split="splitLeaf"
                @configure="openModalForLeaf"
                @delete="deleteLeaf"
            />
        </div>

        <PaneSettingsModal
            :is-open="isModalOpen"
            :can-edit="canEdit"
            :target-id="modalTargetId"
            :root-id="rootId"
            :pane-options="paneOptions"
            :layout-list="layoutList"
            :selected-profile-id="selectedProfileId"
            :initial-model="initialModel"
            @close="closeModal"
            @clearLayout="clearLayout"
            @splitRow="splitRowFromModal"
            @splitCol="splitColFromModal"
            @deletePane="deleteFromModal"
            @apply="applyModal"
            @loadProfile="loadProfile"
            @overwriteSelected="overwriteSelected"
            @deleteSelected="deleteSelected"
            @saveCurrentAs="saveCurrentAs"
            @update:selectedProfileId="(val) => (selectedProfileId = val)"
        />
    </div>
</template>

<script lang="ts">
import { defineComponent, h, type VNode } from 'vue'
import { resolvePane, getPaneLabel } from './panes/registry'
export default { name: 'App' }

/** Keep a local copy of UI-facing types for this renderer block */
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
    children: any[]
    constraints?: Constraints
}

/** Pane context passed to children */
export type PaneInfo = {
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

/* -------------------------------
   Contrast helpers (also for HUD)
--------------------------------*/
function normalizeHex(input: unknown): string | null {
    const s = typeof input === 'string' ? input.trim() : ''
    if (!s) return null
    if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s)) return null
    if (s.length === 4) {
        const r = s[1],
            g = s[2],
            b = s[3]
        return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
    }
    return s.toLowerCase()
}
function hexToRgb(hex: string): { r: number; g: number; b: number } {
    const n = hex.replace('#', '')
    return {
        r: parseInt(n.slice(0, 2), 16),
        g: parseInt(n.slice(2, 4), 16),
        b: parseInt(n.slice(4, 6), 16)
    }
}
function srgbToLinear(c: number): number {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
function relativeLuminance(hex: string): number {
    const { r, g, b } = hexToRgb(hex)
    const R = srgbToLinear(r),
        G = srgbToLinear(g),
        B = srgbToLinear(b)
    return 0.2126 * R + 0.7152 * G + 0.0722 * B
}
function contrastRatio(L1: number, L2: number): number {
    const [a, b] = L1 >= L2 ? [L1, L2] : [L2, L1]
    return (a + 0.05) / (b + 0.05)
}
/** Choose black or white text for best contrast against bg */
function bestContrastOnBlackOrWhite(bgHex: string): string {
    const Lbg = relativeLuminance(bgHex)
    const cBlack = contrastRatio(Lbg, 0)
    const cWhite = contrastRatio(1, Lbg)
    return cBlack >= cWhite ? '#111827' : '#ffffff'
}

/* -------------------------------
   HUD helpers
--------------------------------*/
type DimKind = 'px' | 'pct' | 'auto'
function fmtDim(
    px: number | null | undefined,
    pct: number | null | undefined
): { text: string; kind: DimKind } {
    if (px != null) return { text: `${px}px`, kind: 'px' }
    if (pct != null) return { text: `${pct}%`, kind: 'pct' }
    return { text: 'auto', kind: 'auto' }
}

function ariaDescribePane(name: string, w: { text: string }, h: { text: string }) {
    return `${name}. Width ${w.text}. Height ${h.text}.`
}

function renderBadge(label: string, kind: DimKind, fg: string): VNode {
    const base: Record<string, string> = {
        display: 'inline-block',
        padding: '2px 6px',
        borderRadius: '6px',
        fontSize: '11px',
        lineHeight: '1',
        border: '1px solid',
        marginLeft: '6px'
    }
    if (kind === 'px') {
        base.background = 'rgba(0,0,0,0.25)'
        base.borderColor = 'rgba(0,0,0,0.35)'
        base.fontWeight = '600'
    } else if (kind === 'pct') {
        base.background = 'transparent'
        base.borderStyle = 'dashed'
        base.borderColor = 'currentColor'
    } else {
        base.background = 'transparent'
        base.borderColor = 'transparent'
        base.opacity = '0.9'
        base.fontStyle = 'italic'
    }
    base.color = fg
    return h('span', { style: base, 'data-kind': kind }, label)
}

function renderLeaf(
    leaf: any,
    parentDir: Direction | null,
    isRoot: boolean,
    emit: any,
    canEdit: boolean,
    containerConstraints: Constraints | null
): VNode {
    const inColumns = parentDir === 'row'
    const inRows = parentDir === 'col'
    const widthPx = leaf?.constraints?.widthPx ?? null
    const heightPx = leaf?.constraints?.heightPx ?? null
    const widthPct = leaf?.constraints?.widthPct ?? null
    const heightPct = leaf?.constraints?.heightPct ?? null
    const pTop = leaf?.appearance?.mTop ?? 0
    const pRight = leaf?.appearance?.mRight ?? 0
    const pBottom = leaf?.appearance?.mBottom ?? 0
    const pLeft = leaf?.appearance?.mLeft ?? 0

    const bgHexNormalized = normalizeHex(leaf?.appearance?.bg) ?? '#ffffff'
    const textColor = bestContrastOnBlackOrWhite(bgHexNormalized)

    const style: Record<string, string> = {
        position: 'relative',
        minWidth: '0',
        minHeight: '0',
        boxSizing: 'border-box',
        overflow: 'hidden',
        background: bgHexNormalized,
        padding: `${pTop}px ${pRight}px ${pBottom}px ${pLeft}px`
    }

    function applyWidth() {
        if (widthPx != null) {
            style.flex = '0 0 auto'
            style.width = `${widthPx}px`
        } else if (widthPct != null) {
            style.flex = '0 0 auto'
            style.width = `${widthPct}%`
        } else {
            style.flex = '1 1 0%'
            style.width = 'auto'
        }
    }
    function applyHeight() {
        if (heightPx != null) {
            style.flex = '0 0 auto'
            style.height = `${heightPx}px`
        } else if (heightPct != null) {
            style.flex = '0 0 auto'
            style.height = `${heightPct}%`
        } else {
            style.flex = '1 1 0%'
            style.height = 'auto'
        }
    }

    if (inColumns) {
        style.height = '100%'
        applyWidth()
    } else if (inRows) {
        style.width = '100%'
        applyHeight()
    } else {
        style.width = widthPx != null ? `${widthPx}px` : widthPct != null ? `${widthPct}%` : '100%'
        style.height =
            heightPx != null ? `${heightPx}px` : heightPct != null ? `${heightPct}%` : '100%'
        style.flex =
            widthPx != null || widthPct != null || heightPx != null || heightPct != null
                ? '0 0 auto'
                : '1 1 0%'
        if (widthPx != null || widthPct != null || heightPx != null || heightPct != null)
            style.alignSelf = 'center'
    }

    const paneInfo: PaneInfo = {
        id: String(leaf?.id ?? ''),
        isRoot,
        parentDir,
        constraints: { widthPx, heightPx, widthPct, heightPct },
        appearance: {
            bg: bgHexNormalized,
            mTop: pTop,
            mRight: pRight,
            mBottom: pBottom,
            mLeft: pLeft
        },
        container: { constraints: containerConstraints ?? null, direction: parentDir }
    }

    const Comp = leaf?.component ? resolvePane(String(leaf.component)) : null

    // HUD content (name + size badges)
    const paneName = getPaneLabel(leaf?.component ?? null)
    const wBadge = fmtDim(widthPx, widthPct)
    const hBadge = fmtDim(heightPx, heightPct)
    const ariaText = ariaDescribePane(paneName, wBadge, hBadge)

    const hud = h(
        'div',
        {
            class: 'pane-hud',
            style: {
                color: textColor,
                background: 'rgba(0,0,0,0.08)',
                border: '1px solid rgba(0,0,0,0.15)',
                backdropFilter: 'blur(2px)'
            },
            role: 'note',
            'aria-hidden': 'true'
        },
        [
            h('span', { class: 'pane-hud__name', style: { fontWeight: '600' } }, paneName),
            renderBadge(`W: ${wBadge.text}`, wBadge.kind, textColor),
            renderBadge(`H: ${hBadge.text}`, hBadge.kind, textColor)
        ]
    )

    const content = h('div', { style, class: 'studio-leaf' }, [
        canEdit
            ? h(
                  'button',
                  {
                      title: 'Pane menu',
                      onClick: () => emit('configure', leaf),
                      class: 'cell-gear tl',
                      'aria-label': ariaText
                  },
                  '☰'
              )
            : null,
        // HUD next to the gear (only visible on hover via CSS)
        canEdit ? hud : null,
        // SR-only live text so screen readers hear updates when constraints or component change
        h('span', { class: 'sr-only', 'aria-live': 'polite' }, ariaText),
        Comp
            ? h(Comp as any, { pane: paneInfo, ...(leaf?.props ?? {}) })
            : h('div', { class: 'empty', style: { color: textColor } }, 'Empty pane')
    ])

    const isRootConstrained =
        isRoot && (widthPx != null || widthPct != null || heightPx != null || heightPct != null)
    if (isRootConstrained) {
        return h(
            'div',
            { style: { width: '100%', height: '100%', display: 'grid', placeItems: 'center' } },
            [content]
        )
    }
    return content
}

function renderSplit(split: SplitNode, isRoot: boolean, emit: any, canEdit: boolean): VNode {
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
        renderNode(
            child,
            split?.direction === 'row' ? 'row' : 'col',
            false,
            emit,
            canEdit,
            split?.constraints ?? null
        )
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
    parentDir: Direction | null,
    isRoot: boolean,
    emit: any,
    canEdit: boolean,
    containerConstraints: Constraints | null
): VNode {
    return node?.kind === 'split'
        ? renderSplit(node as SplitNode, isRoot, emit, canEdit)
        : renderLeaf(node as LeafNode, parentDir, isRoot, emit, canEdit, containerConstraints)
}

export const RenderNode = defineComponent({
    name: 'RenderNode',
    props: {
        node: { type: Object, required: true },
        isRoot: { type: Boolean, default: false },
        parentDir: { type: String as () => Direction | null, default: null },
        canEdit: { type: Boolean, required: true }
    },
    emits: ['split', 'configure', 'delete'],
    setup(props, { emit }) {
        return (): VNode =>
            renderNode(props.node, props.parentDir, props.isRoot, emit, props.canEdit, null)
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
    color: #6b7280; /* overridden inline when a bg is set */
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
    transition: opacity 0.15s ease, transform 0.1s ease;
    z-index: 10;
    font-size: 0.95rem;
    line-height: 1;
}
.cell-gear.tl {
    top: 0.5rem;
    left: 0.5rem;
}
.studio-leaf:hover .cell-gear,
.cell-gear:focus,
.cell-gear:focus-visible {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
}
.cell-gear:hover {
    transform: translateY(-1px);
}

/* NEW: Pane HUD, displayed next to the gear on hover/focus */
.pane-hud {
    position: absolute;
    top: 0.5rem;
    left: 2.4rem; /* just to the right of the gear */
    padding: 0.2rem 0.5rem;
    border-radius: 8px;
    font-size: 12px;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 0.15s ease;
    z-index: 9; /* just beneath the gear so the gear stays clickable */
}
.studio-leaf:hover .pane-hud,
.cell-gear:focus + .pane-hud {
    opacity: 1;
    visibility: visible;
}

.pane-hud__name {
    margin-right: 2px;
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

/* screen-reader only helper */
.sr-only {
    position: absolute !important;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
}
</style>
