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

    publish(evt: PS2KeyboardEvent): void {
        const ts = new Date((evt as any).at ?? Date.now()).toISOString()

        switch (evt.kind) {
            /* ---------------- Lifecycle / identification ------------------ */
            case 'keyboard-device-identified': {
                this.logKb.info(
                    `ts=${ts} kind=${evt.kind} id=${evt.id} path=${evt.path} baud=${evt.baudRate}`
                )
                break
            }

            case 'keyboard-device-connected': {
                this.logKb.info(
                    `ts=${ts} kind=${evt.kind} path=${evt.path} baud=${evt.baudRate}`
                )
                break
            }

            case 'keyboard-device-disconnected': {
                this.logKb.warn(
                    `ts=${ts} kind=${evt.kind} path=${evt.path} reason=${evt.reason}`
                )
                break
            }

            case 'keyboard-device-lost': {
                this.logKb.warn(`ts=${ts} kind=${evt.kind} id=${evt.id}`)
                break
            }

            case 'keyboard-identify-start': {
                this.logKb.info(`ts=${ts} kind=${evt.kind} path=${evt.path}`)
                break
            }

            case 'keyboard-identify-success': {
                this.logKb.info(`ts=${ts} kind=${evt.kind} token=${evt.token}`)
                break
            }

            case 'keyboard-identify-failed': {
                this.logKb.warn(
                    `ts=${ts} kind=${evt.kind} error=${evt.error?.message ?? 'unknown'}`
                )
                break
            }

            /* ---------------- Power -------------------------------------- */
            case 'keyboard-power-changed': {
                this.logKb.info(
                    `ts=${ts} kind=${evt.kind} power=${evt.power} requestedBy=${evt.requestedBy ?? 'unknown'}`
                )
                break
            }

            /* ---------------- High-signal key activity -------------------- */
            case 'keyboard-key-action': {
                const code = evt.identity?.code ?? ''
                const key = evt.identity?.key ?? ''
                const scanPrefix = (evt.scan?.prefix ?? 0x00).toString(16).padStart(2, '0')
                const scanCode = (evt.scan?.code ?? 0x00).toString(16).padStart(2, '0')
                this.logKb.info(
                    `ts=${ts} kind=${evt.kind} action=${evt.action} code=${code || 'n/a'} key=${key || 'n/a'} scan=${scanPrefix}:${scanCode} opId=${evt.opId ?? 'unknown'} requestedBy=${evt.requestedBy ?? 'unknown'}`
                )
                break
            }

            /* ---------------- Failures / cancellations / errors ----------- */
            case 'keyboard-operation-cancelled': {
                this.logKb.warn(
                    `ts=${ts} kind=${evt.kind} opId=${evt.opId} reason=${evt.reason}`
                )
                break
            }

            case 'keyboard-operation-failed': {
                this.logKb.warn(
                    `ts=${ts} kind=${evt.kind} opId=${evt.result?.id ?? 'unknown'} error=${evt.result?.error?.message ?? 'unknown'}`
                )
                break
            }

            case 'recoverable-error': {
                this.logKb.warn(
                    `ts=${ts} kind=${evt.kind} error=${evt.error?.message ?? 'unknown'}`
                )
                break
            }

            case 'fatal-error': {
                this.logKb.error(
                    `ts=${ts} kind=${evt.kind} error=${evt.error?.message ?? 'unknown'}`
                )
                break
            }

            /* ---------------- Noise suppressed ---------------------------- */
            // Intentionally NOT logging:
            // - queue depth
            // - operation queued/started/progress/completed
            // - raw debug lines / success acks
            case 'keyboard-queue-depth':
            case 'keyboard-operation-queued':
            case 'keyboard-operation-started':
            case 'keyboard-operation-progress':
            case 'keyboard-operation-completed':
            case 'keyboard-debug-line': {
                break
            }

            default: {
                // Future-proof fallback: ignore unknown events safely.
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
