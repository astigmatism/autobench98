// services/orchestrator/src/plugins/ps2Keyboard.ts

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { createLogger, LogChannel, type ClientLogBuffer } from '@autobench98/logging'

import { PS2KeyboardService } from '../devices/ps2-keyboard/PS2KeyboardService.js'
import type { PS2KeyboardEvent, KeyboardPowerState } from '../devices/ps2-keyboard/types.js'
import { buildPS2KeyboardConfigFromEnv } from '../devices/ps2-keyboard/utils.js'
import { PS2KeyboardStateAdapter } from '../adapters/ps2Keyboard.adapter.js'
import { updatePS2KeyboardSnapshot, subscribeSlice } from '../core/state.js'

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

  private hex2(n: number): string {
    return n.toString(16).padStart(2, '0')
  }

  private fmtScan(scan?: { prefix?: number; code: number } | null): string {
    if (!scan) return '00:00'
    const p = scan.prefix ?? 0x00
    const c = scan.code ?? 0x00
    return `${this.hex2(p)}:${this.hex2(c)}`
  }

  /**
   * Safety: keep serial-emitted firmware lines readable without accidentally
   * injecting control characters into the log stream.
   *
   * IMPORTANT:
   * - If the line is plain printable text (typical Arduino logs), we keep it verbatim.
   * - If it contains control chars, we replace them with \xNN escapes.
   */
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

  // ---- Firmware-line enrichment (meaningful unknowns) --------------------

  private decodeHostCommand(byte: number): string | null {
    // This is a host->keyboard command decode table (not scan codes).
    // It is intentionally conservative: only list bytes that are defined as commands
    // and commonly appear during init sequences.
    switch (byte) {
      case 0xff:
        return 'RESET'
      case 0xfe:
        return 'RESEND'
      case 0xf2:
        return 'IDENTIFY'
      case 0xed:
        return 'SET_LEDS'
      case 0xee:
        return 'ECHO'
      case 0xf0:
        return 'SET_SCAN_CODE_SET'
      case 0xf3:
        return 'SET_TYPEMATIC_RATE_DELAY'
      case 0xf4:
        return 'ENABLE_SCANNING'
      case 0xf5:
        return 'DISABLE_SCANNING'
      case 0xf6:
        return 'SET_DEFAULTS'
      default:
        return null
    }
  }

  private parseHexByte(s: string): number | null {
    const t = s.trim().toLowerCase().replace(/^0x/, '')
    if (!/^[0-9a-f]{1,2}$/.test(t)) return null
    const n = Number.parseInt(t, 16)
    if (!Number.isFinite(n) || n < 0 || n > 255) return null
    return n
  }

  /**
   * Convert Arduino sketch debug lines into *meaningful* messages:
   *
   * - "debug: keyboard sim recieved 0xNN" => (PS/2 host->kbd <decoded-name>|UNKNOWN_CMD_OR_DATA)
   * - "debug: received unknown command NN" => (PS/2 host->kbd UNHANDLED_BY_FIRMWARE)
   * - "debug: keyboard sim recieved unknown: NN" => (PS/2 read failed; value unreliable)
   *
   * Rationale:
   * In the sketch you provided:
   * - "recieved unknown: NN" is printed when keyboard.read(...) failed; NN is not trustworthy.
   * - "received unknown command NN" is a real successfully-read byte that fell into default:.
   */
  private enrichFirmwareLine(rawLine: string): string {
    const safe = this.fmtFirmwareLine(rawLine)

    // 1) Read success line: "debug: keyboard sim recieved 0xff"
    {
      const m =
        rawLine.match(/^\s*debug:\s*keyboard sim recieved\s+0x([0-9a-fA-F]{1,2})\s*$/) ??
        rawLine.match(/^\s*debug:\s*keyboard sim recieved\s+0x([0-9a-fA-F]{1,2})\b/)
      if (m) {
        const b = this.parseHexByte(m[1])
        if (b == null) return safe
        const name = this.decodeHostCommand(b)
        if (name) return `${safe} (PS/2 host->kbd ${name})`
        return `${safe} (PS/2 host->kbd UNKNOWN_CMD_OR_DATA)`
      }
    }

    // 2) "Unknown command" (real byte, unhandled in firmware):
    //    "debug: received unknown command 2"
    {
      const m =
        rawLine.match(/^\s*debug:\s*received unknown command\s+([0-9a-fA-F]{1,2})\s*$/) ??
        rawLine.match(/^\s*debug:\s*received unknown command\s+([0-9a-fA-F]{1,2})\b/)
      if (m) {
        const b = this.parseHexByte(m[1])
        if (b == null) return `${safe} (PS/2 host->kbd UNHANDLED_BY_FIRMWARE)`
        const name = this.decodeHostCommand(b)
        if (name) return `${safe} (PS/2 host->kbd ${name}; UNHANDLED_BY_FIRMWARE)`
        return `${safe} (PS/2 host->kbd UNHANDLED_BY_FIRMWARE)`
      }
    }

    // 3) Read failure line: "debug: keyboard sim recieved unknown: ff"
    {
      const m =
        rawLine.match(/^\s*debug:\s*keyboard sim recieved unknown:\s*([0-9a-fA-F]{1,2})\s*$/) ??
        rawLine.match(/^\s*debug:\s*keyboard sim recieved unknown:\s*([0-9a-fA-F]{1,2})\b/)
      if (m) {
        const b = this.parseHexByte(m[1])
        if (b == null) return `${safe} (PS/2 read failed; value unreliable)`
        const name = this.decodeHostCommand(b)
        if (name) return `${safe} (PS/2 read failed; value unreliable; looks like ${name})`
        return `${safe} (PS/2 read failed; value unreliable)`
      }
    }

    return safe
  }

  publish(evt: PS2KeyboardEvent): void {
    switch (evt.kind) {
      /* ---------------- Lifecycle / identification ------------------ */
      case 'keyboard-device-identified': {
        this.logKb.info(`kind=${evt.kind} path=${evt.path} baud=${evt.baudRate}`)
        break
      }
      case 'keyboard-device-connected': {
        this.logKb.info(`kind=${evt.kind} path=${evt.path} baud=${evt.baudRate}`)
        break
      }
      case 'keyboard-device-disconnected': {
        this.logKb.warn(`kind=${evt.kind} path=${evt.path} reason=${evt.reason}`)
        break
      }
      case 'keyboard-device-lost': {
        this.logKb.warn(`kind=${evt.kind} id=${evt.id}`)
        break
      }
      case 'keyboard-identify-start': {
        this.logKb.info(`kind=${evt.kind} path=${evt.path}`)
        break
      }
      case 'keyboard-identify-success': {
        this.logKb.info(`kind=${evt.kind} token=${evt.token}`)
        break
      }
      case 'keyboard-identify-failed': {
        this.logKb.warn(`kind=${evt.kind} error=${evt.error?.message ?? 'unknown'}`)
        break
      }

      /* ---------------- Power -------------------------------------- */
      case 'keyboard-power-changed': {
        this.logKb.info(`kind=${evt.kind} power=${evt.power}`)
        break
      }

      /* ---------------- High-signal key activity -------------------- */
      case 'keyboard-key-action': {
        const code = evt.identity?.code ?? 'unknown'
        const key = evt.identity?.key ?? 'unknown'
        const scan = this.fmtScan(evt.scan as any)

        this.logKb.info(
          `kind=${evt.kind} action=${evt.action} code=${code} key=${key} scan=${scan}`
        )
        break
      }

      /* ---------------- Firmware/Arduino-emitted sequence lines ------ */
    case 'keyboard-debug-line': {
        const raw = String(evt.line ?? '')
        const line = this.enrichFirmwareLine(raw).trim()
        if (!line) break

        // Keep it single-line + key=value, like the rest of the system.
        // If you later decide "done:" is too noisy, we can downshift those to debug.
        this.logKb.info(`kind=kb-fireware line=${JSON.stringify(line)}`)
        break
    }


      /* ---------------- Failures / cancellations / errors ----------- */
      case 'keyboard-operation-cancelled': {
        this.logKb.warn(`kind=${evt.kind} opId=${evt.opId} reason=${evt.reason}`)
        break
      }
      case 'keyboard-operation-failed': {
        this.logKb.warn(
          `kind=${evt.kind} opId=${evt.result?.id ?? 'unknown'} error=${evt.result?.error?.message ?? 'unknown'}`
        )
        break
      }
      case 'recoverable-error': {
        this.logKb.warn(`kind=${evt.kind} error=${evt.error?.message ?? 'unknown'}`)
        break
      }
      case 'fatal-error': {
        this.logKb.error(`kind=${evt.kind} error=${evt.error?.message ?? 'unknown'}`)
        break
      }

      /* ---------------- Noise suppressed ---------------------------- */
      case 'keyboard-queue-depth':
      case 'keyboard-operation-queued':
      case 'keyboard-operation-started':
      case 'keyboard-operation-progress':
      case 'keyboard-operation-completed': {
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

/* -------------------------------------------------------------------------- */
/*  Host power coordination (frontPanel -> keyboard)                           */
/*                                                                            */
/*  Decisions you made:                                                        */
/*  - powerSense='unknown' => fail-open (do not block)                         */
/*  - when powerSense transitions to OFF, drop queued key operations           */
/*                                                                            */
/*  Safety-critical note: until we verify the exact FrontPanel powerSense      */
/*  string literals, we only treat the exact strings 'on' and 'off' as known.  */
/* -------------------------------------------------------------------------- */

function mapFrontPanelPowerSenseToHostPower(powerSense: unknown): KeyboardPowerState {
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
        updatePS2KeyboardSnapshot(stateAdapter.getState())
      },
    }
  )

  // 3) Instantiate service
  const kb = new PS2KeyboardService(cfg, { events } as any)
  app.decorate('ps2Keyboard', kb)

  // 3.1) Subscribe to host power (frontPanel slice) and propagate into service
  let lastHostPower: KeyboardPowerState = 'unknown'

  const applyHostPower = (frontPanelSlice: unknown, why: string) => {
    const fp = frontPanelSlice as { powerSense?: unknown } | null | undefined
    const powerSense = fp?.powerSense
    const hostPower = mapFrontPanelPowerSenseToHostPower(powerSense)

    if (hostPower === lastHostPower) return
    const prev = lastHostPower
    lastHostPower = hostPower

    // Policy enforcement is inside the service (including dropping queued key ops on 'off').
    kb.setHostPower(hostPower)

    if (hostPower === 'off') {
        logPlugin.warn(
            `host power is OFF; keyboard key ops will be dropped from=${prev} to=${hostPower} powerSense=${fmt(powerSense)} why=${why}`
        )
        } else {
        logPlugin.info(
            `host power updated for keyboard service from=${prev} to=${hostPower} powerSense=${fmt(powerSense)} why=${why}`
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
    logPlugin.info('starting ps2 keyboard service')
    await kb.start()
  })

  app.addHook('onClose', async () => {
    // Remove listeners first (prevents late state-driven calls during shutdown).
    unsubscribeFrontPanel()

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
