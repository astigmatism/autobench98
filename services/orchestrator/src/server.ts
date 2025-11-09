import { buildApp } from './app'
import {
    createLogger,
    makeClientBuffer,
    LogChannel,
    type ClientLogBuffer
} from '@autobench98/logging'

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
