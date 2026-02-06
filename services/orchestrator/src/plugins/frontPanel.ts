import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { createLogger, LogChannel, type ClientLogBuffer } from '@autobench98/logging'

import { FrontPanelService } from '../devices/front-panel/FrontPanelService.js'
import type { FrontPanelEvent } from '../devices/front-panel/types.js'
import { buildFrontPanelConfigFromEnv } from '../devices/front-panel/utils.js'

// ✅ AppState slice mutator for power truth (replaces message bus + legacy snapshot updater)
import { setPcPowerTruth } from '../core/state/slices/power.js'

// ---- Fastify decoration ----------------------------------------------------

declare module 'fastify' {
  interface FastifyInstance {
    frontPanel: FrontPanelService
    clientBuf: ClientLogBuffer
  }
}

// ---- Event sink using orchestrator logging ---------------------------------

type FrontPanelEventSink = {
  publish: (evt: FrontPanelEvent) => void
}

class FrontPanelLoggerEventSink implements FrontPanelEventSink {
  private readonly logFp: ReturnType<ReturnType<typeof createLogger>['channel']>

  constructor(app: FastifyInstance) {
    const { channel } = createLogger('frontpanel', app.clientBuf)
    this.logFp = channel(LogChannel.frontpanel)
  }

  private fmtFirmwareLine(line: string): string {
    let needsEscape = false
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i)
      if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
        needsEscape = true
        break
      }
    }
    if (!needsEscape) return line

    let out = ''
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i)
      if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
        out += `\\x${c.toString(16).padStart(2, '0')}`
      } else {
        out += line[i]
      }
    }
    return out
  }

  publish(evt: FrontPanelEvent): void {
    switch (evt.kind) {
      case 'frontpanel-device-identified': {
        this.logFp.info(`kind=${evt.kind} path=${evt.path} baud=${evt.baudRate}`)
        break
      }
      case 'frontpanel-device-connected': {
        this.logFp.info(`kind=${evt.kind} path=${evt.path} baud=${evt.baudRate}`)
        break
      }
      case 'frontpanel-device-disconnected': {
        this.logFp.warn(`kind=${evt.kind} path=${evt.path} reason=${evt.reason}`)
        break
      }
      case 'frontpanel-device-lost': {
        this.logFp.warn(`kind=${evt.kind} id=${evt.id}`)
        break
      }
      case 'frontpanel-identify-start': {
        this.logFp.info(`kind=${evt.kind} path=${evt.path}`)
        break
      }
      case 'frontpanel-identify-success': {
        this.logFp.info(`kind=${evt.kind} token=${evt.token}`)
        break
      }
      case 'frontpanel-identify-failed': {
        this.logFp.warn(`kind=${evt.kind} error=${evt.error?.message ?? 'unknown'}`)
        break
      }
      case 'frontpanel-power-sense-changed': {
        this.logFp.info(`kind=${evt.kind} powerSense=${evt.powerSense}`)
        break
      }
      case 'frontpanel-hdd-activity-changed': {
        this.logFp.info(`kind=${evt.kind} hddActive=${evt.active ? 'on' : 'off'}`)
        break
      }
      case 'frontpanel-power-button-held-changed': {
        this.logFp.info(`kind=${evt.kind} held=${evt.held ? 'true' : 'false'}`)
        break
      }
      case 'frontpanel-debug-line': {
        this.logFp.info(this.fmtFirmwareLine(evt.line))
        break
      }
      case 'frontpanel-operation-cancelled': {
        this.logFp.warn(`kind=${evt.kind} opId=${evt.opId} reason=${evt.reason}`)
        break
      }
      case 'frontpanel-operation-failed': {
        this.logFp.warn(
          `kind=${evt.kind} opId=${evt.result?.id ?? 'unknown'} error=${evt.result?.error?.message ?? 'unknown'}`
        )
        break
      }
      case 'recoverable-error': {
        this.logFp.warn(`kind=${evt.kind} error=${evt.error?.message ?? 'unknown'}`)
        break
      }
      case 'fatal-error': {
        this.logFp.error(`kind=${evt.kind} error=${evt.error?.message ?? 'unknown'}`)
        break
      }

      // Noise suppressed
      case 'frontpanel-operation-queued':
      case 'frontpanel-operation-started':
      case 'frontpanel-operation-completed': {
        break
      }

      default: {
        break
      }
    }
  }
}

class FanoutFrontPanelEventSink implements FrontPanelEventSink {
  private readonly sinks: FrontPanelEventSink[]

  constructor(...sinks: FrontPanelEventSink[]) {
    this.sinks = sinks
  }

  publish(evt: FrontPanelEvent): void {
    for (const sink of this.sinks) {
      try {
        sink.publish(evt)
      } catch {
        // swallow per-sink errors
      }
    }
  }
}

// ---- Plugin implementation -------------------------------------------------

const frontPanelPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  const env = process.env
  const { channel } = createLogger('frontpanel-plugin', app.clientBuf)
  const logPlugin = channel(LogChannel.app)

  const cfg = buildFrontPanelConfigFromEnv(env)

  const loggerSink = new FrontPanelLoggerEventSink(app)

  const events: FrontPanelEventSink = new FanoutFrontPanelEventSink(
    loggerSink,
    {
      publish(evt: FrontPanelEvent): void {
        // AppState truth for PC power
        if (evt.kind === 'frontpanel-power-sense-changed') {
          try {
            setPcPowerTruth({
              value: evt.powerSense, // 'on' | 'off' | 'unknown'
              source: `frontpanel:${evt.source}`, // evt.source is the literal "firmware"
              changedAt: evt.at,
            })
          } catch (err: unknown) {
            // Fail-safe: never crash frontpanel path due to state write.
            logPlugin.warn('pc power AppState update failed', {
              err: (err as Error)?.message ?? String(err),
            })
          }
        }

        // Fail-closed on disconnect/loss even if no power-sense event was emitted
        if (evt.kind === 'frontpanel-device-disconnected') {
          try {
            setPcPowerTruth({
              value: 'unknown',
              source: `frontpanel:disconnect:${evt.reason}`,
              changedAt: evt.at,
            })
          } catch (err: unknown) {
            logPlugin.warn('pc power AppState update failed', {
              err: (err as Error)?.message ?? String(err),
            })
          }
        }

        if (evt.kind === 'frontpanel-device-lost') {
          try {
            setPcPowerTruth({
              value: 'unknown',
              source: `frontpanel:device-lost`,
              changedAt: evt.at,
            })
          } catch (err: unknown) {
            logPlugin.warn('pc power AppState update failed', {
              err: (err as Error)?.message ?? String(err),
            })
          }
        }
      },
    }
  )

  const svc = new FrontPanelService(cfg, { events })

  app.decorate('frontPanel', svc)

  app.addHook('onReady', async () => {
    logPlugin.info('starting front panel service')
    await svc.start()
  })

  app.addHook('onClose', async () => {
    logPlugin.info('stopping front panel service')
    await svc.stop().catch((err: unknown) => {
      logPlugin.warn('error stopping front panel service', {
        err: (err as Error).message,
      })
    })
  })
}

export default fp(frontPanelPlugin, {
  name: 'frontpanel-plugin',
})
