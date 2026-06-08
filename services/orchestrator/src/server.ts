import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as dotenvConfig } from 'dotenv'
import type { FastifyInstance } from 'fastify'
import {
    createLogger,
    LogChannel
} from '@autobench98/logging'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(MODULE_DIR, '../../..')

/**
 * Load environment variables before importing modules that read process.env at
 * module scope, especially core/state.ts. The repository keeps .env files at
 * the repo root, while npm workspace scripts commonly run with cwd set to
 * services/orchestrator, so check both locations.
 *
 * Precedence within each env directory:
 *   1) .env
 *   2) .env.{NODE_ENV}
 *   3) .env.local
 * Later files override earlier ones. Service-local files override repo-root
 * files when both are present.
 */
;(function loadEnv() {
    const cwd = process.cwd()

    const envDirs = Array.from(new Set([REPO_ROOT, cwd]))
    const explicitNodeEnv = String(process.env.NODE_ENV ?? '').trim()

    const loadForMode = (mode: string) => {
        for (const dir of envDirs) {
            const files = [
                path.resolve(dir, '.env'),
                path.resolve(dir, `.env.${mode}`),
                path.resolve(dir, '.env.local'),
            ]

            for (const file of files) {
                if (fs.existsSync(file)) {
                    dotenvConfig({ path: file, override: true })
                }
            }
        }
    }

    const initialMode = explicitNodeEnv || 'development'
    loadForMode(initialMode)

    // If NODE_ENV came from .env itself, honor it by loading that mode's file too.
    // A real process env NODE_ENV remains authoritative for selecting the mode.
    const discoveredMode = String(process.env.NODE_ENV ?? '').trim()
    if (!explicitNodeEnv && discoveredMode && discoveredMode !== initialMode) {
        loadForMode(discoveredMode)
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
        matchersError,
    }
}


function getFirstEnv(...names: string[]): string | undefined {
    for (const name of names) {
        const value = process.env[name]
        if (value !== undefined && value.trim() !== '') return value.trim()
    }
    return undefined
}

function parsePortValue(raw: string | undefined, fallback: number, label: string): number {
    const value = raw ?? String(fallback)
    const port = Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${label} must be an integer TCP port from 1 to 65535, got "${value}"`)
    }
    return port
}

function jsonOneLine(value: unknown): string {
    try {
        return JSON.stringify(value)
    } catch {
        return '"unserializable"'
    }
}

async function start() {
    const { channel } = createLogger('orchestrator')
    const logOrch = channel(LogChannel.orchestrator)

    let app: FastifyInstance | null = null
    let shutdownStarted = false

    try {
        const HOST = process.env.API_HOST ?? '0.0.0.0'
        const PORT = parsePortValue(getFirstEnv('API_PORT'), 3000, 'API_PORT')
        const PROTOCOL = 'http'

        const { buildApp } = await import('./app.js')
        app = buildApp()

        // Standard Fastify ready cycle (will run plugin onReady hooks).
        await app.ready()

        // Do NOT block here on device discovery - the serial plugin
        // will gate startup in the background and exit(1) if required
        // devices never come online.

        await app.listen({ port: PORT, host: HOST })

        // API/host summary
        const env = process.env.NODE_ENV ?? 'development'
        logOrch.info(`listening protocol=${PROTOCOL} host=${HOST} port=${PORT} env=${env}`)
        logOrch.info(
            'tls termination mode=external-proxy; orchestrator serves plain HTTP only. ' +
                'Use API_FORCE_HTTPS_REDIRECT=true with X-Forwarded-Proto=https from the proxy to enforce browser HTTPS.'
        )

        // Serial env summary (concise, single line)
        const serial = summarizeSerialEnv()
        if (serial.matchersError) {
            logOrch.warn(`SERIAL_MATCHERS_JSON parse error err="${serial.matchersError}"`)
        }
        logOrch.info(
            `serial env source=${serial.matchersSource} matchers=${serial.matchersCount ?? 0} ` +
                `rescanMs=${serial.rescanMs ?? 0} summaryMs=${serial.summaryMs ?? 0} defaultBaud=${serial.defaultBaud}`
        )

        // Graceful shutdown
        const shutdown = async (signal: NodeJS.Signals) => {
            if (shutdownStarted) return
            shutdownStarted = true
            if (!app) process.exit(0)
            try {
                logOrch.info(`received signal=${signal} action=shutdown-start`)
                await app.close()
                logOrch.info('action=shutdown-complete component=orchestrator')
                process.exit(0)
            } catch (err) {
                const msg = (err as Error).message
                logOrch.error(`action=shutdown-failed err="${msg}"`)
                process.exit(1)
            }
        }
        process.on('SIGINT', () => void shutdown('SIGINT'))
        process.on('SIGTERM', () => void shutdown('SIGTERM'))
    } catch (err) {
        // Boot/runtime failure (including "required devices missing" if plugin exited early)
        const msg = (err as Error)?.message ?? String(err)
        logOrch.error(`failed to start err="${msg}"`)

        // Best-effort diagnostic snapshot only. This is not the root-cause classification.
        if (app && (app as any).getDeviceStatus) {
            try {
                const status = (app as any).getDeviceStatus()
                logOrch.error(
                    'startup failure diagnostic ' +
                        `kind=device-readiness-snapshot ready=${status.ready ? 'true' : 'false'} ` +
                        `missing=${jsonOneLine(status.missing)} byStatus=${jsonOneLine(status.byStatus)}`
                )
            } catch (snapshotErr) {
                const snapshotMsg =
                    snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr)
                logOrch.warn(
                    `startup failure diagnostic kind=device-readiness-snapshot-unavailable err="${snapshotMsg}"`
                )
            }
        }

        try {
            await app?.close()
        } catch {
            // ignore
        }
        process.exit(1)
    }
}

void start()
