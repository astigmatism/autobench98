import Fastify, {
    type FastifyInstance,
    type FastifyServerOptions,
    type FastifyRequest,
    type FastifyReply
} from 'fastify'
import cors from '@fastify/cors'
import fastifyMultipart from '@fastify/multipart'

// ✨ static hosting imports
import fastifyStatic from '@fastify/static'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    createLogger,
    makeClientBuffer,
    LogChannel,
    type ClientLogBuffer,
    type ClientLog,
    type ClientLogLevel,
    type ChannelColor
} from '@autobench98/logging'

// our state/helpers
import wsPlugin from './plugins/ws.js'
import { setMessage, setLayout } from './core/state.js'
import layoutsRoutes from './routes/layouts.js'
import serialPlugin, { type DeviceStatusSummary } from './plugins/serial.js'
import powerMeterPlugin from './plugins/powerMeter.js'
import serialPrinterPlugin from './plugins/serialPrinter.js'
import atlonaControllerPlugin from './plugins/atlonaController.js' // 🔹 NEW

declare module 'fastify' {
    interface FastifyInstance {
        clientBuf: ClientLogBuffer
        getDeviceStatus?: () => DeviceStatusSummary
    }
}

interface LogsQuery {
    n?: string
}

// ---- Request logging config (env) ----
const REQUEST_VERBOSE = String(process.env.REQUEST_VERBOSE ?? 'false').toLowerCase() === 'true'
const REQUEST_LOG_HEADERS =
    String(process.env.REQUEST_LOG_HEADERS ?? 'false').toLowerCase() === 'true'
const REQUEST_SAMPLE = Math.max(1, Number(process.env.REQUEST_SAMPLE ?? '1'))
const WS_DEBUG = String(process.env.WS_DEBUG ?? 'false').toLowerCase() === 'true'
// --------------------------------------

// ---- Log ingest config (env) ----
const INGEST_TOKEN = (process.env.LOG_INGEST_TOKEN ?? '').trim()
const INGEST_ALLOWED = String(
    process.env.LOG_INGEST_ALLOWED_CHANNELS ?? 'sidecar,ffmpeg,device,ocr,stream,benchmark'
)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
// ---------------------------------

const clientBuf: ClientLogBuffer = makeClientBuffer()
let reqCounter = 0

// ✨ resolve path to built SPA (works from dist at runtime)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const WEB_DIST = path.resolve(__dirname, '../../../apps/web/dist')

export function buildApp(opts: FastifyServerOptions = {}): FastifyInstance {
    const { channel } = createLogger('orchestrator', clientBuf)
    const logApp = channel(LogChannel.app)
    const logReq = channel(LogChannel.request)

    const startedAt = new Map<string, number>()
    const sampledIds = new Set<string>()

    const app = Fastify({ logger: false, ...opts })
    app.decorate('clientBuf', clientBuf)

    // CORS
    void app.register(cors, { origin: true })

    // File uploads for /api/layouts/import
    void app.register(fastifyMultipart, {
        attachFieldsToBody: true,
        limits: { files: 1, fileSize: 2 * 1024 * 1024 }
    })

    // WebSocket + layouts routes
    void app.register(wsPlugin)
    void app.register(layoutsRoutes)

    // 🔹 Atlona controller plugin (creates app.atlonaController and state fanout)
    void app.register(atlonaControllerPlugin)

    // Serial discovery plugin
    void app.register(serialPlugin, {
        logPrefix: 'serial'
    })

    // Power meter + serial printer
    void app.register(powerMeterPlugin)
    void app.register(serialPrinterPlugin)

    // ---------- Request/Response logging hooks ----------
    app.addHook('onRequest', async (req: FastifyRequest) => {
        if (WS_DEBUG && req.url === '/ws') {
            const headers = req.headers as Record<string, unknown>
            const upgrade = headers['upgrade']
            const connection = headers['connection']
            const ua = (headers['user-agent'] as string) ?? ''
            logReq.info('WS debug /ws headers', { upgrade, connection, ua })
        }

        const shouldLog = ++reqCounter % REQUEST_SAMPLE === 0
        if (!shouldLog) return

        sampledIds.add(req.id)
        startedAt.set(req.id, Date.now())
        logReq.info(`${req.method} ${req.url}`)

        if (REQUEST_VERBOSE) {
            const detail: Record<string, unknown> = { id: req.id, ip: req.ip }
            if (REQUEST_LOG_HEADERS) {
                const { host, 'user-agent': ua, accept, referer } = req.headers as Record<string, unknown>
                detail.headers = { host, 'user-agent': ua, accept, referer }
            }
            logReq.debug('request detail', detail)
        }
    })

    app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
        if (!sampledIds.has(req.id)) return
        sampledIds.delete(req.id)

        const start = startedAt.get(req.id)
        if (start !== undefined) startedAt.delete(req.id)
        const ms = start !== undefined ? Date.now() - start : undefined

        logReq.info(`${req.method} ${req.url} → ${reply.statusCode}${ms !== undefined ? ` (${ms} ms)` : ''}`)

        if (REQUEST_VERBOSE) {
            const outLen = reply.getHeader('content-length') ?? null
            logReq.debug('response detail', { id: req.id, bytesOut: outLen, ms })
        }
    })
    // ---------------------------------------------------

    // -----------------------------
    // Log ingestion (PNO/sidecar)  |
    // -----------------------------
    const LEVEL_STYLE: Record<ClientLogLevel, { emoji: string; color: ChannelColor }> = {
        debug: { emoji: '🐛', color: 'green' },
        info:  { emoji: 'ℹ️', color: 'cyan' },
        warn:  { emoji: '⚠️', color: 'yellow' },
        error: { emoji: '❌', color: 'red' },
        fatal: { emoji: '💥', color: 'purple' }
    }

    function normalizeEntry(input: any): ClientLog | null {
        if (!input || typeof input.message !== 'string' || input.message.length === 0) return null

        const ts = typeof input.ts === 'number' ? input.ts : Date.now()
        const level = String(input.level ?? 'info').toLowerCase() as any
        const style = LEVEL_STYLE[level as ClientLogLevel] ?? LEVEL_STYLE.info

        const rawChannel = String(input.channel ?? 'sidecar')
        const channel = INGEST_ALLOWED.includes(rawChannel) ? rawChannel : 'sidecar'

        const emoji = typeof input.emoji === 'string' && input.emoji.length ? input.emoji : style.emoji
        const color = (typeof input.color === 'string' ? input.color : style.color) as ChannelColor
        const message = input.message

        return { ts, channel: channel as any, emoji, color, level, message } as ClientLog
    }

    app.post('/api/logs/ingest', async (req, reply) => {
        if (INGEST_TOKEN) {
            const auth = String((req.headers?.authorization ?? '')).trim()
            const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
            if (token !== INGEST_TOKEN) {
                reply.code(401)
                return { ok: false, error: 'unauthorized' }
            }
        }

        try {
            const body = (req.body ?? {}) as any
            const rawEntries = Array.isArray(body) ? body
                : Array.isArray(body.entries) ? body.entries
                : [body]

            let accepted = 0
            for (const raw of rawEntries) {
                const e = normalizeEntry(raw)
                if (!e) continue
                clientBuf.push(e)
                accepted++
            }
            return { ok: true, accepted }
        } catch (err) {
            reply.code(400)
            return { ok: false, error: (err as Error).message }
        }
    })
    // -----------------------------

    // Health / ready
    app.get('/health', async () => ({ status: 'ok' }))

    app.get('/ready', async () => {
        const statusFn = app.getDeviceStatus
        if (!statusFn) {
            // If the plugin isn't loaded for some reason, surface "ready"
            // so this doesn't become a hard dependency.
            return { ready: true }
        }
        const status = statusFn()
        return {
            ready: status.ready,
            missing: status.missing,
            byStatus: status.byStatus,
            devices: status.devices.map(d => ({
                id: d.id,
                kind: d.kind,
                path: d.path,
                status: d.status,
                vid: d.vid,
                pid: d.pid,
                baudRate: d.baudRate,
                idToken: d.idToken,
            }))
        }
    })

    app.get('/', async (_req, reply) => { reply.status(301); reply.redirect('/studio/') })
    app.get('/version', async () => ({ name: 'autobench98-orchestrator', version: '0.1.0' }))

    app.post('/api/state/message', async (req, reply) => {
        try {
            const body = (req.body ?? {}) as { message?: string }
            if (typeof body.message === 'string') { setMessage(body.message); return { ok: true } }
            reply.code(400); return { ok: false, error: 'message (string) required' }
        } catch (err) {
            reply.code(500); return { ok: false, error: (err as Error).message }
        }
    })

    app.post('/api/state/layout', async (req, reply) => {
        try {
            const b = (req.body ?? {}) as { rows?: number; cols?: number }
            if (typeof b.rows === 'number' && typeof b.cols === 'number') { setLayout(b.rows, b.cols); return { ok: true } }
            reply.code(400); return { ok: false, error: 'rows (number) and cols (number) required' }
        } catch (err) {
            reply.code(500); return { ok: false, error: (err as Error).message }
        }
    })

    // Static last so SPA handles /studio/* deep links
    void app.register(fastifyStatic, { root: WEB_DIST, prefix: '/studio/', index: ['index.html'] })
    app.get('/studio', async (_req, reply) => { reply.status(301); reply.redirect('/studio/') })
    app.setNotFoundHandler((req, reply) => {
        const url = req.raw.url ?? ''
        if (url.startsWith('/studio/')) return reply.sendFile('index.html')
        reply.status(404).send({ error: 'Not found' })
    })

    logApp.info('orchestrator app built')
    return app
}