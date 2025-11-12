import fs from 'node:fs'
import path from 'node:path'
import { config as dotenvConfig } from 'dotenv'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app'
import {
    createLogger,
    LogChannel
} from '@autobench98/logging'

/**
 * Load environment variables with a clear precedence:
 *   1) .env
 *   2) .env.{NODE_ENV}
 *   3) .env.local
 * Later files override earlier ones.
 */
(function loadEnv() {
    const cwd = process.cwd()
    const env = String(process.env.NODE_ENV || 'development')
    const files = [
        path.resolve(cwd, '.env'),
        path.resolve(cwd, `.env.${env}`),
        path.resolve(cwd, '.env.local')
    ]

    for (const file of files) {
        if (fs.existsSync(file)) {
            dotenvConfig({ path: file, override: true })
        }
    }
})()

// ---- helpers for logging serial envs (no coupling to plugin) ----
function parseIntEnv(name: string): number | undefined {
    const v = process.env[name]
    if (v === undefined || v === '') return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
}
function unescapeLineEnding(s: string | undefined): string | undefined {
    if (!s) return undefined
    if (s === '\\n') return '\n'
    if (s === '\\r\\n') return '\r\n'
    return s
}
function summarizeSerialEnv() {
    // Don’t fail if JSON is bad; just report.
    let matchersCount: number | null = null
    let matchersError: string | null = null
    const raw = process.env.SERIAL_MATCHERS_JSON
    if (raw && raw.trim().length > 0) {
        try {
            const arr = JSON.parse(raw)
            matchersCount = Array.isArray(arr) ? arr.length : 0
        } catch (e) {
            matchersError = (e as Error).message
        }
    }

    return {
        defaultBaud: parseIntEnv('SERIAL_DEFAULT_BAUD') ?? 9600,
        identifyRequest: process.env.SERIAL_IDENTIFY_REQUEST ?? 'identify',
        identifyCompletion:
            process.env.SERIAL_IDENTIFY_COMPLETION === ''
                ? '(disabled)'
                : (process.env.SERIAL_IDENTIFY_COMPLETION ?? 'identify_complete'),
        parserDelim: unescapeLineEnding(process.env.SERIAL_PARSER_DELIM) ?? '\\r\\n',
        writeEol: unescapeLineEnding(process.env.SERIAL_WRITE_EOL) ?? '\\n',
        timeoutMs: parseIntEnv('SERIAL_TIMEOUT_MS') ?? 5000,
        retries: parseIntEnv('SERIAL_RETRIES') ?? 3,
        rescanMs: parseIntEnv('SERIAL_RESCAN_MS') ?? null,
        summaryMs: parseIntEnv('SERIAL_SUMMARY_MS') ?? null,
        logPrefix: process.env.SERIAL_LOG_PREFIX ?? 'serial',
        matchersSource: raw ? 'env(JSON)' : 'code(default)',
        matchersCount,
        matchersError
    }
}

async function start() {
    const { channel } = createLogger('orchestrator')
    const logOrch = channel(LogChannel.orchestrator)

    const PORT = Number(process.env.API_PORT ?? 3000)
    const HOST = process.env.API_HOST ?? '0.0.0.0'

    let app: FastifyInstance | null = null

    try {
        app = buildApp()
        await app.listen({ port: PORT, host: HOST })

        // API/host summary
        const env = process.env.NODE_ENV ?? 'development'
        logOrch.info(`listening host=${HOST} port=${PORT} env=${env}`)

        // Serial env summary (so we can confirm what will be used at runtime)
        const serial = summarizeSerialEnv()
        const serialLog: Record<string, unknown> = { ...serial }
        if (serial.matchersError) {
            logOrch.warn('SERIAL_MATCHERS_JSON parse error', { error: serial.matchersError })
        }
        // logOrch.info('serial config (env-derived)', serialLog)

        // Graceful shutdown
        const shutdown = async (signal: NodeJS.Signals) => {
            if (!app) process.exit(0)
            try {
                logOrch.info(`received ${signal}, shutting down`)
                await app.close()
                logOrch.info('orchestrator closed')
                process.exit(0)
            } catch (err) {
                logOrch.error('error during shutdown', { err: (err as Error).message })
                process.exit(1)
            }
        }
        process.on('SIGINT', () => void shutdown('SIGINT'))
        process.on('SIGTERM', () => void shutdown('SIGTERM'))
    } catch (err) {
        // Boot failure (e.g., required devices missing after timeout)
        logOrch.error(`failed to start err="${(err as Error).message}"`)
        try {
            await app?.close()
        } catch { /* ignore */ }
        process.exit(1)
    }
}

void start()