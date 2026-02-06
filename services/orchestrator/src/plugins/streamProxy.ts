import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { request } from 'undici'

import {
    createLogger,
    LogChannel,
    type ClientLogBuffer,
} from '@autobench98/logging'

declare module 'fastify' {
    interface FastifyInstance {
        clientBuf: ClientLogBuffer
    }
}

/**
 * Sidecar proxy plugin
 *
 * Exposes *internal-only* sidecar endpoints through the orchestrator API, so
 * the browser never talks to the sidecar directly.
 *
 * Current surface:
 *   GET /api/sidecar/stream  →  GET http://127.0.0.1:SIDECAR_PORT/stream
 *   GET /api/sidecar/health  →  GET http://127.0.0.1:SIDECAR_PORT/health
 *
 * NOTE: Query params are forwarded for /stream (e.g. ?maxFps=15).
 *
 * Sidecar is expected to bind to 0.0.0.0 or 127.0.0.1 on SIDECAR_PORT. We
 * always talk to it via 127.0.0.1 here, so the sidecar port does not need
 * to be exposed externally.
 */
const sidecarProxyPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    const { channel } = createLogger('sidecar-proxy', app.clientBuf)
    const log = channel(LogChannel.app)

    const rawPort = process.env.SIDECAR_PORT
    const port = Number.isFinite(Number(rawPort)) ? Number(rawPort) : 3100
    const baseUrl = `http://127.0.0.1:${port}`

    log.info(`sidecar proxy configured baseUrl=${baseUrl}`)

    /**
     * MJPEG stream proxy.
     *
     * We stream the sidecar response body directly back to the client,
     * preserving status and most headers.
     *
     * Query params are forwarded (e.g. /api/sidecar/stream?maxFps=15).
     */
    app.get('/api/sidecar/stream', async (req, reply) => {
        // Forward query string safely (Fastify raw url includes it).
        let search = ''
        try {
            const u = new URL(req.raw.url ?? '/api/sidecar/stream', 'http://localhost')
            search = u.search || ''
        } catch {
            search = ''
        }

        const target = `${baseUrl}/stream${search}`

        // Abort upstream request if client disconnects.
        const ac = new AbortController()
        const abort = () => {
            try {
                ac.abort()
            } catch {
                // ignore
            }
        }

        // req.raw is IncomingMessage; reply.raw is ServerResponse.
        try {
            req.raw.on('aborted', abort)
            req.raw.on('close', abort)
            reply.raw.on('close', abort)
            reply.raw.on('error', abort as any)
        } catch {
            // ignore
        }

        try {
            const { statusCode, headers, body } = await request(target, {
                method: 'GET',
                signal: ac.signal,
            })

            // Pass through content-type and other safe headers.
            // We omit hop-by-hop headers (transfer-encoding, connection, etc.).
            for (const [name, value] of Object.entries(headers)) {
                if (!value) continue
                const lower = name.toLowerCase()
                if (lower === 'connection' || lower === 'transfer-encoding') continue
                reply.header(name, value as any)
            }

            reply.status(statusCode)

            // body is a Node Readable stream; Fastify can send it directly.
            // This keeps the MJPEG stream live.
            return reply.send(body)
        } catch (err) {
            const msg = (err as Error).message ?? String(err)
            log.warn('error proxying sidecar stream', { error: msg })

            reply.status(502)
            return {
                ok: false,
                error: 'sidecar stream unavailable',
            }
        }
    })

    /**
     * Health proxy.
     *
     * Used by StreamPane advanced panel to show sidecar uptime and capture metrics.
     */
    app.get('/api/sidecar/health', async (_req, reply) => {
        const target = `${baseUrl}/health`

        try {
            const { statusCode, body } = await request(target, {
                method: 'GET',
                headers: {
                    accept: 'application/json',
                },
            })

            // Non-2xx from sidecar: surface as error to the client.
            if (statusCode < 200 || statusCode >= 300) {
                const text = await body.text().catch(() => '')
                log.warn('sidecar health returned non-2xx', {
                    statusCode,
                    bodyPreview: text.slice(0, 200),
                })

                reply.status(statusCode)
                return {
                    ok: false,
                    error: `sidecar health returned HTTP ${statusCode}`,
                }
            }

            // Parse JSON payload and forward it as-is.
            let json: unknown
            try {
                // undici body.json() is available, but be defensive in case of text.
                json = await body.json()
            } catch {
                const text = await body.text().catch(() => '')
                log.warn('failed to parse sidecar health JSON', {
                    bodyPreview: text.slice(0, 200),
                })
                reply.status(502)
                return {
                    ok: false,
                    error: 'invalid sidecar health payload',
                }
            }

            reply
                .status(200)
                .header('content-type', 'application/json; charset=utf-8')

            return json
        } catch (err) {
            const msg = (err as Error).message ?? String(err)
            log.warn('error proxying sidecar health', { error: msg })

            reply.status(502)
            return {
                ok: false,
                error: 'sidecar health unavailable',
            }
        }
    })
}

export default fp(sidecarProxyPlugin, {
    name: 'sidecar-proxy-plugin',
})
