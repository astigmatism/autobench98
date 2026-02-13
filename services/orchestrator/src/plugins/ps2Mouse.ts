// services/orchestrator/src/plugins/ps2Mouse.ts
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { createLogger, LogChannel, type ClientLogBuffer } from '@autobench98/logging'

import { PS2MouseService } from '../devices/ps2-mouse/PS2MouseService.js'
import type { PS2MouseConfig, PS2MouseEvent, MousePowerState } from '../devices/ps2-mouse/types.js'
import { buildPS2MouseConfigFromEnv } from '../devices/ps2-mouse/utils.js'
import { peekSlice, subscribeSlice, updatePS2MouseSnapshot } from '../core/state.js'
import { createPS2MouseAdapter, type PS2MouseEventSink } from '../adapters/ps2Mouse.adapter.js'

declare module 'fastify' {
  interface FastifyInstance {
    ps2Mouse: PS2MouseService
    ps2MouseConfig: PS2MouseConfig
    clientBuf: ClientLogBuffer

    /**
     * Serial discovery integration point:
     * serial plugin (or any discovery code) should call this when it identifies
     * the PS/2 mouse Arduino.
     */
    ps2MouseOnDeviceIdentified: (args: { id: string; path: string; baudRate?: number }) => Promise<void>

    /**
     * Serial discovery integration point:
     * serial plugin (or any discovery code) should call this when the identified
     * device is lost.
     */
    ps2MouseOnDeviceLost: (args: { id: string }) => Promise<void>

    /**
     * Host power integration point:
     * front-panel/state layer should call this as power sense changes.
     *
     * Service expects: 'on' | 'off' | 'unknown'
     */
    ps2MouseSetHostPower: (power: MousePowerState) => void
  }
}

/* -------------------------------------------------------------------------- */
/*  Logger sink (client-visible via clientBuf)                                */
/* -------------------------------------------------------------------------- */

class PS2MouseLoggerEventSink implements PS2MouseEventSink {
  private readonly logMouse: ReturnType<ReturnType<typeof createLogger>['channel']>

  // Log policy toggles (env-controlled)
  private readonly logOpLifecycle: boolean
  private readonly logQueueDepth: boolean
  private readonly logMoveTick: boolean
  private readonly firmwareLevel: 'off' | 'debug' | 'info'

  constructor(app: FastifyInstance) {
    const { channel } = createLogger('ps2-mouse', app.clientBuf)

    // Prefer a dedicated channel if it exists; fall back safely.
    const ch = ((LogChannel as any).mouse ?? (LogChannel as any).keyboard ?? LogChannel.app) as any
    this.logMouse = channel(ch)

    const env = process.env

    // Defaults are QUIET (no lifecycle bookkeeping spam).
    // Turn on when debugging queue/backlog behavior.
    this.logOpLifecycle = env.AB_LOG_PS2_MOUSE_OPS === '1'
    this.logQueueDepth = env.AB_LOG_PS2_MOUSE_QUEUE === '1'
    this.logMoveTick = env.AB_LOG_PS2_MOUSE_MOVE_TICK === '1'

    // Firmware serial prints are chatty by design; default them to DEBUG.
    const fw = String(env.AB_LOG_PS2_MOUSE_FIRMWARE ?? 'debug').toLowerCase()
    this.firmwareLevel = fw === 'off' || fw === '0' ? 'off' : fw === 'info' ? 'info' : 'debug'
  }

  publish(evt: PS2MouseEvent): void {
    // IMPORTANT:
    // Your PS2MouseEvent.kind union may be narrower than runtime.
    // Switching on a string avoids TS rejecting legitimate runtime kinds.
    const e = evt as any
    const kind = String(e?.kind ?? '')

    // ------------------------------------------------------------------
    // Hard allowlist / policy gates for known-noisy bookkeeping events
    // ------------------------------------------------------------------

    if (
      kind === 'mouse-operation-queued' ||
      kind === 'mouse-operation-started' ||
      kind === 'mouse-operation-progress' ||
      kind === 'mouse-operation-completed'
    ) {
      if (!this.logOpLifecycle) return
      this.logMouse.debug(`kind=${kind}`)
      return
    }

    if (kind === 'mouse-queue-depth') {
      if (!this.logQueueDepth) return
      this.logMouse.debug(`kind=${kind} depth=${e?.depth ?? '—'}`)
      return
    }

    if (kind === 'mouse-move-tick') {
      if (!this.logMoveTick) return
      this.logMouse.debug(
        `kind=${kind} mode=${e?.mode ?? '—'} x=${e?.x ?? '—'} y=${e?.y ?? '—'} dx=${e?.dx ?? '—'} dy=${e?.dy ?? '—'}`
      )
      return
    }

    // ------------------------------------------------------------------
    // Firmware line handling (mouse Arduino Serial.println)
    // ------------------------------------------------------------------

    if (kind === 'mouse-debug-line') {
      const raw = String(e?.line ?? '')
      const line = this.fmtFirmwareLine(raw).trim()
      if (!line) return

      // Escalate “bad” firmware lines regardless of requested level
      const lower = line.toLowerCase()
      const looksBad =
        lower.includes('failed') ||
        lower.includes('error') ||
        lower.includes('timeout') ||
        lower.includes('unknown') ||
        lower.includes('unreliable')

      if (looksBad) {
        this.logMouse.warn(`kind=ms-firmware line=${JSON.stringify(line)}`)
        return
      }

      // Quiet by default: firmware chatter goes to debug unless user asks for info.
      if (this.firmwareLevel === 'off') return
      if (this.firmwareLevel === 'info') {
        this.logMouse.info(`kind=ms-firmware line=${JSON.stringify(line)}`)
      } else {
        this.logMouse.debug(`kind=ms-firmware line=${JSON.stringify(line)}`)
      }
      return
    }

    // ------------------------------------------------------------------
    // Always-surface events (actionable / important)
    // ------------------------------------------------------------------

    if (kind === 'fatal-error') {
      this.logMouse.error(`kind=${kind} error=${e?.error?.message ?? 'unknown'}`)
      return
    }

    if (kind === 'recoverable-error') {
      this.logMouse.warn(`kind=${kind} error=${e?.error?.message ?? 'unknown'}`)
      return
    }

    if (kind === 'mouse-operation-cancelled') {
      // Cancellations are meaningful when debugging power policy; keep as warn.
      const opId = e?.opId ?? e?.id ?? e?.result?.id ?? 'unknown'
      const reason = e?.reason ?? 'cancelled'
      this.logMouse.warn(`kind=${kind} opId=${opId} reason=${reason}`)
      return
    }

    if (kind === 'mouse-operation-failed') {
      const opId = e?.result?.id ?? e?.opId ?? e?.id ?? 'unknown'
      const err = e?.result?.error?.message ?? e?.error?.message ?? 'unknown'
      this.logMouse.warn(`kind=${kind} opId=${opId} error=${err}`)
      return
    }

    if (kind === 'mouse-button') {
      this.logMouse.info(
        `kind=${kind} button=${e?.button ?? '—'} action=${e?.action ?? '—'}${e?.noOp ? ` noOp=true reason=${e?.noOpReason ?? '—'}` : ''}`
      )
      return
    }

    if (kind === 'mouse-wheel') {
      this.logMouse.info(`kind=${kind} dy=${e?.dy ?? '—'}`)
      return
    }

    if (kind === 'mouse-config-applied') {
      this.logMouse.info(`kind=${kind}`)
      return
    }

    if (kind === 'mouse-device-disconnected') {
      this.logMouse.warn(`kind=${kind} id=${e?.id} path=${e?.path} reason=${e?.reason}`)
      return
    }

    if (kind === 'mouse-device-connected') {
      this.logMouse.info(`kind=${kind} id=${e?.id} path=${e?.path} baud=${e?.baudRate}`)
      return
    }

    if (kind === 'mouse-device-identified') {
      this.logMouse.info(`kind=${kind} id=${e?.id} path=${e?.path} baud=${e?.baudRate} token=${e?.token}`)
      return
    }

    if (kind === 'mouse-identify-failed') {
      this.logMouse.warn(`kind=${kind} error=${e?.error?.message ?? 'unknown'}`)
      return
    }

    if (kind === 'mouse-identify-start') {
      this.logMouse.info(`kind=${kind} path=${e?.path}`)
      return
    }

    if (kind === 'mouse-identify-success') {
      this.logMouse.info(`kind=${kind} token=${e?.token}`)
      return
    }

    if (kind === 'mouse-device-lost') {
      this.logMouse.warn(`kind=${kind} id=${e?.id}`)
      return
    }

    if (kind === 'mouse-host-power-changed') {
      this.logMouse.info(`kind=${kind} prev=${e?.prev} power=${e?.power} why=${e?.why}`)
      return
    }

    // Default: keep unknown events visible, but not loud.
    this.logMouse.debug(`kind=${kind}`)
  }

  private fmtFirmwareLine(line: string): string {
    let needsEscape = false
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i)
      // allow tab; everything else < 0x20 or DEL treated as control
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
}


/* -------------------------------------------------------------------------- */
/*  Fanout sink: logger + state adapter                                       */
/* -------------------------------------------------------------------------- */

class FanoutPS2MouseEventSink implements PS2MouseEventSink {
  private readonly sinks: PS2MouseEventSink[]

  constructor(...sinks: PS2MouseEventSink[]) {
    this.sinks = sinks
  }

  publish(evt: PS2MouseEvent): void {
    for (const sink of this.sinks) {
      try {
        sink.publish(evt)
      } catch {
        // Never let sink failures affect device control.
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Host power coordination (frontPanel -> mouse)                             */
/* -------------------------------------------------------------------------- */

function mapFrontPanelPowerSenseToHostPower(powerSense: unknown): MousePowerState {
  if (powerSense === 'off') return 'off'
  if (powerSense === 'on') return 'on'
  return 'unknown'
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (v == null) return 'null'
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

const ps2MousePlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  const env = process.env
  const { channel } = createLogger('ps2-mouse-plugin', app.clientBuf)
  const logPlugin = channel(LogChannel.app)

  // 1) Build config
  const cfg = buildPS2MouseConfigFromEnv(env)

  // 1.1) Reflect config defaults into AppState immediately (merge, do not replace)
  updatePS2MouseSnapshot({
    mode: cfg.movement.defaultMode,
    gain: Math.max(1, Math.trunc(cfg.movement.relativeGain.gain)),
    accel: {
      enabled: !!cfg.movement.accel.enabled,
      baseGain: Math.max(1, Math.trunc(cfg.movement.accel.baseGain)),
      maxGain: Math.max(1, Math.trunc(cfg.movement.accel.maxGain)),
      velocityPxPerSecForMax: Math.max(1, Math.trunc(cfg.movement.accel.velocityPxPerSecForMax)),
    },
    absoluteGrid:
      cfg.movement.absoluteGrid.mode === 'fixed'
        ? {
            mode: 'fixed',
            fixed: cfg.movement.absoluteGrid.fixed,
            resolved: { w: cfg.movement.absoluteGrid.fixed.w, h: cfg.movement.absoluteGrid.fixed.h },
          }
        : { mode: 'auto', resolved: undefined },
    mappingStatus: cfg.movement.absoluteGrid.mode === 'fixed' ? 'ok' : 'unknown-resolution',
  })

  // 2) Instantiate sinks
  const loggerSink = new PS2MouseLoggerEventSink(app)

  // Use the existing reducer adapter EXACTLY as provided.
const stateAdapter = createPS2MouseAdapter({
  initial: peekSlice('ps2Mouse') as any,
  onSlice: (next) => updatePS2MouseSnapshot(next),

  // Default: suppress state churn unless explicitly enabled
  suppressQueueDepth: process.env.AB_STATE_PS2_MOUSE_QUEUE !== '1',
  suppressMoveTicks: process.env.AB_STATE_PS2_MOUSE_MOVE_TICK !== '1',
})

  const events: PS2MouseEventSink = new FanoutPS2MouseEventSink(loggerSink, stateAdapter.sink)

  // 3) Instantiate service (structural sink typing; shape matches)
  const svc = new PS2MouseService(cfg, { events } as any)

  app.decorate('ps2Mouse', svc)
  app.decorate('ps2MouseConfig', cfg)

  // Serial discovery integration points
  app.decorate('ps2MouseOnDeviceIdentified', async (args: { id: string; path: string; baudRate?: number }) => {
    await svc.onDeviceIdentified(args)
  })

  app.decorate('ps2MouseOnDeviceLost', async (args: { id: string }) => {
    await svc.onDeviceLost(args)
  })

  // External host-power integration point
  app.decorate('ps2MouseSetHostPower', (power: MousePowerState) => {
    svc.setHostPower(power, 'external')
  })

  // 3.1) Subscribe to host power (frontPanel slice) and propagate into service
  let lastHostPower: MousePowerState = 'unknown'

  const applyHostPower = (frontPanelSlice: unknown, why: string) => {
    const fp = frontPanelSlice as { powerSense?: unknown } | null | undefined
    const powerSense = fp?.powerSense
    const hostPower = mapFrontPanelPowerSenseToHostPower(powerSense)

    if (hostPower === lastHostPower) return

    const prev = lastHostPower
    lastHostPower = hostPower

    svc.setHostPower(hostPower, why)

    // Logger is string-first in this codebase; include metadata in the message string.
    if (hostPower === 'off') {
      logPlugin.warn(
        `host power is OFF; mouse movement + discrete ops will be suppressed/cancelled by service policy ` +
          `from=${prev} to=${hostPower} powerSense=${fmt(powerSense)} why=${why}`
      )
    } else {
      logPlugin.info(
        `host power updated for ps2 mouse service ` +
          `from=${prev} to=${hostPower} powerSense=${fmt(powerSense)} why=${why}`
      )
    }
  }

  const unsubscribeFrontPanel = subscribeSlice(
    'frontPanel',
    (slice, evt) => {
      const why = evt.patch.length === 0 ? 'state.initial' : 'state.patch'
      applyHostPower(slice as unknown, why)
    },
    { emitInitial: true }
  )

  // 4) Lifecycle hooks
  app.addHook('onReady', async () => {
    logPlugin.info('starting ps2 mouse service')
    await svc.start()
  })

  app.addHook('onClose', async () => {
    unsubscribeFrontPanel()

    logPlugin.info('stopping ps2 mouse service')
    await svc.stop().catch((err: unknown) => {
      logPlugin.warn(`error stopping ps2 mouse service err=${(err as any)?.message ?? String(err)}`)
    })
  })
}

export default fp(ps2MousePlugin, { name: 'ps2-mouse' })
