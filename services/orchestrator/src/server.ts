// apps/orchestrator/src/server.ts
import fs from 'node:fs'
import path from 'node:path'
import { config as dotenvConfig } from 'dotenv'
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

async function start() {
    const PORT = Number(process.env.API_PORT ?? 3000)
    const HOST = process.env.API_HOST ?? '0.0.0.0'

    const app = buildApp()
    await app.listen({ port: PORT, host: HOST })

    // Log listening line via channel logger (no Fastify logger involved)
    const { channel } = createLogger('orchestrator')
    const logOrch = channel(LogChannel.orchestrator)

    // You can add local/inside-Docker hints as needed
    logOrch.info(`listening on ${HOST}:${PORT}`)
}

void start()