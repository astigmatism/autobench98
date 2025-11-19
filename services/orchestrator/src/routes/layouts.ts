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

type Profile = {
    id: string
    name: string
    createdAt: string
    updatedAt: string
    layout: LayoutNode
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
        return { defaultId: parsed.defaultId ?? null, items: parsed.items ?? {} }
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
    return isObject(x) && x.kind === 'leaf' && typeof x.id === 'string'
}
function isSplit(x: any): x is SplitNode {
    return (
        isObject(x) &&
        x.kind === 'split' &&
        typeof x.id === 'string' &&
        (x.direction === 'row' || x.direction === 'col') &&
        Array.isArray(x.children)
    )
}
function isLayoutNode(x: any): x is LayoutNode {
    if (!isObject(x)) return false
    if (x.kind === 'leaf') return isLeaf(x)
    if (x.kind === 'split') return isSplit(x) && x.children.every(isLayoutNode)
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
    // keep constraints sane for UI: clamp 0–100 and floor
    return Math.max(0, Math.min(100, Math.floor(n)))
}

function coerceConstraints(c?: any): Constraints | undefined {
    if (!isObject(c)) return undefined
    // Always write either a number or null (never {}), satisfying the type.
    return {
        widthPx: numOrNull((c as any).widthPx),
        heightPx: numOrNull((c as any).heightPx),
        widthPct: pctOrNull((c as any).widthPct),
        heightPct: pctOrNull((c as any).heightPct)
    }
}

function normalizeNode(node: any): LayoutNode {
    if (isLeaf(node)) {
        return {
            ...node,
            constraints: coerceConstraints(node.constraints),
            appearance: isObject(node.appearance) ? node.appearance : undefined
        }
    }
    if (isSplit(node)) {
        return {
            ...node,
            constraints: coerceConstraints(node.constraints),
            children: node.children.map(normalizeNode)
        }
    }
    // If invalid, fall back to a minimal single leaf so we don’t crash the app.
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
    | { name?: string; layout: LayoutNode }
    | Profile

type ImportPayload = ImportInputSingle | StoreShape

function isProfile(x: any): x is Profile {
    return (
        isObject(x) &&
        typeof x.id === 'string' &&
        typeof x.name === 'string' &&
        typeof x.createdAt === 'string' &&
        typeof x.updatedAt === 'string' &&
        isLayoutNode((x as any).layout)
    )
}
function isStoreShape(x: any): x is StoreShape {
    return isObject(x) && isObject((x as any).items)
}

function regenerateProfile(p: Profile | { name?: string; layout: LayoutNode }): Profile {
    if ('createdAt' in p && 'updatedAt' in p && 'name' in p && 'layout' in p) {
        return {
            id: uid(),
            name: (p as any).name,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            layout: normalizeNode((p as any).layout)
        }
    }
    // shape: { name?, layout }
    return {
        id: uid(),
        name: (p as any).name?.trim() || `Imported ${new Date().toLocaleString()}`,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        layout: normalizeNode((p as any).layout)
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
        const items = Object.values(store.items).sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt)
        )
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
        const body = (req.body ?? {}) as { id?: string; name?: string; layout?: LayoutNode }
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
            layout: normalizeNode(body.layout)
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
        const body = (req.body ?? {}) as { name?: string; layout?: LayoutNode }
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
            layout: normalizeNode(body.layout)
        }
        store.items[id] = p
        await writeJson(storeFile, store)
        return { ok: true, profile: p }
    })

    app.put<{ Params: { id: string } }>('/api/layouts/:id', async (req, reply) => {
        const { id } = req.params
        const body = (req.body ?? {}) as { name?: string; layout?: LayoutNode }
        const store = await readJson(storeFile)
        const p = store.items[id]
        if (!p) {
            reply.code(404)
            return { ok: false, error: 'not found' }
        }
        if (typeof body.name === 'string') p.name = body.name.trim() || p.name
        if (body.layout) p.layout = normalizeNode(body.layout)
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
            const incoming = payload.items ?? {}
            for (const key of Object.keys(incoming)) {
                const src = incoming[key]
                if (!isProfile(src) || !isLayoutNode(src.layout)) continue
                const p = regenerateProfile(src)
                store.items[p.id] = p
                created.push(p.id)
            }
            if (payload.defaultId && incoming[payload.defaultId]) {
                const defName = incoming[payload.defaultId].name
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
            const p = regenerateProfile(payload as { name?: string; layout: LayoutNode })
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