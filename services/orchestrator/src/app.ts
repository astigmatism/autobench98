import Fastify, {
    type FastifyInstance,
    type FastifyServerOptions,
    type FastifyRequest,
    type FastifyReply
} from 'fastify'
import websocket from '@fastify/websocket'
import cors from '@fastify/cors'
import type { WebSocket } from 'ws'
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

export function buildApp(opts: FastifyServerOptions = {}): FastifyInstance {
    const { channel } = createLogger('orchestrator', clientBuf)
    const logApp  = channel(LogChannel.app)
    const logWs   = channel(LogChannel.websocket)
    const logReq  = channel(LogChannel.request)

    // Track request start times by Fastify request id
    const startedAt = new Map<string, number>()
    // Track which requests we decided to log (to keep response logging consistent with sampling)
    const sampledIds = new Set<string>()

    // disable Fastify's own logger to avoid INFO/USERLVL lines
    const app = Fastify({ logger: false, ...opts })

    void app.register(cors, { origin: true })
    void app.register(websocket)

    // ---------- Request/Response logging hooks ----------
    app.addHook('onRequest', async (req: FastifyRequest) => {
        // sampling gate
        const shouldLog = ((++reqCounter % REQUEST_SAMPLE) === 0)
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

    app.get('/ws', { websocket: true }, (socket: WebSocket, _req: FastifyRequest) => {
        socket.send(JSON.stringify({ hello: 'autobench98' }))
        logWs.info('client connected')
    })

    app.get('/logs', async (req) => {
        const q = req.query as LogsQuery
        const n = Number(q?.n ?? 200)
        const items: ClientLog[] = clientBuf.getLatest(Number.isFinite(n) && n > 0 ? n : 200)
        return items
    })

    logApp.info('orchestrator app built')
    return app
}