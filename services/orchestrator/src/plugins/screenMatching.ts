import fp from 'fastify-plugin'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import {
  createLogger,
  LogChannel,
  type ChannelLogger,
} from '@autobench98/logging'
import { buildScreenMatchingConfigFromEnv } from '../config/screenMatching.js'
import { ScreenMatchingService } from '../detection/screens/ScreenMatchingService.js'
import { SidecarFrameProvider } from '../detection/screens/SidecarFrameProvider.js'
import { ScreenMatchingError } from '../detection/screens/types.js'

declare module 'fastify' {
  interface FastifyInstance {
    screenMatching?: ScreenMatchingService
  }
}

type ReferenceMatchBody = {
  referenceImage?: unknown
  threshold?: unknown
}

type ApiErrorPayload = {
  ok: false
  error: {
    code: string
    message: string
    detail?: Record<string, unknown>
  }
}

function sendScreenMatchingError(
  reply: FastifyReply,
  err: unknown,
  log: ChannelLogger
): FastifyReply {
  if (err instanceof ScreenMatchingError) {
    if (err.statusCode >= 500) {
      log.warn('Screen matching request failed.', {
        code: err.code,
        message: err.message,
        detail: err.detail ?? {},
      })
    }

    const payload: ApiErrorPayload = {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.detail ? { detail: err.detail } : {}),
      },
    }
    return reply.code(err.statusCode).send(payload)
  }

  log.warn('Unexpected screen matching request failure.', {
    cause: err instanceof Error ? err.message : String(err),
  })

  return reply.code(500).send({
    ok: false,
    error: {
      code: 'ScreenMatchingUnexpectedError',
      message: 'Unexpected screen matching failure.',
    },
  } satisfies ApiErrorPayload)
}

const screenMatchingPlugin: FastifyPluginAsync = async (app) => {
  const { channel } = createLogger('orchestrator', app.clientBuf)
  const log = channel(LogChannel.app)
  const config = buildScreenMatchingConfigFromEnv(process.env)

  for (const warning of config.warnings) {
    log.warn(warning)
  }

  const service = new ScreenMatchingService({
    config,
    frameProvider: new SidecarFrameProvider({ baseUrl: config.sidecarBaseUrl }),
    logger: log,
  })

  app.decorate('screenMatching', service)

  log.info('Screen matching service initialized.', {
    staticThreshold: config.staticThreshold,
    defaultReferenceThreshold: config.defaultReferenceThreshold,
    referenceDir: config.referenceDir,
    sidecarBaseUrl: config.sidecarBaseUrl,
  })

  app.get('/api/screen-matching/config', async (_req, reply) => {
    return reply.send({
      ok: true,
      config: service.getPublicConfig(),
    })
  })

  app.get('/api/screen-matching/static', async (_req, reply) => {
    try {
      const result = await service.checkStatic()
      return reply.send({ ok: true, result })
    } catch (err) {
      return sendScreenMatchingError(reply, err, log)
    }
  })

  app.get('/api/screen-matching/references', async (_req, reply) => {
    try {
      const items = await service.listReferenceImages()
      return reply.send({
        ok: true,
        referenceDir: service.getPublicConfig().referenceDir,
        items,
      })
    } catch (err) {
      return sendScreenMatchingError(reply, err, log)
    }
  })

  app.post('/api/screen-matching/reference', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as ReferenceMatchBody
      if (typeof body.referenceImage !== 'string') {
        throw new ScreenMatchingError(
          'InvalidReferenceImage',
          'referenceImage must be a string.',
          400
        )
      }

      const result = await service.compareCurrentFrameToReference(
        body.referenceImage,
        body.threshold
      )
      return reply.send({ ok: true, result })
    } catch (err) {
      return sendScreenMatchingError(reply, err, log)
    }
  })

  app.post('/api/screen-matching/static/reset', async (_req, reply) => {
    service.resetStaticHistory()
    return reply.send({ ok: true })
  })
}

export default fp(screenMatchingPlugin, { name: 'screen-matching-plugin' })
