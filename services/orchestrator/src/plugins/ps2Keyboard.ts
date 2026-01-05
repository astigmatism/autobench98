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
        // Use device channel to avoid relying on a potentially-missing dedicated enum entry.
        this.logKb = channel(LogChannel.device)
    }

    publish(evt: PS2KeyboardEvent): void {
        const ts = new Date((evt as any).at ?? Date.now()).toISOString()

        switch (evt.kind) {
            /* ---------------- Device lifecycle --------------------------- */
            case 'keyboard-device-identified': {
                const { id, path, baudRate } = evt as any
                this.logKb.info(
                    `ts=${ts} kind=${evt.kind} id=${id ?? 'unknown'} path=${path ?? 'unknown'} baud=${baudRate ?? 'unknown'}`
                )
                break
            }

            case 'keyboard-device-connected': {
                const { path, baudRate } = evt as any
                this.logKb.info(
                    `ts=${ts} kind=${evt.kind} path=${path ?? 'unknown'} baud=${baudRate ?? 'unknown'}`
                )
                break
            }

            case 'keyboard-device-disconnected': {
                const { path, reason } = evt as any
                this.logKb.warn(
                    `ts=${ts} kind=${evt.kind} path=${path ?? 'unknown'} reason=${reason ?? 'unknown'}`
                )
                break
            }

            case 'keyboard-device-lost': {
                const { id } = evt as any
                this.logKb.warn(`ts=${ts} kind=${evt.kind} id=${id ?? 'unknown'}`)
                break
            }

            /* ---------------- Identification ---------------------------- */
            case 'keyboard-identify-start': {
                this.logKb.info(`ts=${ts} kind=${evt.kind}`)
                break
            }

            case 'keyboard-identify-success': {
                this.logKb.info(`ts=${ts} kind=${evt.kind}`)
                break
            }

            case 'keyboard-identify-failed': {
                const { error } = evt as any
                this.logKb.warn(
                    `ts=${ts} kind=${evt.kind} error=${error?.message ?? 'unknown'}`
                )
                break
            }

            /* ---------------- Power / queue / operations ----------------- */
            case 'keyboard-power-changed': {
                const { power } = evt as any
                this.logKb.info(`ts=${ts} kind=${evt.kind} power=${power ?? 'unknown'}`)
                break
            }

            case 'keyboard-queue-depth': {
                const { depth } = evt as any
                this.logKb.debug(`ts=${ts} kind=${evt.kind} depth=${depth ?? 'unknown'}`)
                break
            }

            case 'keyboard-operation-queued': {
                const { op } = evt as any
                this.logKb.info(
                    `ts=${ts} kind=${evt.kind} opId=${op?.id ?? 'unknown'} type=${op?.type ?? 'unknown'}`
                )
                break
            }

            case 'keyboard-operation-started': {
                const { opId } = evt as any
                this.logKb.info(`ts=${ts} kind=${evt.kind} opId=${opId ?? 'unknown'}`)
                break
            }

            case 'keyboard-operation-progress': {
                // High-frequency; debug only (and still potentially noisy).
                const { opId, progress } = evt as any
                this.logKb.debug(
                    `ts=${ts} kind=${evt.kind} opId=${opId ?? 'unknown'} progress=${progress ?? 'unknown'}`
                )
                break
            }

            case 'keyboard-operation-completed': {
                const { result } = evt as any
                this.logKb.info(
                    `ts=${ts} kind=${evt.kind} opId=${result?.id ?? 'unknown'} status=${result?.status ?? 'unknown'}`
                )
                break
            }

            case 'keyboard-operation-cancelled': {
                const { opId, reason } = evt as any
                this.logKb.warn(
                    `ts=${ts} kind=${evt.kind} opId=${opId ?? 'unknown'} reason=${reason ?? 'unknown'}`
                )
                break
            }

            case 'keyboard-operation-failed': {
                const { result } = evt as any
                this.logKb.warn(
                    `ts=${ts} kind=${evt.kind} opId=${result?.id ?? 'unknown'} error=${result?.error?.message ?? 'unknown'}`
                )
                break
            }

            /* ---------------- Errors ------------------------------------- */
            case 'recoverable-error': {
                const { error } = evt as any
                this.logKb.warn(
                    `ts=${ts} kind=${evt.kind} error=${error?.message ?? 'unknown'}`
                )
                break
            }

            case 'fatal-error': {
                const { error } = evt as any
                this.logKb.error(
                    `ts=${ts} kind=${evt.kind} error=${error?.message ?? 'unknown'}`
                )
                break
            }

            /* ---------------- Debug -------------------------------------- */
            case 'keyboard-debug-line': {
                const { line } = evt as any
                this.logKb.debug(
                    `ts=${ts} kind=${evt.kind} line=${JSON.stringify(line ?? '')}`
                )
                break
            }

            default: {
                // Future-proof fallback
                this.logKb.info(`ts=${ts} kind=${(evt as any).kind ?? 'unknown'}`)
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
