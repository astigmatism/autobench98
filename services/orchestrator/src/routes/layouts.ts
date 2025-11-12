// services/orchestrator/src/routes/layouts.ts
import type { FastifyPluginAsync } from 'fastify'
import { promises as fs } from 'node:fs'
import path from 'node:path'

type Constraints = {
    widthPx?: number | null
    heightPx?: number | null
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
        // minimal shape guard
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

const layoutsRoutes: FastifyPluginAsync = async (app) => {
    const dataDir = String(process.env.DATA_DIR || '/app/data')
    const storeFile = path.join(dataDir, 'layouts.json')
    await ensureDir(dataDir)

    // GET /api/layouts  -> list
    app.get('/api/layouts', async () => {
        const store = await readJson(storeFile)
        const items = Object.values(store.items).sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt)
        )
        return { ok: true, defaultId: store.defaultId, items }
    })

    // GET /api/layouts/default -> resolve current default profile
    app.get('/api/layouts/default', async (_req, reply) => {
        const store = await readJson(storeFile)
        if (!store.defaultId || !store.items[store.defaultId]) {
            reply.code(404)
            return { ok: false, error: 'no default layout set' }
        }
        return { ok: true, profile: store.items[store.defaultId] }
    })

    // PUT /api/layouts/default  { id?: string, name?: string, layout?: LayoutNode }
    // - If id provided and exists: set as default
    // - If layout provided and id omitted: create a new profile (optionally named) and set as default
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
            layout: body.layout
        }
        store.items[id] = p
        store.defaultId = id
        await writeJson(storeFile, store)
        return { ok: true, defaultId: id, profile: p }
    })

    // GET /api/layouts/:id
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

    // POST /api/layouts  { name?: string, layout: LayoutNode } -> create
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
            layout: body.layout
        }
        store.items[id] = p
        await writeJson(storeFile, store)
        return { ok: true, profile: p }
    })

    // PUT /api/layouts/:id  { name?: string, layout?: LayoutNode } -> update
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
        if (body.layout) p.layout = body.layout
        p.updatedAt = nowIso()
        store.items[id] = p
        await writeJson(storeFile, store)
        return { ok: true, profile: p }
    })

    // DELETE /api/layouts/:id
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
}

export default layoutsRoutes