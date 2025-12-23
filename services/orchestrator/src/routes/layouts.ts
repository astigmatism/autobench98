// services/orchestrator/src/routes/layouts.ts
import type { FastifyPluginAsync } from 'fastify'
import { promises as fs } from 'node:fs'
import path from 'node:path'

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
    direction: 'row' | 'col'
    children: Array<LayoutNode>
    sizes?: number[]
    constraints?: Constraints
}
type LayoutNode = LeafNode | SplitNode

// ---- NEW: logs UI prefs persisted with profiles ----
export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export type UiStatePersisted = {
    selectedChannels?: string[]
    minLevel?: ClientLogLevel
    autoscroll?: boolean
    searchText?: string
    capacity?: number
    useChannelFilter?: boolean
    sortDir?: 'asc' | 'desc'
}

type Profile = {
    id: string
    name: string
    createdAt: string
    updatedAt: string
    layout: LayoutNode
    logsUiPrefs?: UiStatePersisted
}

type StoreShape = {
    defaultId: string | null
    items: Record<string, Profile>
}

const nowIso = () => new Date().toISOString()
const uid = () => Math.random().toString(36).slice(2, 10)

async function ensureDir(dir: string) {
    await fs.mkdir(dir, { recursive: true })
}

async function readJson(file: string): Promise<StoreShape> {
    try {
        const buf = await fs.readFile(file, 'utf8')
        const parsed = JSON.parse(buf)
        if (!parsed || typeof parsed !== 'object') throw new Error('bad store')
        if (!('items' in parsed)) return { defaultId: null, items: {} }
        return { defaultId: (parsed as any).defaultId ?? null, items: (parsed as any).items ?? {} }
    } catch {
        return { defaultId: null, items: {} }
    }
}

async function writeJson(file: string, data: StoreShape) {
    const tmp = file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, file)
}

/* -------------------------
   Minimal validation helpers
--------------------------*/
function isObject(x: any): x is Record<string, unknown> {
    return x !== null && typeof x === 'object' && !Array.isArray(x)
}
function isLeaf(x: any): x is LeafNode {
    return isObject(x) && (x as any).kind === 'leaf' && typeof (x as any).id === 'string'
}
function isSplit(x: any): x is SplitNode {
    return (
        isObject(x) &&
        (x as any).kind === 'split' &&
        typeof (x as any).id === 'string' &&
        (((x as any).direction === 'row' || (x as any).direction === 'col') as boolean) &&
        Array.isArray((x as any).children)
    )
}
function isLayoutNode(x: any): x is LayoutNode {
    if (!isObject(x)) return false
    if ((x as any).kind === 'leaf') return isLeaf(x)
    if ((x as any).kind === 'split') return isSplit(x) && (x as any).children.every(isLayoutNode)
    return false
}

/* -------------------------
   Safe numeric coercions
--------------------------*/
function numOrNull(v: any): number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
        const n = Number(v)
        return Number.isFinite(n) ? n : null
    }
    return null
}
function pctOrNull(v: any): number | null {
    const n = numOrNull(v)
    if (n == null) return null
    return Math.max(0, Math.min(100, Math.floor(n)))
}

function coerceConstraints(c?: any): Constraints | undefined {
    if (!isObject(c)) return undefined
    return {
        widthPx: numOrNull((c as any).widthPx),
        heightPx: numOrNull((c as any).heightPx),
        widthPct: pctOrNull((c as any).widthPct),
        heightPct: pctOrNull((c as any).heightPct)
    }
}

/* -------------------------
   NEW: logsUiPrefs coercion
--------------------------*/
const VALID_LEVELS: Record<string, ClientLogLevel> = {
    debug: 'debug',
    info: 'info',
    warn: 'warn',
    error: 'error',
    fatal: 'fatal'
}
function asBoolOrUndef(v: any): boolean | undefined {
    return typeof v === 'boolean' ? v : undefined
}
function asStringOrUndef(v: any): string | undefined {
    return typeof v === 'string' ? v : undefined
}
function asPosIntOrUndef(v: any): number | undefined {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
    if (!Number.isFinite(n)) return undefined
    const x = Math.floor(n)
    return x > 0 ? x : undefined
}
function asSortDirOrUndef(v: any): 'asc' | 'desc' | undefined {
    return v === 'asc' || v === 'desc' ? v : undefined
}
function asLevelOrUndef(v: any): ClientLogLevel | undefined {
    if (typeof v !== 'string') return undefined
    return VALID_LEVELS[v] ?? undefined
}
function asStringArrayOrUndef(v: any): string[] | undefined {
    if (!Array.isArray(v)) return undefined
    const cleaned = v.filter((x) => typeof x === 'string').map((s) => s.trim()).filter(Boolean)
    // de-dupe, preserve order
    return Array.from(new Set(cleaned))
}

/**
 * Coerce persisted logs UI prefs into a stable, safe shape.
 * Returns undefined if payload isn't an object (so we don't write junk).
 */
function coerceLogsUiPrefs(p: any): UiStatePersisted | undefined {
    if (!isObject(p)) return undefined
    const out: UiStatePersisted = {}

    const selectedChannels = asStringArrayOrUndef((p as any).selectedChannels)
    if (selectedChannels !== undefined) out.selectedChannels = selectedChannels

    const minLevel = asLevelOrUndef((p as any).minLevel)
    if (minLevel !== undefined) out.minLevel = minLevel

    const autoscroll = asBoolOrUndef((p as any).autoscroll)
    if (autoscroll !== undefined) out.autoscroll = autoscroll

    const searchText = asStringOrUndef((p as any).searchText)
    if (searchText !== undefined) out.searchText = searchText

    const capacity = asPosIntOrUndef((p as any).capacity)
    if (capacity !== undefined) out.capacity = capacity

    const useChannelFilter = asBoolOrUndef((p as any).useChannelFilter)
    if (useChannelFilter !== undefined) out.useChannelFilter = useChannelFilter

    const sortDir = asSortDirOrUndef((p as any).sortDir)
    if (sortDir !== undefined) out.sortDir = sortDir

    // If user sent an empty object, keep it as {}? Prefer undefined to reduce noise.
    return Object.keys(out).length > 0 ? out : undefined
}

function normalizeNode(node: any): LayoutNode {
    if (isLeaf(node)) {
        return {
            ...(node as any),
            constraints: coerceConstraints((node as any).constraints),
            appearance: isObject((node as any).appearance) ? ((node as any).appearance as any) : undefined
        }
    }
    if (isSplit(node)) {
        return {
            ...(node as any),
            constraints: coerceConstraints((node as any).constraints),
            children: (node as any).children.map(normalizeNode)
        }
    }
    return {
        id: uid(),
        kind: 'leaf',
        component: null,
        props: {},
        constraints: { widthPx: null, heightPx: null, widthPct: null, heightPct: null },
        appearance: { bg: null, mTop: 1, mRight: 1, mBottom: 1, mLeft: 1 }
    }
}

/* -------------------------
   Import parsing
--------------------------*/
type ImportMode = 'merge' | 'replace'

type ImportInputSingle =
    | { name?: string; layout: LayoutNode; logsUiPrefs?: UiStatePersisted }
    | Profile

type ImportPayload = ImportInputSingle | StoreShape

function isProfile(x: any): x is Profile {
    return (
        isObject(x) &&
        typeof (x as any).id === 'string' &&
        typeof (x as any).name === 'string' &&
        typeof (x as any).createdAt === 'string' &&
        typeof (x as any).updatedAt === 'string' &&
        isLayoutNode((x as any).layout)
        // logsUiPrefs is optional and coerced later
    )
}
function isStoreShape(x: any): x is StoreShape {
    return isObject(x) && isObject((x as any).items)
}

function regenerateProfile(p: Profile | { name?: string; layout: LayoutNode; logsUiPrefs?: UiStatePersisted }): Profile {
    // Incoming could be a Profile
    if ('createdAt' in p && 'updatedAt' in p && 'name' in p && 'layout' in p) {
        const incomingPrefs = coerceLogsUiPrefs((p as any).logsUiPrefs)
        return {
            id: uid(),
            name: (p as any).name,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            layout: normalizeNode((p as any).layout),
            logsUiPrefs: incomingPrefs
        }
    }
    // shape: { name?, layout, logsUiPrefs? }
    const incomingPrefs = coerceLogsUiPrefs((p as any).logsUiPrefs)
    return {
        id: uid(),
        name: (p as any).name?.trim() || `Imported ${new Date().toLocaleString()}`,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        layout: normalizeNode((p as any).layout),
        logsUiPrefs: incomingPrefs
    }
}

const layoutsRoutes: FastifyPluginAsync = async (app) => {
    const dataDir = String(process.env.DATA_DIR || '/app/data')
    const storeFile = path.join(dataDir, 'layouts.json')
    await ensureDir(dataDir)

    // ----------------------------
    // Existing CRUD + default APIs
    // ----------------------------
    app.get('/api/layouts', async () => {
        const store = await readJson(storeFile)
        const items = Object.values(store.items).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        return { ok: true, defaultId: store.defaultId, items }
    })

    app.get('/api/layouts/default', async (_req, reply) => {
        const store = await readJson(storeFile)
        if (!store.defaultId || !store.items[store.defaultId]) {
            reply.code(404)
            return { ok: false, error: 'no default layout set' }
        }
        return { ok: true, profile: store.items[store.defaultId] }
    })

    app.put('/api/layouts/default', async (req, reply) => {
        const body = (req.body ?? {}) as {
            id?: string
            name?: string
            layout?: LayoutNode
            logsUiPrefs?: UiStatePersisted
        }
        const store = await readJson(storeFile)

        if (body.id) {
            if (!store.items[body.id]) {
                reply.code(404)
                return { ok: false, error: 'profile not found' }
            }
            store.defaultId = body.id
            await writeJson(storeFile, store)
            return { ok: true, defaultId: store.defaultId }
        }

        if (!body.layout) {
            reply.code(400)
            return { ok: false, error: 'id or layout required' }
        }

        const id = uid()
        const p: Profile = {
            id,
            name: body.name?.trim() || 'Default',
            createdAt: nowIso(),
            updatedAt: nowIso(),
            layout: normalizeNode(body.layout),
            logsUiPrefs: coerceLogsUiPrefs((body as any).logsUiPrefs)
        }
        store.items[id] = p
        store.defaultId = id
        await writeJson(storeFile, store)
        return { ok: true, defaultId: id, profile: p }
    })

    app.get<{ Params: { id: string } }>('/api/layouts/:id', async (req, reply) => {
        const { id } = req.params
        const store = await readJson(storeFile)
        const p = store.items[id]
        if (!p) {
            reply.code(404)
            return { ok: false, error: 'not found' }
        }
        return { ok: true, profile: p }
    })

    app.post('/api/layouts', async (req, reply) => {
        const body = (req.body ?? {}) as {
            name?: string
            layout?: LayoutNode
            logsUiPrefs?: UiStatePersisted
        }
        if (!body.layout) {
            reply.code(400)
            return { ok: false, error: 'layout required' }
        }
        const store = await readJson(storeFile)
        const id = uid()
        const p: Profile = {
            id,
            name: body.name?.trim() || `Layout ${new Date().toLocaleString()}`,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            layout: normalizeNode(body.layout),
            logsUiPrefs: coerceLogsUiPrefs((body as any).logsUiPrefs)
        }
        store.items[id] = p
        await writeJson(storeFile, store)
        return { ok: true, profile: p }
    })

    app.put<{ Params: { id: string } }>('/api/layouts/:id', async (req, reply) => {
        const { id } = req.params
        const body = (req.body ?? {}) as {
            name?: string
            layout?: LayoutNode
            logsUiPrefs?: UiStatePersisted
        }
        const store = await readJson(storeFile)
        const p = store.items[id]
        if (!p) {
            reply.code(404)
            return { ok: false, error: 'not found' }
        }
        if (typeof body.name === 'string') p.name = body.name.trim() || p.name
        if (body.layout) p.layout = normalizeNode(body.layout)

        // NEW: update persisted logs prefs if provided
        if ('logsUiPrefs' in (body as any)) {
            p.logsUiPrefs = coerceLogsUiPrefs((body as any).logsUiPrefs)
        }

        p.updatedAt = nowIso()
        store.items[id] = p
        await writeJson(storeFile, store)
        return { ok: true, profile: p }
    })

    app.delete<{ Params: { id: string } }>('/api/layouts/:id', async (req, reply) => {
        const { id } = req.params
        const store = await readJson(storeFile)
        if (!store.items[id]) {
            reply.code(404)
            return { ok: false, error: 'not found' }
        }
        delete store.items[id]
        if (store.defaultId === id) store.defaultId = null
        await writeJson(storeFile, store)
        return { ok: true, defaultId: store.defaultId }
    })

    // ----------------------------
    // New: EXPORT endpoints
    // ----------------------------
    app.get<{ Params: { id: string } }>('/api/layouts/:id/export', async (req, reply) => {
        const { id } = req.params
        const store = await readJson(storeFile)
        const p = store.items[id]
        if (!p) {
            reply.code(404)
            return { ok: false, error: 'not found' }
        }
        const filename = `${p.name.replace(/[^\w.-]+/g, '_') || 'layout'}_${id}.json`
        reply.header('content-type', 'application/json; charset=utf-8')
        reply.header('content-disposition', `attachment; filename="${filename}"`)
        return p
    })

    app.get('/api/layouts/export/all', async (_req, reply) => {
        const store = await readJson(storeFile)
        const filename = `layouts_export_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
        reply.header('content-type', 'application/json; charset=utf-8')
        reply.header('content-disposition', `attachment; filename="${filename}"`)
        return store
    })

    // ----------------------------
    // New: IMPORT endpoint
    // ----------------------------
    app.post('/api/layouts/import', async (req, reply) => {
        const mode: ImportMode =
            (String((req.query as any)?.mode ?? 'merge').toLowerCase() as ImportMode) === 'replace'
                ? 'replace'
                : 'merge'

        let payload: ImportPayload | null = null

        const ct = String(req.headers['content-type'] || '')
        if (ct.includes('multipart/form-data') && (req as any).file) {
            try {
                const part = await (req as any).file()
                if (!part) {
                    reply.code(400)
                    return { ok: false, error: 'multipart missing file field' }
                }
                const buf = await streamToString(part.file)
                payload = JSON.parse(buf)
            } catch (err) {
                reply.code(400)
                return { ok: false, error: `invalid multipart payload: ${(err as Error).message}` }
            }
        } else {
            try {
                payload = (req.body ?? null) as any
                if (!payload) {
                    reply.code(400)
                    return { ok: false, error: 'no payload' }
                }
            } catch (err) {
                reply.code(400)
                return { ok: false, error: `invalid json: ${(err as Error).message}` }
            }
        }

        const store = mode === 'replace' ? { defaultId: null, items: {} } : await readJson(storeFile)
        const created: string[] = []

        if (isStoreShape(payload)) {
            const incoming = (payload as any).items ?? {}
            for (const key of Object.keys(incoming)) {
                const src = incoming[key]
                if (!isProfile(src) || !isLayoutNode((src as any).layout)) continue
                const p = regenerateProfile(src)
                store.items[p.id] = p
                created.push(p.id)
            }
            if ((payload as any).defaultId && incoming[(payload as any).defaultId]) {
                const defName = incoming[(payload as any).defaultId].name
                const match = Object.values(store.items).find((x) => x.name === defName)
                store.defaultId = match ? match.id : store.defaultId ?? null
            } else if (!store.defaultId) {
                const first = Object.values(store.items)[0]
                store.defaultId = first ? first.id : null
            }
        } else if (isProfile(payload)) {
            const p = regenerateProfile(payload)
            store.items[p.id] = p
            created.push(p.id)
            if (!store.defaultId) store.defaultId = p.id
        } else if (isObject(payload) && (payload as any).layout && isLayoutNode((payload as any).layout)) {
            const p = regenerateProfile(payload as any)
            store.items[p.id] = p
            created.push(p.id)
            if (!store.defaultId) store.defaultId = p.id
        } else {
            reply.code(400)
            return { ok: false, error: 'unsupported payload shape' }
        }

        await writeJson(storeFile, store)
        return { ok: true, mode, created, defaultId: store.defaultId }
    })
}

// Helper: stream-to-string for multipart file
async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
}

export default layoutsRoutes
