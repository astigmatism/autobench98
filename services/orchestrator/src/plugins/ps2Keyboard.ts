// services/orchestrator/src/plugins/ps2Keyboard.ts

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import {
  createLogger,
  LogChannel,
  type ClientLogBuffer,
} from '@autobench98/logging'

import { PS2KeyboardService } from '../devices/ps2-keyboard/PS2KeyboardService.js'
import type { PS2KeyboardEvent } from '../devices/ps2-keyboard/types.js'
import { buildPS2KeyboardConfigFromEnv } from '../devices/ps2-keyboard/utils.js'
import { PS2KeyboardStateAdapter } from '../adapters/ps2Keyboard.adapter.js'
import { updatePS2KeyboardSnapshot } from '../core/state.js'

// ---- Fastify decoration ----------------------------------------------------

declare module 'fastify' {
  interface FastifyInstance {
    ps2Keyboard: PS2KeyboardService
    clientBuf: ClientLogBuffer
  }
}

// ---- Event sink using orchestrator logging ---------------------------------

type PS2KeyboardEventSink = {
  publish: (evt: PS2KeyboardEvent) => void
}

class PS2KeyboardLoggerEventSink implements PS2KeyboardEventSink {
  private readonly logKb: ReturnType<ReturnType<typeof createLogger>['channel']>

  constructor(app: FastifyInstance) {
    const { channel } = createLogger('ps2-keyboard', app.clientBuf)
    this.logKb = channel(LogChannel.keyboard)
  }

  private isModifierCode(code?: string): boolean {
    if (!code) return false
    return (
      code === 'ShiftLeft' ||
      code === 'ShiftRight' ||
      code === 'ControlLeft' ||
      code === 'ControlRight' ||
      code === 'AltLeft' ||
      code === 'AltRight' ||
      code === 'MetaLeft' ||
      code === 'MetaRight'
    )
  }

  private shortMod(code: string): { label: string; weight: number } {
    // Weight defines chord ordering.
    switch (code) {
      case 'ControlLeft': return { label: 'CtrlL', weight: 10 }
      case 'ControlRight': return { label: 'CtrlR', weight: 11 }
      case 'AltLeft': return { label: 'AltL', weight: 20 }
      case 'AltRight': return { label: 'AltR', weight: 21 }
      case 'ShiftLeft': return { label: 'ShiftL', weight: 30 }
      case 'ShiftRight': return { label: 'ShiftR', weight: 31 }
      case 'MetaLeft': return { label: 'MetaL', weight: 40 }
      case 'MetaRight': return { label: 'MetaR', weight: 41 }
      default: return { label: code, weight: 999 }
    }
  }

  private keyLabel(identity?: { code?: string; key?: string }): string {
    if (!identity) return 'Unknown'

    const k = identity.key
    if (typeof k === 'string' && k.length > 0) {
      if (k === ' ') return 'Space'
      return k
    }

    const c = identity.code
    if (typeof c === 'string' && c.length > 0) {
      // A tiny bit of cleanup for common stable codes.
      if (c.startsWith('Key') && c.length === 4) return c.slice(3) // KeyA -> A
      if (c.startsWith('Digit') && c.length === 6) return c.slice(5) // Digit1 -> 1
      return c
    }

    return 'Unknown'
  }

  private chord(mods: string[] | undefined, key: string): string {
    if (!mods || mods.length === 0) return key
    const normalized = mods
      .filter((m) => typeof m === 'string' && m.length > 0)
      .map((m) => this.shortMod(m))
      .sort((a, b) => a.weight - b.weight)
      .map((m) => m.label)
    return `${normalized.join('+')}+${key}`
  }

  publish(evt: PS2KeyboardEvent): void {
    switch (evt.kind) {
      /* ---------------- Lifecycle / identification ------------------ */
      case 'keyboard-device-identified': {
        // id is huge (usb:...); keep the human-meaningful bits.
        this.logKb.info(`identified path=${evt.path} baud=${evt.baudRate}`)
        break
      }

      case 'keyboard-device-connected': {
        this.logKb.info(`connected path=${evt.path} baud=${evt.baudRate}`)
        break
      }

      case 'keyboard-device-disconnected': {
        this.logKb.warn(`disconnected path=${evt.path} reason=${evt.reason}`)
        break
      }

      case 'keyboard-device-lost': {
        // id is huge and rarely useful in console output.
        this.logKb.warn('lost')
        break
      }

      case 'keyboard-identify-start': {
        this.logKb.info(`identify path=${evt.path}`)
        break
      }

      case 'keyboard-identify-success': {
        this.logKb.info(`ready token=${evt.token}`)
        break
      }

      case 'keyboard-identify-failed': {
        this.logKb.warn(`identify failed: ${evt.error?.message ?? 'unknown'}`)
        break
      }

      /* ---------------- Power -------------------------------------- */
      case 'keyboard-power-changed': {
        // Do not print requestedBy (explicitly undesired).
        this.logKb.info(`power ${evt.power}`)
        break
      }

      /* ---------------- High-signal key activity -------------------- */
      case 'keyboard-key-action': {
        const code = evt.identity?.code
        const label = this.keyLabel(evt.identity)

        // Modifiers: log hold/release as down/up.
        if (this.isModifierCode(code)) {
          const mod = this.shortMod(code!).label
          if (evt.action === 'hold') {
            this.logKb.info(`down ${mod}`)
            break
          }
          if (evt.action === 'release') {
            this.logKb.info(`up ${mod}`)
            break
          }
          // If a modifier ever comes through as "press", treat as press.
          this.logKb.info(`press ${mod}`)
          break
        }

        // Non-modifiers: log only "press" (service suppresses non-mod releases).
        if (evt.action === 'press') {
          this.logKb.info(`press ${this.chord(evt.mods, label)}`)
        }
        break
      }

      /* ---------------- Failures / cancellations / errors ----------- */
      case 'keyboard-operation-cancelled': {
        // Keep this short; operations are otherwise suppressed.
        this.logKb.warn(`cancelled reason=${evt.reason}`)
        break
      }

      case 'keyboard-operation-failed': {
        this.logKb.warn(`failed: ${evt.result?.error?.message ?? 'unknown'}`)
        break
      }

      case 'recoverable-error': {
        this.logKb.warn(`error: ${evt.error?.message ?? 'unknown'}`)
        break
      }

      case 'fatal-error': {
        this.logKb.error(`fatal: ${evt.error?.message ?? 'unknown'}`)
        break
      }

      /* ---------------- Noise suppressed ---------------------------- */
      case 'keyboard-queue-depth':
      case 'keyboard-operation-queued':
      case 'keyboard-operation-started':
      case 'keyboard-operation-progress':
      case 'keyboard-operation-completed':
      case 'keyboard-debug-line': {
        break
      }

      default: {
        break
      }
    }
  }
}

// ---- Fanout sink: logger + state adapter -----------------------------------

class FanoutPS2KeyboardEventSink implements PS2KeyboardEventSink {
  private readonly sinks: PS2KeyboardEventSink[]

  constructor(...sinks: PS2KeyboardEventSink[]) {
    this.sinks = sinks
  }

  publish(evt: PS2KeyboardEvent): void {
    for (const sink of this.sinks) {
      try {
        sink.publish(evt)
      } catch {
        // Swallow per-sink errors so a bad consumer doesn’t break the service.
      }
    }
  }
}

// ---- Plugin implementation -------------------------------------------------

const ps2KeyboardPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  const env = process.env
  const { channel } = createLogger('ps2-keyboard-plugin', app.clientBuf)
  const logPlugin = channel(LogChannel.app)

  // 1) Build config
  const cfg = buildPS2KeyboardConfigFromEnv(env)

  // 2) Instantiate sinks
  const loggerSink = new PS2KeyboardLoggerEventSink(app)
  const stateAdapter = new PS2KeyboardStateAdapter()

  const events: PS2KeyboardEventSink = new FanoutPS2KeyboardEventSink(
    loggerSink,
    {
      publish(evt: PS2KeyboardEvent): void {
        stateAdapter.handle(evt)
        // Mirror into global AppState so panes can observe keyboard status.
        updatePS2KeyboardSnapshot(stateAdapter.getState())
      },
    }
  )

  // 3) Instantiate service
  // NOTE: service constructor is expected to accept { events } like other device services.
  const kb = new PS2KeyboardService(cfg, { events } as any)

  app.decorate('ps2Keyboard', kb)

  // 4) Lifecycle hooks
  app.addHook('onReady', async () => {
    logPlugin.info('starting ps2 keyboard service')
    await kb.start()
  })

  app.addHook('onClose', async () => {
    logPlugin.info('stopping ps2 keyboard service')
    await kb.stop().catch((err: unknown) => {
      logPlugin.warn('error stopping ps2 keyboard service', {
        err: (err as Error).message,
      })
    })
  })
}

export default fp(ps2KeyboardPlugin, {
  name: 'ps2-keyboard-plugin',
})
