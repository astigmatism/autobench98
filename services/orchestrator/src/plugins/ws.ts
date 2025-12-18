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
} from '../adapters/logs.adapter.js'
import type { AtlonaControllerService } from '../devices/atlona-controller/AtlonaControllerService.js'
import type { CfImagerService } from '../devices/cf-imager/CfImagerService.js'

// ---------------------------
// Log filtering configuration
// ---------------------------
const LEVEL_ORDER: Record<string, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    fatal: 50
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
function normalizeChannelName(ch: unknown): string {
    if (typeof ch === 'number' && Number.isFinite(ch)) {
        const name = (LogChannel as any)?.[ch]
        if (typeof name === 'string' && name.length > 0) {
            return name.trim().toLowerCase()
        }
        return String(ch)
    }
    if (typeof ch === 'string') {
        const s = ch.trim().toLowerCase()
        return s.split(':')[0]
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

    // Helper: handle Atlona commands from a WS message
    async function handleAtlonaCommand(msg: any) {
        // 🔑 IMPORTANT: look up the controller lazily so we don't capture
        // an undefined reference before the plugin decorates the app.
        const atlonaController = (app as unknown as {
            atlonaController?: AtlonaControllerService
        }).atlonaController

        if (!atlonaController) {
            logWs.warn('received atlona.command but controller is not attached')
            return
        }

        const payload = msg?.payload ?? {}
        const kind = payload.kind
        const switchIdRaw = payload.switchId
        const requestedBy =
            typeof payload.requestedBy === 'string'
                ? payload.requestedBy
                : 'ws-client'

        const idNum = Number(switchIdRaw)
        if (idNum !== 1 && idNum !== 2 && idNum !== 3) {
            logWs.warn('atlona.command: invalid switchId', { switchId: switchIdRaw })
            return
        }
        const switchId = idNum as 1 | 2 | 3

        try {
            if (kind === 'hold') {
                await atlonaController.holdSwitch(switchId, requestedBy)
            } else if (kind === 'release') {
                await atlonaController.releaseSwitch(switchId, requestedBy)
            } else {
                logWs.warn('atlona.command: unknown kind', { kind })
            }
        } catch (e) {
            logWs.warn('atlona.command failed', {
                kind,
                switchId,
                err: (e as Error).message
            })
        }
    }

    // Helper: handle CF imager commands from a WS message
    async function handleCfImagerCommand(msg: any) {
        const cfImager = (app as unknown as { cfImager?: CfImagerService }).cfImager

        if (!cfImager) {
            logWs.warn('received cf-imager.command but cfImager service is not attached')
            return
        }

        const payload = msg?.payload ?? {}
        const kind = payload.kind

        if (typeof kind !== 'string') {
            logWs.warn('cf-imager.command: missing kind')
            return
        }

        const nameRaw = payload.name

        if (kind === 'changeDir') {
            const name = typeof nameRaw === 'string' ? nameRaw.trim() : ''
            if (!name) {
                logWs.warn('cf-imager.command changeDir: empty name')
                return
            }

            try {
                const state = cfImager.getState()
                const cwd = state.fs?.cwd ?? '.'

                // Build a relative path from the current cwd plus the entry name.
                // Example: cwd="images", name="foo" -> "images/foo"
                //          cwd="." , name="foo"     -> "foo"
                const base = cwd === '.' ? '' : cwd.replace(/\/+$/, '')
                const relPath = base ? `${base}/${name}` : name

                await cfImager.changeDirectory(relPath)
            } catch (e) {
                logWs.warn('cf-imager.command changeDir failed', {
                    name: nameRaw,
                    err: (e as Error).message
                })
            }
            return
        }

        if (kind === 'changeDirUp') {
            try {
                const state = cfImager.getState()
                const cwd = state.fs?.cwd ?? '.'

                // Root guard: cwd is relative and POSIX-style.
                // Treat ".", "/", and "" as root; no-op in that case.
                if (cwd === '.' || cwd === '/' || cwd === '') {
                    logWs.debug('cf-imager.command changeDirUp: already at root', { cwd })
                    return
                }

                // Compute parent:
                //  - "foo/bar" -> "foo"
                //  - "foo"     -> "."
                //  - defensive trim of trailing slashes.
                const trimmed = cwd.replace(/\/+$/, '')
                const idx = trimmed.lastIndexOf('/')
                const parent = idx <= 0 ? '.' : trimmed.slice(0, idx)

                await cfImager.changeDirectory(parent)
            } catch (e) {
                logWs.warn('cf-imager.command changeDirUp failed', {
                    err: (e as Error).message
                })
            }
            return
        }

        if (kind === 'createFolder') {
            const name = typeof nameRaw === 'string' ? nameRaw.trim() : ''
            if (!name) {
                logWs.warn('cf-imager.command createFolder: empty name')
                return
            }

            try {
                await cfImager.createFolder(name)
            } catch (e) {
                logWs.warn('cf-imager.command createFolder failed', {
                    name: nameRaw,
                    err: (e as Error).message
                })
            }
            return
        }

        if (kind === 'rename') {
            const oldNameRaw = payload.oldName
            const newNameRaw = payload.newName

            const oldName =
                typeof oldNameRaw === 'string' ? oldNameRaw.trim() : ''
            const newName =
                typeof newNameRaw === 'string' ? newNameRaw.trim() : ''

            if (!oldName || !newName) {
                logWs.warn('cf-imager.command rename: missing names', {
                    oldName: oldNameRaw,
                    newName: newNameRaw
                })
                return
            }

            if (oldName === newName) {
                // No-op rename; UI already checks, but guard defensively.
                logWs.debug('cf-imager.command rename: names identical, no-op', {
                    name: oldName
                })
                return
            }

            try {
                const state = cfImager.getState()
                const cwd = state.fs?.cwd ?? '.'

                const base = cwd === '.' ? '' : cwd.replace(/\/+$/, '')

                const fromRel = base ? `${base}/${oldName}` : oldName
                const toRel = base ? `${base}/${newName}` : newName

                await cfImager.renamePath(fromRel, toRel)
            } catch (e) {
                logWs.warn('cf-imager.command rename failed', {
                    oldName: oldNameRaw,
                    newName: newNameRaw,
                    err: (e as Error).message
                })
            }
            return
        }

        if (kind === 'move') {
            const namesRaw = payload.names
            let names: string[] = []

            if (Array.isArray(namesRaw)) {
                names = namesRaw
                    .map((n: unknown) =>
                        typeof n === 'string' ? n.trim() : ''
                    )
                    .filter(Boolean)
            } else if (typeof namesRaw === 'string') {
                const trimmed = namesRaw.trim()
                if (trimmed) names = [trimmed]
            }

            if (names.length === 0) {
                logWs.warn('cf-imager.command move: empty names payload', {
                    names: namesRaw
                })
                return
            }

            const destCwdRaw = payload.destCwd
            const targetDirRaw = payload.targetDir

            try {
                const state = cfImager.getState()
                const cwd = state.fs?.cwd ?? '.'
                const cwdBase = cwd === '.' ? '' : cwd.replace(/\/+$/, '')

                let destDirRel: string

                // Preferred: targetDir (what the pane sends on drag/drop).
                if (typeof targetDirRaw === 'string' && targetDirRaw.trim()) {
                    const targetDir = targetDirRaw.trim()

                    if (targetDir === '..') {
                        // Parent of current cwd
                        if (!cwdBase) {
                            destDirRel = '.'
                        } else {
                            const idx = cwdBase.lastIndexOf('/')
                            destDirRel = idx <= 0 ? '.' : cwdBase.slice(0, idx)
                        }
                    } else if (targetDir === '.') {
                        // Explicit "here"
                        destDirRel = cwdBase || '.'
                    } else {
                        // Child directory under current cwd
                        destDirRel = cwdBase ? `${cwdBase}/${targetDir}` : targetDir
                    }
                } else if (
                    typeof destCwdRaw === 'string' &&
                    destCwdRaw.trim()
                ) {
                    // Legacy contract: caller already computed the destination cwd.
                    destDirRel = destCwdRaw.trim()
                } else {
                    // Fallback: current cwd.
                    destDirRel = cwdBase || '.'
                }

                const base = cwdBase

                for (const name of names) {
                    const fromRel = base ? `${base}/${name}` : name
                    await cfImager.movePath(fromRel, destDirRel)
                }
            } catch (e) {
                logWs.warn('cf-imager.command move failed', {
                    names: namesRaw,
                    destCwd: destCwdRaw,
                    targetDir: targetDirRaw,
                    err: (e as Error).message
                })
            }
            return
        }

        if (kind === 'delete') {
            const namesRaw = payload.names
            const names: string[] = Array.isArray(namesRaw)
                ? namesRaw
                      .map((n: unknown) =>
                          typeof n === 'string' ? n.trim() : ''
                      )
                      .filter(Boolean)
                : []

            if (names.length === 0) {
                logWs.warn('cf-imager.command delete: empty names payload', {
                    names: namesRaw
                })
                return
            }

            try {
                const state = cfImager.getState()
                const cwd = state.fs?.cwd ?? '.'
                const base = cwd === '.' ? '' : cwd.replace(/\/+$/, '')

                for (const name of names) {
                    const rel = base ? `${base}/${name}` : name
                    await cfImager.deletePath(rel)
                }
            } catch (e) {
                logWs.warn('cf-imager.command delete failed', {
                    names: namesRaw,
                    err: (e as Error).message
                })
            }
            return
        }

        if (kind === 'readImage') {
            const cwdRaw = payload.cwd
            const imageNameRaw = payload.imageName

            const cwd =
                typeof cwdRaw === 'string' && cwdRaw.trim()
                    ? cwdRaw.trim()
                    : '.'
            const imageName =
                typeof imageNameRaw === 'string' ? imageNameRaw.trim() : ''

            if (!imageName) {
                logWs.warn('cf-imager.command readImage: empty imageName', {
                    cwd: cwdRaw,
                    imageName: imageNameRaw
                })
                return
            }

            try {
                await cfImager.readDeviceToImage(cwd, imageName)
            } catch (e) {
                logWs.warn('cf-imager.command readImage failed', {
                    cwd: cwdRaw,
                    imageName: imageNameRaw,
                    err: (e as Error).message
                })
            }

            return
        }

        if (kind === 'writeImage') {
            const cwdRaw = payload.cwd
            const fileNameRaw = payload.fileName

            const cwd =
                typeof cwdRaw === 'string' && cwdRaw.trim()
                    ? cwdRaw.trim()
                    : '.'
            const fileName =
                typeof fileNameRaw === 'string' ? fileNameRaw.trim() : ''

            if (!fileName) {
                logWs.warn('cf-imager.command writeImage: empty fileName', {
                    cwd: cwdRaw,
                    fileName: fileNameRaw
                })
                return
            }

            try {
                const state = cfImager.getState()
                const currentCwd = state.fs?.cwd ?? '.'
                const base = currentCwd === '.' ? '' : currentCwd.replace(/\/+$/, '')

                // We want a path relative to CF_IMAGER_ROOT that may include
                // directories. The service will interpret this and append ".img"
                // if necessary.
                const rel = base ? `${base}/${fileName}` : fileName

                await cfImager.writeImageToDevice(rel)
            } catch (e) {
                logWs.warn('cf-imager.command writeImage failed', {
                    cwd: cwdRaw,
                    fileName: fileNameRaw,
                    err: (e as Error).message
                })
            }

            return
        }

        // Unknown / unsupported command kind
        logWs.warn('cf-imager.command: unknown kind', { kind })
    }

    // Handler signature: (socket, request)
    app.get('/ws', { websocket: true }, (socket: WSSocket, _req: FastifyRequest) => {
        sockets.add(socket)

        // Per-socket snapshot ticker: keep the mirror fresh even if patch wiring misbehaves.
        let snapshotTimer: NodeJS.Timeout | null = null

        const startSnapshotTimer = () => {
            if (snapshotTimer) return
            snapshotTimer = setInterval(() => {
                if (socket.readyState !== socket.OPEN) return
                try {
                    const snap = getSnapshot()
                    socket.send(
                        JSON.stringify({
                            type: 'state.snapshot',
                            stateVersion: snap.version,
                            data: snap
                        })
                    )
                } catch (e) {
                    logWs.warn('failed to send periodic snapshot', {
                        err: (e as Error).message
                    })
                }
            }, 1000) // 1s cadence for live-ish power meter updates
        }

        const stopSnapshotTimer = () => {
            if (snapshotTimer) {
                clearInterval(snapshotTimer)
                snapshotTimer = null
            }
        }

        try {
            socket.send(
                JSON.stringify({
                    type: 'welcome',
                    serverTime: new Date().toISOString()
                })
            )

            // Send an immediate state snapshot
            const snap = getSnapshot()
            socket.send(
                JSON.stringify({
                    type: 'state.snapshot',
                    stateVersion: snap.version,
                    data: snap
                })
            )

            // Start periodic snapshots so the client mirror stays updated.
            startSnapshotTimer()

            // Send bounded, filtered log history snapshot
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
                    socket.send(
                        JSON.stringify({
                            type: 'logs.history',
                            entries: filtered
                        })
                    )
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
                        socket.send(
                            JSON.stringify({
                                type: 'state.snapshot',
                                stateVersion: snap2.version,
                                data: snap2
                            })
                        )

                        const n = Number(msg?.payload?.logsHistory ?? 0)
                        if (n > 0) {
                            const raw = getLogHistory(n)
                            const filtered = filterAndTransform(raw)
                            if (filtered.length > 0) {
                                socket.send(
                                    JSON.stringify({
                                        type: 'logs.history',
                                        entries: filtered
                                    })
                                )
                            }
                        }
                    }

                    // Ensure the snapshot timer is running once client subscribes
                    startSnapshotTimer()
                    return
                }

                // --- Atlona front-end commands --------------------------------
                if (msg?.type === 'atlona.command') {
                    void handleAtlonaCommand(msg)
                    return
                }

                // --- CF imager front-end commands -----------------------------
                if (msg?.type === 'cf-imager.command') {
                    void handleCfImagerCommand(msg)
                    return
                }
            } catch {
                // ignore malformed payloads
            }
        })

        socket.on('close', () => {
            sockets.delete(socket)
            stopSnapshotTimer()
            logWs.info('client disconnected')
        })
    })

    // --- Broadcast state changes ---

    // Full snapshots (still kept for future callers that may rely on this)
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
        // Simple debug: does this patch touch powerMeter at all?
        const hasPowerMeter = Array.isArray(evt.patch)
            ? (evt.patch as any[]).some(
                  (op: any) => typeof op?.path === 'string' && op.path.startsWith('/powerMeter')
              )
            : false

        logWs.debug('broadcasting state.patch', {
            from: evt.from,
            to: evt.to,
            hasPowerMeter
        })

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
        try {
            unsubscribeLogs()
        } catch {}
        done()
    })
})
