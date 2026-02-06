// services/orchestrator/src/plugins/ps2Keyboard.ts

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { createLogger, LogChannel, type ClientLogBuffer } from '@autobench98/logging'

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

    private hex2(n: number): string {
        return n.toString(16).padStart(2, '0')
    }

    private fmtScan(scan?: { prefix?: number; code: number } | null): string {
        if (!scan) return '00:00'
        const p = scan.prefix ?? 0x00
        const c = scan.code ?? 0x00
        return `${this.hex2(p)}:${this.hex2(c)}`
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

    private decodeHostCommand(byte: number): string | null {
        switch (byte) {
            case 0xff: return 'RESET'
            case 0xfe: return 'RESEND'
            case 0xf2: return 'IDENTIFY'
            case 0xed: return 'SET_LEDS'
            case 0xee: return 'ECHO'
            case 0xf0: return 'SET_SCAN_CODE_SET'
            case 0xf3: return 'SET_TYPEMATIC_RATE_DELAY'
            case 0xf4: return 'ENABLE_SCANNING'
            case 0xf5: return 'DISABLE_SCANNING'
            case 0xf6: return 'SET_DEFAULTS'
            default: return null
        }
    }

    private parseHexByte(s: string): number | null {
        const t = s.trim().toLowerCase().replace(/^0x/, '')
        if (!/^[0-9a-f]{1,2}$/.test(t)) return null
        const n = Number.parseInt(t, 16)
        if (!Number.isFinite(n) || n < 0 || n > 255) return null
        return n
    }

    private enrichFirmwareLine(rawLine: string): string {
        const safe = this.fmtFirmwareLine(rawLine)

        {
            const m = rawLine.match(/^\s*debug:\s*keyboard sim recieved\s+0x([0-9a-fA-F]{1,2})\s*$/)
                ?? rawLine.match(/^\s*debug:\s*keyboard sim recieved\s+0x([0-9a-fA-F]{1,2})\b/)
            if (m) {
                const b = this.parseHexByte(m[1])
                if (b == null) return safe
                const name = this.decodeHostCommand(b)
                if (name) return `${safe} (PS/2 host->kbd ${name})`
                return `${safe} (PS/2 host->kbd UNKNOWN_CMD_OR_DATA)`
            }
        }

        {
            const m = rawLine.match(/^\s*debug:\s*received unknown command\s+([0-9a-fA-F]{1,2})\s*$/)
                ?? rawLine.match(/^\s*debug:\s*received unknown command\s+([0-9a-fA-F]{1,2})\b/)
            if (m) {
                const b = this.parseHexByte(m[1])
                if (b == null) return `${safe} (PS/2 host->kbd UNHANDLED_BY_FIRMWARE)`
                const name = this.decodeHostCommand(b)
                if (name) return `${safe} (PS/2 host->kbd ${name}; UNHANDLED_BY_FIRMWARE)`
                return `${safe} (PS/2 host->kbd UNHANDLED_BY_FIRMWARE)`
            }
        }

        {
            const m = rawLine.match(/^\s*debug:\s*keyboard sim recieved unknown:\s*([0-9a-fA-F]{1,2})\s*$/)
                ?? rawLine.match(/^\s*debug:\s*keyboard sim recieved unknown:\s*([0-9a-fA-F]{1,2})\b/)
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
            case 'keyboard-power-changed': {
                this.logKb.info(`kind=${evt.kind} power=${evt.power}`)
                break
            }
            case 'keyboard-key-action': {
                const code = evt.identity?.code ?? 'unknown'
                const key = evt.identity?.key ?? 'unknown'
                const scan = this.fmtScan(evt.scan as any)

                this.logKb.info(
                    `kind=${evt.kind} action=${evt.action} code=${code} key=${key} scan=${scan}`
                )
                break
            }
            case 'keyboard-debug-line': {
                this.logKb.info(this.enrichFirmwareLine(evt.line))
                break
            }
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

const ps2KeyboardPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    const env = process.env
    const { channel } = createLogger('ps2-keyboard-plugin', app.clientBuf)
    const logPlugin = channel(LogChannel.app)

    const cfg = buildPS2KeyboardConfigFromEnv(env)

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

    const kb = new PS2KeyboardService(cfg, { events })

    app.decorate('ps2Keyboard', kb)

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
