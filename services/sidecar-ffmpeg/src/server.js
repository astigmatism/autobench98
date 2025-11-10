// apps/sidecar/src/server.js
import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { createLogger, LogChannel } from '@autobench98/logging'

// --- Orchestrator ingest config (env) ---
// ORCH_INGEST_URL: full URL to orchestrator's /api/logs/ingest (e.g., http://orchestrator:3000/api/logs/ingest)
// ORCH_INGEST_TOKEN: bearer token; must match orchestrator LOG_INGEST_TOKEN (empty = no auth)
const ORCH_INGEST_URL = process.env.ORCH_INGEST_URL || 'http://orchestrator:3000/api/logs/ingest'
const ORCH_INGEST_TOKEN = process.env.ORCH_INGEST_TOKEN || process.env.LOG_INGEST_TOKEN || ''

// Node 18+ has global fetch; if not, import('node-fetch') here.
async function forwardLog(level, message) {
    try {
        const headers = { 'Content-Type': 'application/json' }
        if (ORCH_INGEST_TOKEN) headers['Authorization'] = `Bearer ${ORCH_INGEST_TOKEN}`
        const body = JSON.stringify({ channel: 'sidecar', level, message })
        await fetch(ORCH_INGEST_URL, { method: 'POST', headers, body })
    } catch {
        // swallow network errors; sidecar should never crash on forward failure
    }
}

function makeEmitter(channelLogger) {
    return {
        debug: (msg) => { channelLogger.debug(msg); void forwardLog('debug', msg) },
        info:  (msg) => { channelLogger.info(msg);  void forwardLog('info',  msg) },
        warn:  (msg) => { channelLogger.warn(msg);  void forwardLog('warn',  msg) },
        error: (msg) => { channelLogger.error(msg); void forwardLog('error', msg) },
        fatal: (msg) => { channelLogger.fatal(msg); void forwardLog('fatal', msg) }
    }
}

const { channel } = createLogger('sidecar')
const logApp = channel(LogChannel.app)
const logSidecar = channel(LogChannel.sidecar)
const emit = makeEmitter(logSidecar)

const app = Fastify({ logger: false })
await app.register(cors, { origin: true })
await app.register(websocket)

app.get('/health', async () => ({ status: 'ok' }))
app.get('/ready', async () => ({ ready: true }))
app.get('/', async () => ({ ok: true, service: 'autobench98-sidecar-ffmpeg' }))

const PORT = Number(process.env.SIDECAR_PORT ?? 3100)
const HOST = process.env.SIDECAR_HOST ?? '0.0.0.0'

logApp.info('sidecar app built')
emit.info('sidecar app built') // forward to orchestrator

await app.listen({ port: PORT, host: HOST })

logApp.info(`listening on ${HOST}:${PORT}`)
emit.info(`listening on ${HOST}:${PORT}`) // forward to orchestrator