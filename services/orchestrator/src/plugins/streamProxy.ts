import type {
    FastifyInstance,
    FastifyPluginAsync,
    RouteShorthandOptions,
} from 'fastify'
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
 * NOTE: Query params are forwarded for /stream (e.g. ?maxFps=30).
 */
const sidecarProxyPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    const { channel } = createLogger('sidecar-proxy', app.clientBuf)
    const log = channel(LogChannel.app)

    const rawPort = process.env.SIDECAR_PORT
    const port = Number.isFinite(Number(rawPort)) ? Number(rawPort) : 3100
    const baseUrl = `http://127.0.0.1:${port}`

    // Rate-limit non-2xx health logs (ms)
    const HEALTH_NON_2XX_LOG_INTERVAL_MS = Math.max(
        0,
        Number(process.env.SIDECAR_PROXY_HEALTH_NON_2XX_LOG_INTERVAL_MS ?? '5000')
    )

    let lastHealthNon2xxSig = ''
    let lastHealthNon2xxAt = 0

    log.info(`sidecar proxy configured baseUrl=${baseUrl}`)

    const HOP_BY_HOP = new Set([
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
    ])

    function passThroughHeaders(
        headers: Record<string, string | string[] | undefined>,
        reply: any
    ) {
        for (const [name, value] of Object.entries(headers)) {
            if (value == null) continue
            const lower = name.toLowerCase()
            if (HOP_BY_HOP.has(lower)) continue
            reply.header(name, value as any)
        }
    }

    function compactPreview(input: string, max = 200): string {
        return String(input ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, max)
    }

    function maybeLogHealthNon2xx(statusCode: number, preview: string) {
        const sig = `${statusCode}:${preview}`
        const now = Date.now()

        // If identical message is repeating rapidly, log at most once per interval.
        if (sig === lastHealthNon2xxSig && now - lastHealthNon2xxAt < HEALTH_NON_2XX_LOG_INTERVAL_MS) {
            return
        }

        lastHealthNon2xxSig = sig
        lastHealthNon2xxAt = now

        // One-line log (no structured object dump).
        log.warn(
            // `sidecar health non-2xx statusCode=${statusCode} bodyPreview=${JSON.stringify(preview)}`
            `sidecar health non-2xx statusCode=${statusCode}`
        )
    }

    /**
     * MJPEG stream proxy.
     */
    app.get('/api/sidecar/stream', async (req, reply) => {
        // req.url includes query string
        let search = ''
        try {
            const u = new URL(req.url ?? '/api/sidecar/stream', 'http://localhost')
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

            passThroughHeaders(headers as any, reply)

            // Fastify uses reply.code(), not reply.status()
            reply.code(statusCode)
            return reply.send(body)
        } catch (err) {
            const msg = (err as Error).message ?? String(err)
            log.warn(`error proxying sidecar stream error=${JSON.stringify(msg)}`)

            reply.code(502)
            return reply.send({ ok: false, error: 'sidecar stream unavailable' })
        }
    })

    /**
     * Health proxy.
     *
     * NOTE: Route is marked skipRequestLog so app.ts can skip request logs for it.
     */
    const healthRouteOpts: RouteShorthandOptions = {
        logLevel: 'silent',
        config: { skipRequestLog: true },
    }

    app.get('/api/sidecar/health', healthRouteOpts, async (_req, reply) => {
        const target = `${baseUrl}/health`

        try {
            const { statusCode, headers, body } = await request(target, {
                method: 'GET',
                headers: { accept: 'application/json' },
            })

            passThroughHeaders(headers as any, reply)

            // Read body once, then attempt JSON parse. (Sidecar returns JSON even on 503.)
            const text = await body.text().catch(() => '')
            const preview = compactPreview(text)

            let parsed: unknown = null
            if (text) {
                try {
                    parsed = JSON.parse(text)
                } catch {
                    parsed = null
                }
            }

            if (statusCode < 200 || statusCode >= 300) {
                maybeLogHealthNon2xx(statusCode, preview)

                reply.code(statusCode).header('content-type', 'application/json; charset=utf-8')
                // Forward parsed JSON if available; otherwise provide a small proxy error shape.
                return reply.send(
                    parsed ?? {
                        ok: false,
                        error: `sidecar health returned HTTP ${statusCode}`,
                    }
                )
            }

            reply.code(200).header('content-type', 'application/json; charset=utf-8')
            return reply.send(parsed ?? { ok: false, error: 'invalid sidecar health payload' })
        } catch (err) {
            const msg = (err as Error).message ?? String(err)
            log.warn(`error proxying sidecar health error=${JSON.stringify(msg)}`)

            reply.code(502).header('content-type', 'application/json; charset=utf-8')
            return reply.send({ ok: false, error: 'sidecar health unavailable' })
        }
    })
}

export default fp(sidecarProxyPlugin, {
    name: 'sidecar-proxy-plugin',
})
