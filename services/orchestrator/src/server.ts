import fs from 'node:fs'
import {
    createServer as createHttpServer,
    type IncomingMessage,
    type Server as HttpServer
} from 'node:http'
import type { ServerOptions as HttpsServerOptions } from 'node:https'
import os from 'node:os'
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

function jsonOneLine(value: unknown): string {
    try {
        return JSON.stringify(value)
    } catch {
        return '"unserializable"'
    }
}

type TlsRuntimeConfig = {
    https: HttpsServerOptions
    keyFile: string
    certFile: string
    caFile?: string
}

type RedirectTargetConfig = {
    publicHost: string | null
    publicPort: number
}

function getFirstEnv(...names: string[]): string | undefined {
    for (const name of names) {
        const value = process.env[name]
        if (value !== undefined && value.trim() !== '') return value.trim()
    }
    return undefined
}

function parseBooleanValue(name: string, value: string): boolean {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
    throw new Error(`${name} must be a boolean value (true/false), got "${value}"`)
}

function parseOptionalBoolEnv(...names: string[]): boolean | undefined {
    for (const name of names) {
        const value = process.env[name]
        if (value !== undefined && value.trim() !== '') return parseBooleanValue(name, value)
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

function expandHome(input: string): string {
    if (input === '~') return os.homedir()
    if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
    return input
}

function resolveExistingFile(rawPath: string, label: string): string {
    const expanded = expandHome(rawPath)
    const candidates = path.isAbsolute(expanded)
        ? [expanded]
        : [path.resolve(process.cwd(), expanded), path.resolve(REPO_ROOT, expanded)]

    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    }

    throw new Error(`${label} file not found. Checked: ${candidates.join(', ')}`)
}

function loadTlsConfig(): TlsRuntimeConfig | null {
    const keyFileRaw = getFirstEnv(
        'API_SSL_KEY_FILE',
        'API_HTTPS_KEY_FILE',
        'SSL_KEY_FILE',
        'HTTPS_KEY_FILE',
        'TLS_KEY_FILE'
    )
    const certFileRaw = getFirstEnv(
        'API_SSL_CERT_FILE',
        'API_HTTPS_CERT_FILE',
        'SSL_CERT_FILE',
        'HTTPS_CERT_FILE',
        'TLS_CERT_FILE'
    )
    const caFileRaw = getFirstEnv(
        'API_SSL_CA_FILE',
        'API_HTTPS_CA_FILE',
        'SSL_CA_FILE',
        'HTTPS_CA_FILE',
        'TLS_CA_FILE'
    )

    const httpsEnabled = parseOptionalBoolEnv(
        'API_SSL_ENABLED',
        'API_HTTPS_ENABLED',
        'SSL_ENABLED',
        'HTTPS_ENABLED',
        'TLS_ENABLED'
    ) ?? Boolean(keyFileRaw || certFileRaw || caFileRaw)

    if (!httpsEnabled) return null

    if (!keyFileRaw || !certFileRaw) {
        throw new Error(
            'HTTPS is enabled, but both API_SSL_KEY_FILE and API_SSL_CERT_FILE must be set'
        )
    }

    const keyFile = resolveExistingFile(keyFileRaw, 'API_SSL_KEY_FILE')
    const certFile = resolveExistingFile(certFileRaw, 'API_SSL_CERT_FILE')
    const caFile = caFileRaw ? resolveExistingFile(caFileRaw, 'API_SSL_CA_FILE') : undefined
    const passphrase = getFirstEnv(
        'API_SSL_PASSPHRASE',
        'API_HTTPS_PASSPHRASE',
        'SSL_PASSPHRASE',
        'HTTPS_PASSPHRASE',
        'TLS_PASSPHRASE'
    )

    const https: HttpsServerOptions = {
        key: fs.readFileSync(keyFile),
        cert: fs.readFileSync(certFile),
    }

    if (caFile) https.ca = fs.readFileSync(caFile)
    if (passphrase) https.passphrase = passphrase

    return { https, keyFile, certFile, caFile }
}

function stripPortFromHost(hostHeader: string): string {
    const host = hostHeader.trim()
    if (!host) return 'localhost'

    if (host.startsWith('[')) {
        const end = host.indexOf(']')
        if (end !== -1) return host.slice(0, end + 1)
        return host
    }

    const firstColon = host.indexOf(':')
    const lastColon = host.lastIndexOf(':')
    if (firstColon !== -1 && firstColon === lastColon) return host.slice(0, lastColon)

    return host
}

function hostWithOptionalPort(host: string, port: number): string {
    const bareHost = stripPortFromHost(host)
    const normalizedHost = bareHost.includes(':') && !bareHost.startsWith('[')
        ? `[${bareHost}]`
        : bareHost

    return port === 443 ? normalizedHost : `${normalizedHost}:${port}`
}

function getHostHeader(req: IncomingMessage): string {
    const host = req.headers.host
    if (Array.isArray(host)) return host[0] ?? 'localhost'
    return host ?? 'localhost'
}

function buildSecureRedirectLocation(
    req: IncomingMessage,
    target: RedirectTargetConfig,
    scheme: 'https' | 'wss' = 'https'
): string {
    const targetHost = target.publicHost ?? getHostHeader(req)
    const requestUrl = typeof req.url === 'string' && req.url.startsWith('/') ? req.url : '/'
    return `${scheme}://${hostWithOptionalPort(targetHost, target.publicPort)}${requestUrl}`
}

function createHttpsRedirectServer(target: RedirectTargetConfig): HttpServer {
    const server = createHttpServer((req, res) => {
        const location = buildSecureRedirectLocation(req, target)
        res.statusCode = 308
        res.statusMessage = 'Permanent Redirect'
        res.setHeader('Location', location)
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.setHeader('Connection', 'close')

        if (req.method === 'HEAD') {
            res.end()
            return
        }

        res.end(`Permanent Redirect: ${location}\n`)
    })

    server.on('upgrade', (req, socket) => {
        const location = buildSecureRedirectLocation(req, target, 'wss')
        socket.write(
            'HTTP/1.1 308 Permanent Redirect\r\n' +
                `Location: ${location}\r\n` +
                'Connection: close\r\n' +
                'Content-Length: 0\r\n' +
                '\r\n'
        )
        socket.destroy()
    })

    return server
}

function listenHttpServer(server: HttpServer, port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            server.off('error', onError)
            server.off('listening', onListening)
        }
        const onError = (err: Error) => {
            cleanup()
            reject(err)
        }
        const onListening = () => {
            cleanup()
            resolve()
        }

        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
    })
}

function closeHttpServer(server: HttpServer | null): Promise<void> {
    if (!server || !server.listening) return Promise.resolve()

    return new Promise((resolve, reject) => {
        server.close((err) => {
            if (err) reject(err)
            else resolve()
        })
    })
}

async function start() {
    const { channel } = createLogger('orchestrator')
    const logOrch = channel(LogChannel.orchestrator)

    let app: FastifyInstance | null = null
    let redirectServer: HttpServer | null = null
    let shutdownStarted = false

    try {
        const tlsConfig = loadTlsConfig()
        const HOST = process.env.API_HOST ?? '0.0.0.0'
        const PORT = parsePortValue(
            tlsConfig ? getFirstEnv('API_HTTPS_PORT', 'API_PORT') : getFirstEnv('API_PORT'),
            tlsConfig ? 443 : 3000,
            tlsConfig ? 'API_HTTPS_PORT/API_PORT' : 'API_PORT'
        )
        const PROTOCOL = tlsConfig ? 'https' : 'http'

        const redirectEnabled = tlsConfig
            ? (parseOptionalBoolEnv('API_HTTP_REDIRECT_ENABLED', 'HTTP_REDIRECT_ENABLED') ?? true)
            : false
        const redirectPort = redirectEnabled
            ? parsePortValue(
                getFirstEnv('API_HTTP_REDIRECT_PORT', 'HTTP_REDIRECT_PORT'),
                80,
                'API_HTTP_REDIRECT_PORT'
            )
            : null
        const redirectHost = redirectEnabled
            ? (getFirstEnv('API_HTTP_REDIRECT_HOST', 'HTTP_REDIRECT_HOST') ?? HOST)
            : null
        const publicHttpsHost = tlsConfig
            ? (getFirstEnv('API_PUBLIC_HTTPS_HOST', 'API_HTTPS_PUBLIC_HOST') ?? null)
            : null
        const publicHttpsPort = tlsConfig
            ? parsePortValue(
                getFirstEnv('API_PUBLIC_HTTPS_PORT', 'API_HTTPS_PUBLIC_PORT'),
                PORT,
                'API_PUBLIC_HTTPS_PORT'
            )
            : PORT

        if (redirectEnabled && redirectPort === PORT) {
            throw new Error('API_HTTP_REDIRECT_PORT must differ from the HTTPS API port')
        }

        const { buildApp } = await import('./app.js')
        app = buildApp(tlsConfig ? { https: tlsConfig.https } : undefined)

        // Standard Fastify ready cycle (will run plugin onReady hooks).
        await app.ready()

        // Do NOT block here on device discovery - the serial plugin
        // will gate startup in the background and exit(1) if required
        // devices never come online.

        await app.listen({ port: PORT, host: HOST })

        if (redirectEnabled && redirectPort !== null && redirectHost) {
            redirectServer = createHttpsRedirectServer({
                publicHost: publicHttpsHost,
                publicPort: publicHttpsPort,
            })
            await listenHttpServer(redirectServer, redirectPort, redirectHost)
        }

        // API/host summary
        const env = process.env.NODE_ENV ?? 'development'
        logOrch.info(`listening protocol=${PROTOCOL} host=${HOST} port=${PORT} env=${env}`)
        if (tlsConfig) {
            logOrch.info(
                `tls enabled cert=${tlsConfig.certFile} key=${tlsConfig.keyFile}` +
                    `${tlsConfig.caFile ? ` ca=${tlsConfig.caFile}` : ''}`
            )
        }
        if (redirectEnabled && redirectPort !== null && redirectHost) {
            const redirectTarget = publicHttpsHost
                ? `https://${hostWithOptionalPort(publicHttpsHost, publicHttpsPort)}`
                : `https://<request-host>${publicHttpsPort === 443 ? '' : `:${publicHttpsPort}`}`
            logOrch.info(
                `http redirect listening host=${redirectHost} port=${redirectPort} status=308 target=${redirectTarget}`
            )
        }

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
            if (!app && !redirectServer) process.exit(0)
            try {
                logOrch.info(`received signal=${signal} action=shutdown-start`)
                await closeHttpServer(redirectServer)
                await app?.close()
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
            await closeHttpServer(redirectServer)
            await app?.close()
        } catch {
            // ignore
        }
        process.exit(1)
    }
}

void start()
