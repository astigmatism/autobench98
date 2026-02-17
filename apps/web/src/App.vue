<!-- apps/web/src/App.vue -->
<script setup lang="ts">
import {
    onMounted,
    onBeforeUnmount,
    ref,
    reactive,
    computed,
    watch,
    defineComponent,
    h,
    type VNode
} from 'vue'
import { startRealtime } from './bootstrap'
import { listPanes, hasPane, listPanePrefsSpecs, resolvePane, getPaneLabel } from './panes/registry'
import PaneSettingsModal from './components/PaneSettingsModal.vue'
import { useLogs } from '@/stores/logs'

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

/** Local-only pane info type (exported version is in the non-setup script block) */
type PaneInfoLocal = {
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

/** Utils */
const uid = () => Math.random().toString(36).slice(2, 10)
const deepClone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

/** Local layout persistence */
const LAYOUT_LS = 'ab98:studio:layout'

/** Resizing (gutters) configuration */
const GUTTER_PX = 2
const MIN_RESIZABLE_PANE_PX = 48

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

/** Logs store (ingestion + fallback UI persistence) */
const logs = useLogs()

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

/* -----------------------------------------
   Per-pane UI prefs (profile persistence)
------------------------------------------ */

function isObject(x: any): x is Record<string, unknown> {
    return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function walkLeaves(node: LayoutNode, fn: (leaf: LeafNode) => void) {
    if (!node || typeof node !== 'object') return
    if ((node as any).kind === 'leaf') {
        fn(node as LeafNode)
        return
    }
    if ((node as any).kind === 'split' && Array.isArray((node as any).children)) {
        for (const child of (node as any).children as LayoutNode[]) walkLeaves(child, fn)
    }
}

/**
 * Embed per-pane prefs (from localStorage) into leaf.props so it round-trips with profiles.
 * We do this at save time to avoid constantly mutating the live layout tree.
 */
function embedPanePrefsIntoLayout(layout: LayoutNode): LayoutNode {
    const cloned = deepClone(layout)
    const specs = listPanePrefsSpecs()

    walkLeaves(cloned, (leaf) => {
        const id = String(leaf?.id ?? '').trim()
        if (!id) return

        for (const spec of specs) {
            const key = `${spec.storagePrefix}${id}`
            let parsed: any = null

            try {
                const raw = localStorage.getItem(key)
                if (!raw) continue
                parsed = JSON.parse(raw)
            } catch {
                continue
            }

            if (!isObject(parsed)) continue

            if (!isObject(leaf.props)) leaf.props = {}
            ;(leaf.props as any)[spec.propsKey] = parsed
        }
    })

    return cloned
}

/**
 * After loading a profile, make the profile authoritative for per-pane prefs:
 */
function restorePanePrefsFromLayout(layout: LayoutNode) {
    const specs = listPanePrefsSpecs()

    walkLeaves(layout, (leaf) => {
        const id = String(leaf?.id ?? '').trim()
        if (!id) return

        for (const spec of specs) {
            const key = `${spec.storagePrefix}${id}`
            const prefs = (leaf as any)?.props?.[spec.propsKey]

            try {
                if (isObject(prefs)) {
                    localStorage.setItem(key, JSON.stringify(prefs))
                } else {
                    localStorage.removeItem(key)
                }
            } catch {
                // ignore storage failures
            }
        }
    })
}

/**
 * Stamp a monotonic "profile revision" on all leaves so panes can detect loads.
 */
function stampProfileRevsOnLayout(layout: LayoutNode, rev: number) {
    const specs = listPanePrefsSpecs()

    walkLeaves(layout, (leaf) => {
        if (!isObject(leaf.props)) leaf.props = {}
        for (const spec of specs) {
            ;(leaf.props as any)[spec.profileRevKey] = rev
        }
    })
}

let panePrefsProfileRev = 0

async function loadProfile(id: string) {
    if (!id) return
    const data = await apiJSON<{ ok: boolean; profile: Profile }>(`/api/layouts/${id}`)

    const loaded = data.profile?.layout
    if (loaded && typeof loaded === 'object') {
        const cloned = deepClone(loaded)

        restorePanePrefsFromLayout(cloned)

        panePrefsProfileRev += 1
        stampProfileRevsOnLayout(cloned, panePrefsProfileRev)

        Object.keys(root as any).forEach((k) => delete (root as any)[k])
        Object.assign(root as any, cloned)
    }
}

async function saveCurrentAs(name: string) {
    if (!canEdit.value) return
    const body = {
        name: String(name || '').trim(),
        layout: embedPanePrefsIntoLayout(root)
    }
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
    const body = {
        layout: embedPanePrefsIntoLayout(root)
    }
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
    widthValue: string | number
    widthUnit: 'px' | 'pct'
    heightValue: string | number
    heightUnit: 'px' | 'pct'
    splitCount: string | number
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
    splitCount: 2,
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
function findSplitById(splitId: string): SplitNode | null {
    const fp = findNodeAndParent(splitId, root, null)
    if (!fp) return null
    return fp.node?.kind === 'split' ? (fp.node as SplitNode) : null
}

/** Split sizing helpers (for resizable gutters) */
function getNodeConstraints(node: LayoutNode): Constraints {
    return ((node as any)?.constraints ?? {}) as Constraints
}
function isFixedOnSplitAxis(node: LayoutNode, splitDir: Direction): boolean {
    const c = getNodeConstraints(node)
    if (splitDir === 'row') return c.widthPx != null || c.widthPct != null
    return c.heightPx != null || c.heightPct != null
}

function computeSplitWeightsForRender(split: SplitNode): number[] {
    const kids: LayoutNode[] = Array.isArray(split?.children) ? split.children : []
    const len = kids.length
    const raw = Array.isArray(split?.sizes) ? split.sizes : []
    const weights = Array.from({ length: len }, () => 0)

    const flexIdx: number[] = []
    for (let i = 0; i < len; i++) {
        const kid = kids[i]
        if (!kid) continue
        if (!isFixedOnSplitAxis(kid, split.direction)) flexIdx.push(i)
    }
    if (flexIdx.length === 0) return weights

    const valid: number[] = []
    const missing: number[] = []
    for (const i of flexIdx) {
        const v = Number(raw[i] ?? 0)
        if (Number.isFinite(v) && v > 0) {
            weights[i] = v
            valid.push(i)
        } else {
            missing.push(i)
        }
    }

    if (valid.length === 0) {
        const eq = 100 / flexIdx.length
        for (const i of flexIdx) weights[i] = eq
        return weights
    }

    if (missing.length > 0) {
        const sumValid = valid.reduce((acc, i) => acc + (weights[i] ?? 0), 0)
        const avg = Math.max(1, sumValid / valid.length)
        for (const i of missing) weights[i] = avg
    }

    return weights
}

function ensureSplitSizes(split: SplitNode): number[] {
    const kids: LayoutNode[] = Array.isArray(split?.children) ? split.children : []
    const len = kids.length
    const raw = Array.isArray(split?.sizes) ? split.sizes : []
    const next = Array.from({ length: len }, (_, i) => {
        const v = Number(raw[i] ?? 0)
        return Number.isFinite(v) ? v : 0
    })

    const flexIdx: number[] = []
    for (let i = 0; i < len; i++) {
        const kid = kids[i]
        if (!kid) continue
        if (!isFixedOnSplitAxis(kid, split.direction)) flexIdx.push(i)
    }

    if (flexIdx.length === 0) {
        split.sizes = next
        return next
    }

    const valid: number[] = []
    const missing: number[] = []
    for (const i of flexIdx) {
        const v = next[i] ?? 0
        if (v > 0) valid.push(i)
        else missing.push(i)
    }

    if (valid.length === 0) {
        const eq = 100 / flexIdx.length
        for (const i of flexIdx) next[i] = eq
    } else if (missing.length > 0) {
        const sumValid = valid.reduce((acc, i) => acc + (next[i] ?? 0), 0)
        const avg = Math.max(1, sumValid / valid.length)
        for (const i of missing) next[i] = avg
    }

    split.sizes = next
    return next
}

/** Split/Delete helpers */
function splitLeafBinary(targetId: string, direction: Direction) {
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

function splitLeafN(targetId: string, direction: Direction, count: number) {
    if (!canEdit.value) return
    if (count <= 1) return

    const found = findNodeAndParent(targetId, root, null)
    if (!found) return
    const { node, parent } = found
    if (node.kind !== 'leaf') return

    const movedConstraints: Constraints = deepClone(
        node.constraints ?? { widthPx: null, heightPx: null, widthPct: null, heightPct: null }
    )

    const baseAppearance: Appearance = deepClone(
        (node as LeafNode).appearance ?? { bg: null, mTop: 1, mRight: 1, mBottom: 1, mLeft: 1 }
    )

    const children: LeafNode[] = []

    const first: LeafNode = {
        id: uid(),
        kind: 'leaf',
        component: node.component ?? null,
        props: deepClone(node.props ?? {}),
        constraints: { widthPx: null, heightPx: null, widthPct: null, heightPct: null },
        appearance: baseAppearance
    }
    children.push(first)

    for (let i = 1; i < count; i++) {
        const child = makeSinglePane()
        child.constraints = { widthPx: null, heightPx: null, widthPct: null, heightPct: null }
        children.push(child)
    }

    const equalSize = Math.floor((100 / count) * 100) / 100
    const sizes = Array.from({ length: count }, () => equalSize)

    const replacement: SplitNode = {
        id: uid(),
        kind: 'split',
        direction,
        children,
        sizes,
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
            ;(root as LeafNode).constraints = { widthPx: null, heightPx: null, widthPct: null, heightPct: null }
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
    if (Array.isArray(parent.sizes)) parent.sizes.splice(idx, 1)

    if (parent.children.length === 1) {
        const survivor = parent.children[0]
        if (!survivor) return

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
        return { lockWidthCross: false, lockHeightCross: false, mustBeFluidWidth: false, mustBeFluidHeight: false }
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

    const currentKey = leaf.component && hasPane(String(leaf.component)) ? String(leaf.component) : 'none'
    const locks = getAxisLocksForLeaf(leaf.id)

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
        hasContainer && parent?.constraints?.widthPx != null ? String(parent!.constraints!.widthPx) : ''
    const containerHeightPx =
        hasContainer && parent?.constraints?.heightPx != null ? String(parent!.constraints!.heightPx) : ''

    initialModel.value = {
        componentKey: currentKey,
        widthValue,
        widthUnit,
        heightValue,
        heightUnit,
        splitCount: 2,

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

    if (initialModel.value.lockWidthCross || initialModel.value.mustBeFluidWidth) initialModel.value.widthValue = ''
    if (initialModel.value.lockHeightCross || initialModel.value.mustBeFluidHeight) initialModel.value.heightValue = ''

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

function normalizeCount(raw: string | number | undefined, fallback: number): number {
    const s = String(raw ?? '').trim()
    if (!s) return fallback
    const n = parseInt(s, 10)
    if (!Number.isFinite(n) || n < 2) return fallback
    return n
}

function splitRowFromModal(count?: number | string) {
    const id = modalTargetId.value
    if (!id) return
    const c = normalizeCount(count as any, 2)
    splitLeafN(id, 'row', c)
    closeModal()
}
function splitColFromModal(count?: number | string) {
    const id = modalTargetId.value
    if (!id) return
    const c = normalizeCount(count as any, 2)
    splitLeafN(id, 'col', c)
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
        typeof model.bgHex === 'string' && /^#[0-9a-fA-F]{6}$/.test(model.bgHex) ? model.bgHex : '#ffffff'
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
            parent.constraints = { widthPx: cWidthPx, heightPx: cHeightPx, widthPct: null, heightPct: null }
        }
    }

    closeModal()
}

/** Ref-safe handler for selectedProfileId updates */
function onUpdateSelectedProfileId(val: any) {
    selectedProfileId.value = String(val ?? '')
}

/** Bootstrap: URL + local storage hydration */
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

/** Debounced local persistence (prevents jank during resize drags) */
let persistTimer: number | null = null
function schedulePersistLayout() {
    try {
        if (persistTimer != null) window.clearTimeout(persistTimer)
        persistTimer = window.setTimeout(() => {
            persistTimer = null
            try {
                localStorage.setItem(LAYOUT_LS, JSON.stringify(root))
            } catch {}
        }, 200)
    } catch {}
}
function flushPersistLayout() {
    try {
        if (persistTimer != null) {
            window.clearTimeout(persistTimer)
            persistTimer = null
        }
        localStorage.setItem(LAYOUT_LS, JSON.stringify(root))
    } catch {}
}

watch(
    () => root,
    () => schedulePersistLayout(),
    { deep: true }
)

/** -------------------------------
 *  Gutter resizing (pointer drag)
 *  -------------------------------
 */
type ResizeState = {
    splitId: string
    gutterIndex: number
    direction: Direction
    pointerId: number
    startClient: number
    startA: number
    startB: number
    total: number
    wSum: number
}
const resizeState = ref<ResizeState | null>(null)

let rafId = 0
let pendingMove: PointerEvent | null = null
let priorBodyCursor: string | null = null
let priorBodyUserSelect: string | null = null

function teardownResizeListeners() {
    try {
        window.removeEventListener('pointermove', onWindowPointerMove)
        window.removeEventListener('pointerup', onWindowPointerUp)
        window.removeEventListener('pointercancel', onWindowPointerUp)
    } catch {}

    if (rafId) {
        try {
            window.cancelAnimationFrame(rafId)
        } catch {}
        rafId = 0
    }
    pendingMove = null

    try {
        if (priorBodyCursor != null) document.body.style.cursor = priorBodyCursor
        else document.body.style.cursor = ''
        if (priorBodyUserSelect != null) document.body.style.userSelect = priorBodyUserSelect
        else document.body.style.userSelect = ''
    } catch {}
    priorBodyCursor = null
    priorBodyUserSelect = null
}

function endResize() {
    if (!resizeState.value) return
    resizeState.value = null
    teardownResizeListeners()
    flushPersistLayout()
}

function applyResizeFromEvent(ev: PointerEvent) {
    const st = resizeState.value
    if (!st) return
    if (ev.pointerId !== st.pointerId) return

    const split = findSplitById(st.splitId)
    if (!split) return

    const kids: LayoutNode[] = Array.isArray(split.children) ? split.children : []
    const i = st.gutterIndex

    const left = kids[i]
    const right = kids[i + 1]
    if (!left || !right) return

    // If something became fixed mid-drag, stop safely
    if (isFixedOnSplitAxis(left, split.direction) || isFixedOnSplitAxis(right, split.direction)) {
        endResize()
        return
    }

    const cur = st.direction === 'row' ? ev.clientX : ev.clientY
    const delta = cur - st.startClient

    const minPx = MIN_RESIZABLE_PANE_PX
    let newA = st.startA + delta
    if (newA < minPx) newA = minPx
    if (newA > st.total - minPx) newA = st.total - minPx

    const ratioA = st.total > 0 ? newA / st.total : 0.5
    const minW = st.total > 0 ? (minPx / st.total) * st.wSum : 0.01

    let newWA = ratioA * st.wSum
    let newWB = st.wSum - newWA

    const clampW = Math.max(0.01, minW)
    if (newWA < clampW) {
        newWA = clampW
        newWB = st.wSum - newWA
    }
    if (newWB < clampW) {
        newWB = clampW
        newWA = st.wSum - newWB
    }

    newWA = Math.round(newWA * 100) / 100
    newWB = Math.round(newWB * 100) / 100

    if (!Array.isArray(split.sizes) || split.sizes.length !== kids.length) {
        ensureSplitSizes(split)
    }

    // These indices are valid because left/right exist
    split.sizes![i] = newWA
    split.sizes![i + 1] = newWB
}

function onWindowPointerMove(ev: PointerEvent) {
    const st = resizeState.value
    if (!st) return
    if (ev.pointerId !== st.pointerId) return

    try {
        ev.preventDefault()
    } catch {}

    pendingMove = ev
    if (rafId) return
    rafId = window.requestAnimationFrame(() => {
        rafId = 0
        const e = pendingMove
        pendingMove = null
        if (e) applyResizeFromEvent(e)
    })
}

function onWindowPointerUp(ev: PointerEvent) {
    const st = resizeState.value
    if (!st) return
    if (ev.pointerId !== st.pointerId) return
    endResize()
}

function startGutterResize(splitId: string, gutterIndex: number, ev: PointerEvent) {
    if (!canEdit.value) return

    const split = findSplitById(splitId)
    if (!split) return

    const kids: LayoutNode[] = Array.isArray(split.children) ? split.children : []
    if (gutterIndex < 0 || gutterIndex >= kids.length - 1) return

    const left = kids[gutterIndex]
    const right = kids[gutterIndex + 1]
    if (!left || !right) return

    // Only allow resizing if BOTH adjacent items are flexible on the split axis
    if (isFixedOnSplitAxis(left, split.direction)) return
    if (isFixedOnSplitAxis(right, split.direction)) return

    const gutterEl = ev.currentTarget as HTMLElement | null
    if (!gutterEl) return
    const prevEl = gutterEl.previousElementSibling as HTMLElement | null
    const nextEl = gutterEl.nextElementSibling as HTMLElement | null
    if (!prevEl || !nextEl) return

    const prevRect = prevEl.getBoundingClientRect()
    const nextRect = nextEl.getBoundingClientRect()
    const startA = split.direction === 'row' ? prevRect.width : prevRect.height
    const startB = split.direction === 'row' ? nextRect.width : nextRect.height
    const total = startA + startB
    if (!(total > 0)) return

    const sizes = ensureSplitSizes(split)
    const wA = sizes[gutterIndex] ?? 0
    const wB = sizes[gutterIndex + 1] ?? 0
    const wSum = wA + wB
    if (!(wSum > 0)) return

    resizeState.value = {
        splitId,
        gutterIndex,
        direction: split.direction,
        pointerId: ev.pointerId,
        startClient: split.direction === 'row' ? ev.clientX : ev.clientY,
        startA,
        startB,
        total,
        wSum
    }

    try {
        gutterEl.setPointerCapture(ev.pointerId)
    } catch {}

    try {
        priorBodyCursor = document.body.style.cursor
        priorBodyUserSelect = document.body.style.userSelect
        document.body.style.cursor = split.direction === 'row' ? 'col-resize' : 'row-resize'
        document.body.style.userSelect = 'none'
    } catch {}

    window.addEventListener('pointermove', onWindowPointerMove, { passive: false })
    window.addEventListener('pointerup', onWindowPointerUp, { passive: true })
    window.addEventListener('pointercancel', onWindowPointerUp, { passive: true })

    try {
        ev.preventDefault()
    } catch {}
}

/** Bootstrap */
onMounted(async () => {
    logs.hydrate()
    startRealtime('/ws')
    await refreshLayouts()
    try {
        window.addEventListener('beforeunload', flushPersistLayout)
    } catch {}
})

onBeforeUnmount(() => {
    try {
        window.removeEventListener('beforeunload', flushPersistLayout)
    } catch {}
    teardownResizeListeners()
    flushPersistLayout()
})

/* -------------------------------
   Contrast + HUD helpers
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
type DimKind = 'px' | 'pct' | 'auto'
function fmtDim(px: number | null | undefined, pct: number | null | undefined): { text: string; kind: DimKind } {
    if (px != null) return { text: `${px}px`, kind: 'px' }
    if (pct != null) return { text: `${pct}%`, kind: 'pct' }
    return { text: 'auto', kind: 'auto' }
}

/* -------------------------------
   Renderers
--------------------------------*/
function bestContrastOnBlackOrWhite(bgHex: string): string {
    const Lbg = relativeLuminance(bgHex)
    const cBlack = contrastRatio(Lbg, 0)
    const cWhite = contrastRatio(1, Lbg)
    return cBlack >= cWhite ? '#111827' : '#ffffff'
}

function renderLeaf(
    leaf: any,
    parentDir: Direction | null,
    isRoot: boolean,
    emit: any,
    canEdit: boolean,
    containerConstraints: Constraints | null,
    flexWeight: number | null = null
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
            style.flex = flexWeight != null && flexWeight > 0 ? `${flexWeight} 1 0%` : '1 1 0%'
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
            style.flex = flexWeight != null && flexWeight > 0 ? `${flexWeight} 1 0%` : '1 1 0%'
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
        style.height = heightPx != null ? `${heightPx}px` : heightPct != null ? `${heightPct}%` : '100%'
        style.flex =
            widthPx != null || widthPct != null || heightPx != null || heightPct != null ? '0 0 auto' : '1 1 0%'
        if (widthPx != null || widthPct != null || heightPx != null || heightPct != null) style.alignSelf = 'center'
    }

    const paneInfo: PaneInfoLocal = {
        id: String(leaf?.id ?? ''),
        isRoot,
        parentDir,
        constraints: { widthPx, heightPx, widthPct, heightPct },
        appearance: { bg: bgHexNormalized, mTop: pTop, mRight: pRight, mBottom: pBottom, mLeft: pLeft },
        container: { constraints: containerConstraints ?? null, direction: parentDir }
    }

    const Comp = leaf?.component ? resolvePane(String(leaf.component)) : null

    const paneName = getPaneLabel(leaf?.component ?? null)
    const wBadge = fmtDim(widthPx, widthPct)
    const hBadge = fmtDim(heightPx, heightPct)
    const ariaText = `${paneName}. Width ${wBadge.text}. Height ${hBadge.text}.`

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
            h('span', { style: { marginLeft: '6px' } }, `W: ${wBadge.text}`),
            h('span', { style: { marginLeft: '6px' } }, `H: ${hBadge.text}`)
        ]
    )

    const gearButton = canEdit
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
        : null

    const menuHotspot = canEdit && h('div', { class: 'pane-menu-hotspot' }, [gearButton, hud])

    const content = h('div', { style, class: 'studio-leaf' }, [
        menuHotspot,
        h('span', { class: 'sr-only', 'aria-live': 'polite' }, ariaText),
        Comp ? h(Comp as any, { pane: paneInfo, ...(leaf?.props ?? {}) }) : h('div', { class: 'empty', style: { color: textColor } }, 'Empty pane')
    ])

    const isRootConstrained =
        isRoot && (widthPx != null || widthPct != null || heightPx != null || heightPct != null)
    if (isRootConstrained) {
        return h('div', { style: { width: '100%', height: '100%', display: 'grid', placeItems: 'center' } }, [content])
    }
    return content
}

function renderSplit(
    split: SplitNode,
    parentDir: Direction | null,
    isRoot: boolean,
    emit: any,
    canEdit: boolean,
    flexWeight: number | null = null
): VNode {
    const kids: LayoutNode[] = Array.isArray(split?.children) ? split.children : []

    const widthPx = split?.constraints?.widthPx ?? null
    const heightPx = split?.constraints?.heightPx ?? null
    const widthPct = split?.constraints?.widthPct ?? null
    const heightPct = split?.constraints?.heightPct ?? null

    const containerStyle: Record<string, string> = {
        display: 'flex',
        flexDirection: split?.direction === 'row' ? 'row' : 'column',
        gap: '0px',
        minWidth: '0',
        minHeight: '0',
        boxSizing: 'border-box'
    }

    function applyWidth() {
        if (widthPx != null) {
            containerStyle.flex = '0 0 auto'
            containerStyle.width = `${widthPx}px`
        } else if (widthPct != null) {
            containerStyle.flex = '0 0 auto'
            containerStyle.width = `${widthPct}%`
        } else {
            containerStyle.flex = flexWeight != null && flexWeight > 0 ? `${flexWeight} 1 0%` : '1 1 0%'
            containerStyle.width = 'auto'
        }
    }
    function applyHeight() {
        if (heightPx != null) {
            containerStyle.flex = '0 0 auto'
            containerStyle.height = `${heightPx}px`
        } else if (heightPct != null) {
            containerStyle.flex = '0 0 auto'
            containerStyle.height = `${heightPct}%`
        } else {
            containerStyle.flex = flexWeight != null && flexWeight > 0 ? `${flexWeight} 1 0%` : '1 1 0%'
            containerStyle.height = 'auto'
        }
    }

    if (parentDir === 'row') {
        containerStyle.height = '100%'
        applyWidth()
    } else if (parentDir === 'col') {
        containerStyle.width = '100%'
        applyHeight()
    } else {
        containerStyle.width = widthPx != null ? `${widthPx}px` : widthPct != null ? `${widthPct}%` : '100%'
        containerStyle.height = heightPx != null ? `${heightPx}px` : heightPct != null ? `${heightPct}%` : '100%'
        containerStyle.flex =
            widthPx != null || widthPct != null || heightPx != null || heightPct != null ? '0 0 auto' : '1 1 0%'
        if (isRoot && (widthPx != null || widthPct != null || heightPx != null || heightPct != null)) {
            containerStyle.alignSelf = 'center'
        }
    }

    const weights = computeSplitWeightsForRender(split)

    const nodes: VNode[] = []
    for (let i = 0; i < kids.length; i++) {
        const child = kids[i]
        if (!child) continue

        const childIsFlexible = !isFixedOnSplitAxis(child, split.direction)
        const w = weights[i] ?? 0
        const childWeight = childIsFlexible && w > 0 ? w : null

        nodes.push(renderNode(child, split.direction, false, emit, canEdit, split?.constraints ?? null, childWeight))

        if (i < kids.length - 1) {
            const nextChild = kids[i + 1]
            if (!nextChild) continue

            const leftFixed = isFixedOnSplitAxis(child, split.direction)
            const rightFixed = isFixedOnSplitAxis(nextChild, split.direction)
            const disabled = !canEdit || leftFixed || rightFixed
            const active = resizeState.value?.splitId === split.id && resizeState.value?.gutterIndex === i

            nodes.push(
                h('div', {
                    class: [
                        'split-gutter',
                        split.direction === 'row' ? 'row' : 'col',
                        disabled ? 'split-gutter--disabled' : '',
                        active ? 'split-gutter--active' : ''
                    ],
                    style: split.direction === 'row' ? { width: `${GUTTER_PX}px` } : { height: `${GUTTER_PX}px` },
                    role: 'separator',
                    'aria-orientation': split.direction === 'row' ? 'vertical' : 'horizontal',
                    'data-split-id': split.id,
                    'data-gutter-index': String(i),
                    onPointerdown: disabled ? undefined : (ev: PointerEvent) => startGutterResize(split.id, i, ev)
                })
            )
        }
    }

    const container: VNode = h('div', { style: containerStyle, class: 'studio-split', 'data-split-id': split.id }, nodes)

    const isRootConstrained =
        isRoot && (widthPx != null || widthPct != null || heightPx != null || heightPct != null)
    if (isRootConstrained) {
        return h('div', { style: { width: '100%', height: '100%', display: 'grid', placeItems: 'center' } }, [container])
    }
    return container
}

function renderNode(
    node: any,
    parentDir: Direction | null,
    isRoot: boolean,
    emit: any,
    canEdit: boolean,
    containerConstraints: Constraints | null,
    flexWeight: number | null = null
): VNode {
    return node?.kind === 'split'
        ? renderSplit(node as SplitNode, parentDir, isRoot, emit, canEdit, flexWeight)
        : renderLeaf(node as LeafNode, parentDir, isRoot, emit, canEdit, containerConstraints, flexWeight)
}

const RenderNode = defineComponent({
    name: 'RenderNode',
    props: {
        node: { type: Object, required: true },
        isRoot: { type: Boolean, default: false },
        parentDir: { type: String as () => Direction | null, default: null },
        canEdit: { type: Boolean, required: true }
    },
    emits: ['split', 'configure', 'delete'],
    setup(props, { emit }) {
        return (): VNode => renderNode(props.node, props.parentDir, props.isRoot, emit, props.canEdit, null, null)
    }
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
                @split="splitLeafBinary"
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
            @update:selectedProfileId="onUpdateSelectedProfileId"
            @refreshLayouts="refreshLayouts"
        />
    </div>
</template>

<script lang="ts">
export default { name: 'App' }

/**
 * Exported type for panes to import.
 * Kept out of <script setup> to avoid toolchain parsing errors around `export`.
 */
export type PaneInfo = {
    id: string
    isRoot: boolean
    parentDir: 'row' | 'col' | null
    constraints: {
        widthPx?: number | null
        heightPx?: number | null
        widthPct?: number | null
        heightPct?: number | null
    }
    appearance: {
        bg?: string | null
        mTop?: number | null
        mRight?: number | null
        mBottom?: number | null
        mLeft?: number | null
    }
    container: {
        constraints:
            | {
                  widthPx?: number | null
                  heightPx?: number | null
                  widthPct?: number | null
                  heightPct?: number | null
              }
            | null
        direction: 'row' | 'col' | null
    }
}
</script>

<style>
/* Full dark surround (outside panes) */
html,
body,
#app {
    height: 100%;
    margin: 0;
    overflow: hidden;
    /* background: #000; */
    background: #008080;
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

/* Split containers */
.studio-split {
    min-width: 0;
    min-height: 0;
}

/* Gutter styling (between panes) */
.split-gutter {
    flex: 0 0 auto;
    /* background: rgba(255, 255, 255, 0.06); */
    position: relative;
    z-index: 20;
    touch-action: none; /* important for touch drag */
}
.split-gutter.row {
    cursor: col-resize;
    height: 100%;
}
.split-gutter.col {
    cursor: row-resize;
    width: 100%;
}
.split-gutter:hover {
    /* background: rgba(255, 255, 255, 0.12); */
}
.split-gutter--active {
    /* background: rgba(59, 130, 246, 0.28); */
}
.split-gutter--disabled {
    cursor: default;
    opacity: 0.35;
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

/* Hotspot area for the pane menu (top-left). */
.pane-menu-hotspot {
    position: absolute;
    top: 0;
    left: 0;
    width: 3.2rem;
    height: 2.2rem;
    pointer-events: auto;
    z-index: 30;
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
    z-index: 31;
    font-size: 0.95rem;
    line-height: 1;
}
.cell-gear.tl {
    top: 0.5rem;
    left: 0.5rem;
}

/* Show gear only when hovering the hotspot or focusing the button */
.pane-menu-hotspot:hover .cell-gear,
.cell-gear:focus,
.cell-gear:focus-visible {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
}
.cell-gear:hover {
    transform: translateY(-1px);
}

/* Pane HUD */
.pane-hud {
    position: absolute;
    top: 0.5rem;
    left: 2.4rem;
    padding: 0.2rem 0.5rem;
    border-radius: 8px;
    font-size: 12px;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 0.15s ease;
    z-index: 29;
    white-space: nowrap;
}

/* Show HUD only when hotspot hovered or gear focused */
.pane-menu-hotspot:hover .pane-hud,
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
