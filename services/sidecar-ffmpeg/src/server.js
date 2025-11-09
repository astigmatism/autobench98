import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { createLogger, LogChannel } from '@autobench98/logging'

const { channel } = createLogger('sidecar')
const logApp = channel(LogChannel.app)
const logSidecar = channel(LogChannel.sidecar)

const app = Fastify({ logger: false })
await app.register(cors, { origin: true })
await app.register(websocket)

app.get('/health', async () => ({ status: 'ok' }))
app.get('/ready', async () => ({ ready: true }))
app.get('/', async () => ({ ok: true, service: 'autobench98-sidecar-ffmpeg' }))

const PORT = Number(process.env.SIDECAR_PORT ?? 3100)
const HOST = process.env.SIDECAR_HOST ?? '0.0.0.0'

logSidecar.info('sidecar app built')
await app.listen({ port: PORT, host: HOST })
logSidecar.info(`listening on ${HOST}:${PORT}`)