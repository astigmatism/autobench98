// services/orchestrator/src/plugins/frontPanel.ts

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { createLogger, LogChannel, type ClientLogBuffer } from '@autobench98/logging'

import { FrontPanelService } from '../devices/front-panel/FrontPanelService.js'
import type { FrontPanelEvent } from '../devices/front-panel/types.js'
import { buildFrontPanelConfigFromEnv } from '../devices/front-panel/utils.js'
import { FrontPanelStateAdapter } from '../adapters/frontPanel.adapter.js'
import { updateFrontPanelSnapshot } from '../core/state.js'

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
        // kinda spammy in the logs, silenced for now
        // this.logFp.info(`kind=${evt.kind} hddActive=${evt.active ? 'on' : 'off'}`)
        break
      }
      case 'frontpanel-power-button-held-changed': {
        this.logFp.info(`kind=${evt.kind} held=${evt.held ? 'true' : 'false'}`)
        break
      }
      case 'frontpanel-debug-line': {
        // Keep legacy behavior: emit raw firmware lines as-is (escaped).
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

/* -------------------------------------------------------------------------- */
/*  Host power propagation (frontPanel -> PS/2 keyboard/mouse)                */
/* -------------------------------------------------------------------------- */

function mapPowerSenseToHostPower(p: unknown): 'on' | 'off' | 'unknown' {
  if (p === 'on') return 'on'
  if (p === 'off') return 'off'
  return 'unknown'
}

// ---- Plugin implementation -------------------------------------------------

const frontPanelPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  const env = process.env
  const { channel } = createLogger('frontpanel-plugin', app.clientBuf)
  const logPlugin = channel(LogChannel.app)

  const cfg = buildFrontPanelConfigFromEnv(env)

  const loggerSink = new FrontPanelLoggerEventSink(app)
  const stateAdapter = new FrontPanelStateAdapter()

  const events: FrontPanelEventSink = new FanoutFrontPanelEventSink(loggerSink, {
    publish(evt: FrontPanelEvent): void {
      stateAdapter.handle(evt)
      const next = stateAdapter.getState()
      updateFrontPanelSnapshot(next)

      // Safety-critical: also push host-power directly to dependent services as a fail-safe,
      // while still keeping AppState as the source of truth.
      //
      // Rationale: mouse movement injection is gated by mouse firmware's POWER_STATUS_PIN,
      // which is driven by the keyboard Arduino pin state. That pin state is driven by the
      // keyboard service receiving host power transitions (frontPanel powerSense).
      //
      // This direct propagation is idempotent (services de-dupe identical states) and
      // protects against any state subscription mis-ordering.
      if (
        evt.kind === 'frontpanel-power-sense-changed' ||
        evt.kind === 'frontpanel-device-disconnected' ||
        evt.kind === 'frontpanel-device-lost' ||
        evt.kind === 'frontpanel-identify-success'
      ) {
        const hostPower = mapPowerSenseToHostPower((next as any)?.powerSense)

        // PS/2 keyboard service (drives its POWER_STATUS_PIN output, which the mouse reads)
        const kb = (app as any).ps2Keyboard as { setHostPower?: (p: 'on' | 'off' | 'unknown') => void } | undefined
        try {
          if (kb && typeof kb.setHostPower === 'function') kb.setHostPower(hostPower)
        } catch {
          // never let propagation failures affect front panel processing
        }

        // PS/2 mouse service (policy gate for ops)
        const setMousePower = (app as any).ps2MouseSetHostPower as
          | ((p: 'on' | 'off' | 'unknown') => void)
          | undefined
        try {
          if (typeof setMousePower === 'function') setMousePower(hostPower)
        } catch {
          // swallow
        }
      }
    },
  })

  // Construct the service without any message bus dependency.
  const svc = new FrontPanelService(cfg, { events } as any)

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
