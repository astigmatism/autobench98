// apps/orchestrator/src/plugins/ws.ts
import fp from 'fastify-plugin'
import websocket from '@fastify/websocket'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { RawData, WebSocket as WSSocket } from 'ws'
import {
    createLogger,
    makeClientBuffer,
    LogChannel,
    type ClientLogBuffer,
    type ClientLog
} from '@autobench98/logging'
import { getSnapshot, stateEvents } from '../core/state.js'
import {
    attachClientBuffer,
    getHistory as getLogHistory,
    onLog as onLogSubscribe
} from '../core/logs.adapter.js'

// ---------------------------
// Log filtering configuration
// ---------------------------
const LEVEL_ORDER: Record<string, number> = {
    debug: 10, info: 20, warn: 30, error: 40, fatal: 50
}

// Build allowlist once from env (single source of truth)
const envAllow = String(process.env.LOG_CHANNEL_ALLOWLIST ?? '').trim()
const CHANNEL_ALLOWLIST = envAllow
    ? new Set(
        envAllow
          .split(',')
          .map(s => s.trim().toLowerCase())
          .filter(Boolean)
          .map(s => s.split(':')[0]) // allow "device:serial" by matching top-level token
      )
    : null // null => no channel filter (allow all channels, subject to level)

const MIN_LEVEL = (process.env.LOG_LEVEL_MIN ?? 'debug').toLowerCase()
const MIN_LEVEL_NUM = LEVEL_ORDER[MIN_LEVEL] ?? LEVEL_ORDER.debug

// Optional redaction
const REDACT_PATTERN = process.env.LOG_REDACT_REGEX
let redacter: ((s: string) => string) | null = null
if (REDACT_PATTERN) {
    try {
        const re = new RegExp(REDACT_PATTERN, 'g')
        redacter = (s: string) => s.replace(re, '██')
    } catch {
        redacter = null
    }
}

// 💓 heartbeat logging toggle
const HB_LOG = String(process.env.WS_HEARTBEAT_LOG ?? 'false').toLowerCase() === 'true'

// Normalize any incoming channel (enum number or string) to a lowercased name.
// For numeric enums, rely on TypeScript's reverse mapping emitted in JS.
function normalizeChannelName(ch: unknown): string {
    if (typeof ch === 'number' && Number.isFinite(ch)) {
        const name = (LogChannel as any)?.[ch]
        if (typeof name === 'string' && name.length > 0) {
            return name.trim().toLowerCase()
        }
        return String(ch) // fallback, unlikely to match allowlist but safe
    }
    if (typeof ch === 'string') {
        const s = ch.trim().toLowerCase()
        return s.split(':')[0] // top-level before any colon
    }
    return String(ch ?? '').trim().toLowerCase()
}

function allowLog(e: ClientLog): boolean {
    if (CHANNEL_ALLOWLIST) {
        const norm = normalizeChannelName((e as any).channel)
        if (!CHANNEL_ALLOWLIST.has(norm)) return false
    }
    const lvl = LEVEL_ORDER[e.level] ?? LEVEL_ORDER.debug
    if (lvl < MIN_LEVEL_NUM) return false
    return true
}

function transformLog(e: ClientLog): ClientLog {
    // Always emit the normalized channel name so the client consistently receives strings
    const normalizedChannel = normalizeChannelName((e as any).channel) as any
    const base: ClientLog = { ...e, channel: normalizedChannel }
    if (!redacter || !base.message) return base
    return { ...base, message: redacter(base.message) }
}

function filterAndTransform(entries: ClientLog[]): ClientLog[] {
    if (!entries?.length) return []
    const out: ClientLog[] = []
    for (const e of entries) {
        if (!allowLog(e)) continue
        out.push(transformLog(e))
    }
    return out
}
// ---------------------------

const LOGS_SNAPSHOT_DEFAULT = 200

export default fp(async function wsPlugin(app: FastifyInstance) {
    // 🔁 Reuse shared buffer from app if present; otherwise create a local one.
    const shared = (app as unknown as { clientBuf?: ClientLogBuffer }).clientBuf
    const clientBuf: ClientLogBuffer = shared ?? makeClientBuffer()

    const { channel } = createLogger('orchestrator:ws', clientBuf)
    const logWs = channel(LogChannel.websocket)

    // Make the buffer available to the adapter used by this plugin
    attachClientBuffer(clientBuf)

    await app.register(websocket, {
        options: {
            perMessageDeflate: true,
            clientTracking: true
        }
    })

    const sockets = new Set<WSSocket>()

    // Live logs -> filter/transform -> broadcast
    const unsubscribeLogs = onLogSubscribe((entry: ClientLog) => {
        const filtered = filterAndTransform([entry])
        if (filtered.length === 0) return
        const payload = JSON.stringify({
            type: 'logs.append',
            entries: filtered
        })
        for (const ws of sockets) {
            try {
                if (ws.readyState === ws.OPEN) ws.send(payload)
            } catch {
                // ignore per-socket failures
            }
        }
    })

    // Handler signature: (socket, request)
    app.get('/ws', { websocket: true }, (socket: WSSocket, _req: FastifyRequest) => {
        sockets.add(socket)

        try {
            socket.send(JSON.stringify({
                type: 'welcome',
                serverTime: new Date().toISOString()
            }))

            // Send an immediate state snapshot
            const snap = getSnapshot()
            socket.send(JSON.stringify({
                type: 'state.snapshot',
                stateVersion: snap.version,
                data: snap
            }))

            // Send bounded, filtered log history snapshot
            // Prefer server-driven count; fall back to env/default
            const snapshotCount = Math.max(
                0,
                Number(
                    snap?.serverConfig?.logs?.snapshot ??
                    process.env.CLIENT_LOGS_SNAPSHOT ??
                    LOGS_SNAPSHOT_DEFAULT
                )
            )

            if (snapshotCount > 0) {
                const raw = getLogHistory(snapshotCount)
                const filtered = filterAndTransform(raw)
                if (filtered.length > 0) {
                    socket.send(JSON.stringify({
                        type: 'logs.history',
                        entries: filtered
                    }))
                }
            }

            logWs.info('client connected')
        } catch (e) {
            logWs.error('failed to send initial frames', { err: (e as Error).message })
        }

        socket.on('message', (data: RawData) => {
            try {
                const text = typeof data === 'string' ? data : data.toString()
                const msg = JSON.parse(text)

                if (msg?.type === 'hello') {
                    socket.send(JSON.stringify({ type: 'ack', ok: true }))
                    return
                }

                // 💓 heartbeat: reply and (optionally) log a heartbeat entry
                if (msg?.type === 'ping') {
                    socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
                    if (HB_LOG) {
                        clientBuf.push({
                            ts: Date.now(),
                            channel: LogChannel.websocket,
                            emoji: '💓',
                            color: 'magenta',
                            level: 'debug',
                            message: 'heartbeat pong sent'
                        })
                    }
                    return
                }

                if (msg?.type === 'subscribe') {
                    const includeSnapshot = !!msg?.payload?.includeSnapshot
                    if (includeSnapshot) {
                        const snap2 = getSnapshot()
                        socket.send(JSON.stringify({
                            type: 'state.snapshot',
                            stateVersion: snap2.version,
                            data: snap2
                        }))

                        // Optional: resend filtered logs history on demand
                        const n = Number(msg?.payload?.logsHistory ?? 0)
                        if (n > 0) {
                            const raw = getLogHistory(n)
                            const filtered = filterAndTransform(raw)
                            if (filtered.length > 0) {
                                socket.send(JSON.stringify({
                                    type: 'logs.history',
                                    entries: filtered
                                }))
                            }
                        }
                    }
                    return
                }
            } catch {
                // ignore malformed payloads
            }
        })

        socket.on('close', () => {
            sockets.delete(socket)
            logWs.info('client disconnected')
        })
    })

    // --- Broadcast state changes ---

    // Full snapshots
    const onSnapshot = (snap: any) => {
        const payload = JSON.stringify({
            type: 'state.snapshot',
            stateVersion: snap.version,
            data: snap
        })
        for (const ws of sockets) {
            try {
                if (ws.readyState === ws.OPEN) {
                    ws.send(payload)
                }
            } catch {
                // ignore per-socket failures
            }
        }
    }

    // Incremental patches
    const onPatch = (evt: { from: number; to: number; patch: unknown[] }) => {
        const payload = JSON.stringify({
            type: 'state.patch',
            fromVersion: evt.from,
            toVersion: evt.to,
            patch: evt.patch
        })
        for (const ws of sockets) {
            try {
                if (ws.readyState === ws.OPEN) {
                    ws.send(payload)
                }
            } catch {
                // ignore per-socket failures
            }
        }
    }

    stateEvents.on('snapshot', onSnapshot)
    stateEvents.on('patch', onPatch)

    app.addHook('onClose', (_app, done) => {
        stateEvents.off('snapshot', onSnapshot)
        stateEvents.off('patch', onPatch)
        for (const ws of sockets) {
            try {
                ws.terminate?.()
            } catch {}
        }
        sockets.clear()
        try { unsubscribeLogs() } catch {}
        done()
    })
})