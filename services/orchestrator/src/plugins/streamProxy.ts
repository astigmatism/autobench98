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
     */
    app.get('/api/sidecar/stream', async (_req, reply) => {
        const target = `${baseUrl}/stream`

        try {
            const { statusCode, headers, body } = await request(target, {
                method: 'GET',
            })

            // Pass through content-type and other safe headers.
            // We omit hop-by-hop headers (transfer-encoding, connection, etc.).
            for (const [name, value] of Object.entries(headers)) {
                if (!value) continue
                const lower = name.toLowerCase()
                if (lower === 'connection' || lower === 'transfer-encoding') continue
                // undici headers can be string | string[], Fastify is fine with either.
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
}

export default fp(sidecarProxyPlugin, {
    name: 'sidecar-proxy-plugin',
})
