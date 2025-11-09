import Fastify, {
    type FastifyInstance,
    type FastifyServerOptions,
    type FastifyRequest,
    type FastifyReply
} from 'fastify'
import cors from '@fastify/cors'
import { WebSocketServer } from 'ws'
import type { WebSocket, RawData } from 'ws'

// ✨ static hosting imports
import fastifyStatic from '@fastify/static'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    createLogger,
    makeClientBuffer,
    LogChannel,
    type ClientLogBuffer,
    type ClientLog
} from '@autobench98/logging'

interface LogsQuery { n?: string }

// ---- Request logging config (env) ----
const REQUEST_VERBOSE =
    String(process.env.REQUEST_VERBOSE ?? 'false').toLowerCase() === 'true'
const REQUEST_LOG_HEADERS =
    String(process.env.REQUEST_LOG_HEADERS ?? 'false').toLowerCase() === 'true'
const REQUEST_SAMPLE = Math.max(1, Number(process.env.REQUEST_SAMPLE ?? '1')) // 1 = log every request
// --------------------------------------

const clientBuf: ClientLogBuffer = makeClientBuffer()

let reqCounter = 0

// ✨ resolve path to built SPA (works from dist at runtime)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
// When compiled, this file lives in services/orchestrator/dist/
// We want ../../../apps/web/dist relative to that.
const WEB_DIST = path.resolve(__dirname, '../../../apps/web/dist')

// ---- Minimal in-memory app state for snapshot/patch demo ----
type AppState = {
    layout: { rows: number; cols: number }
    message: string
}
let stateVersion = 1
let appState: AppState = {
    layout: { rows: 1, cols: 1 },
    message: 'Hello from orchestrator'
}

export function buildApp(opts: FastifyServerOptions = {}): FastifyInstance {
    const { channel } = createLogger('orchestrator', clientBuf)
    const logApp = channel(LogChannel.app)
    const logWs = channel(LogChannel.websocket)
    const logReq = channel(LogChannel.request)

    // Track request start times by Fastify request id
    const startedAt = new Map<string, number>()
    // Track which requests we decided to log (to keep response logging consistent with sampling)
    const sampledIds = new Set<string>()

    // disable Fastify's own logger to avoid INFO/USERLVL lines
    const app = Fastify({ logger: false, ...opts })

    void app.register(cors, { origin: true })

    // ---------- Request/Response logging hooks ----------
    app.addHook('onRequest', async (req: FastifyRequest) => {
        // sampling gate
        const shouldLog = (++reqCounter % REQUEST_SAMPLE) === 0
        if (!shouldLog) return

        sampledIds.add(req.id)
        startedAt.set(req.id, Date.now())

        // compact one-liner
        logReq.info(`${req.method} ${req.url}`)

        // optional detail block
        if (REQUEST_VERBOSE) {
            const detail: Record<string, unknown> = {
                id: req.id,
                ip: req.ip
            }
            if (REQUEST_LOG_HEADERS) {
                // minimal, safe subset (avoid cookies/auth)
                const { host, 'user-agent': ua, accept, referer } =
                    req.headers as Record<string, unknown>
                detail.headers = { host, 'user-agent': ua, accept, referer }
            }
            logReq.debug('request detail', detail)
        }
    })

    app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
        // only log responses that were sampled on request
        if (!sampledIds.has(req.id)) return
        sampledIds.delete(req.id)

        const start = startedAt.get(req.id)
        if (start !== undefined) startedAt.delete(req.id)
        const ms = start !== undefined ? (Date.now() - start) : undefined

        // compact summary
        logReq.info(
            `${req.method} ${req.url} → ${reply.statusCode}${ms !== undefined ? ` (${ms} ms)` : ''}`
        )

        // optional detail
        if (REQUEST_VERBOSE) {
            const outLen = reply.getHeader('content-length') ?? null
            logReq.debug('response detail', {
                id: req.id,
                bytesOut: outLen,
                ms
            })
        }
    })
    // ---------------------------------------------------

    app.get('/health', async () => ({ status: 'ok' }))
    app.get('/ready', async () => ({ ready: true }))

    app.get('/', async () => ({ ok: true, service: 'autobench98-orchestrator' }))
    app.get('/version', async () => ({ name: 'autobench98-orchestrator', version: '0.1.0' }))

    // 🚧 Avoid confusing 404 on plain HTTP GET /ws (not an upgrade)
    app.get('/ws', async (_req, reply) => {
        reply.code(426).send({ error: 'Upgrade Required: websocket' })
    })

    // ---- WebSocket server: handle upgrade at /ws using 'ws' directly ----
    const wss = new WebSocketServer({ noServer: true })

    wss.on('connection', (socket: WebSocket) => {
        try {
            socket.send(JSON.stringify({
                type: 'welcome',
                serverTime: new Date().toISOString()
            }))
            logWs.info('client connected')
        } catch (e) {
            logWs.error('failed to send welcome', { err: (e as Error).message })
        }

        socket.on('message', (data: RawData) => {
            try {
                const text = typeof data === 'string' ? data : data.toString()
                const msg = JSON.parse(text)

                if (msg?.type === 'hello') {
                    socket.send(JSON.stringify({ type: 'ack', ok: true }))
                    return
                }

                if (msg?.type === 'subscribe') {
                    const includeSnapshot = !!msg?.payload?.includeSnapshot
                    if (includeSnapshot) {
                        socket.send(JSON.stringify({
                            type: 'state.snapshot',
                            stateVersion,
                            data: appState
                        }))
                    }
                    return
                }

                // TODO: other message types (patch, layout.save, etc.)
            } catch {
                // ignore malformed payloads
            }
        })
    })

    // Only accept proper websocket upgrades to /ws
    app.server.on('upgrade', (req, socket, head) => {
        const upgrade = (req.headers.upgrade || '').toLowerCase()
        if (upgrade !== 'websocket') return

        // Node gives us a path with optional query — keep it simple
        const url = req.url || '/'
        const pathOnly = url.split('?', 1)[0]
        if (pathOnly !== '/ws') return

        wss.handleUpgrade(req, socket as any, head, (ws) => {
            wss.emit('connection', ws, req)
        })
    })
    // -----------------------------------------------------------------------

    // Serve SPA from /studio/
    void app.register(fastifyStatic, {
        root: WEB_DIST,
        prefix: '/studio/',
        index: ['index.html']
    })

    // Redirect /studio → /studio/
    app.get('/studio', async (_req, reply) => {
        reply.status(301)
        reply.redirect('/studio/')
    })

    // History API fallback for client-side routing under /studio/*
    app.setNotFoundHandler((req, reply) => {
        const url = req.raw.url ?? ''
        if (url.startsWith('/studio/')) {
            return reply.sendFile('index.html')
        }
        reply.status(404).send({ error: 'Not found' })
    })

    logApp.info('orchestrator app built')
    return app
}