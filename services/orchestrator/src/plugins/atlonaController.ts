// services/orchestrator/src/plugins/atlonaController.ts

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import {
    createLogger,
    LogChannel,
    type ClientLogBuffer,
} from '@autobench98/logging'
import { AtlonaControllerService } from '../devices/atlona-controller/AtlonaControllerService'
import { AtlonaControllerEvent, AtlonaControllerEventSink } from '../devices/atlona-controller/types'
import { buildAtlonaControllerConfigFromEnv } from '../devices/atlona-controller/utils'
import { AtlonaControllerStateAdapter } from '../adapters/atlonaController.adapter'

// ---- Fastify decoration ----------------------------------------------------

declare module 'fastify' {
    interface FastifyInstance {
        atlonaController: AtlonaControllerService
        clientBuf: ClientLogBuffer
    }
}

// ---- Event sink using orchestrator logging ---------------------------------

class AtlonaControllerLoggerEventSink implements AtlonaControllerEventSink {
    private readonly log: ReturnType<ReturnType<typeof createLogger>['channel']>

    constructor(app: FastifyInstance) {
        const { channel } = createLogger('atlona-controller', app.clientBuf)
        // Use dedicated Atlona controller channel
        this.log = channel(LogChannel.atlona_controller)
    }

    publish(evt: AtlonaControllerEvent): void {
        const ts = new Date(evt.at).toISOString()

        switch (evt.kind) {
            case 'atlona-device-identified': {
                const { id, path, baudRate } = evt as any
                this.log.info(
                    `ts=${ts} kind=${evt.kind} id=${id ?? 'unknown'} path=${path ?? 'unknown'} baud=${baudRate ?? 'unknown'}`
                )
                break
            }

            case 'atlona-device-connected': {
                const { path, baudRate } = evt as any
                this.log.info(
                    `ts=${ts} kind=${evt.kind} path=${path ?? 'unknown'} baud=${baudRate ?? 'unknown'}`
                )
                break
            }

            case 'atlona-device-disconnected': {
                const { path, reason } = evt as any
                this.log.warn(
                    `ts=${ts} kind=${evt.kind} path=${path ?? 'unknown'} reason=${reason ?? 'unknown'}`
                )
                break
            }

            case 'atlona-device-lost': {
                const { id } = evt as any
                this.log.warn(
                    `ts=${ts} kind=${evt.kind} id=${id ?? 'unknown'}`
                )
                break
            }

            case 'atlona-identified-complete': {
                this.log.info(`ts=${ts} kind=${evt.kind}`)
                break
            }

            case 'atlona-switch-held': {
                const { switchId, switchName, requestedBy } = evt as any
                this.log.info(
                    `ts=${ts} kind=${evt.kind} id=${switchId} name=${switchName} requestedBy=${requestedBy ?? 'unknown'}`
                )
                break
            }

            case 'atlona-switch-released': {
                const { switchId, switchName, requestedBy } = evt as any
                this.log.info(
                    `ts=${ts} kind=${evt.kind} id=${switchId} name=${switchName} requestedBy=${requestedBy ?? 'unknown'}`
                )
                break
            }

            case 'atlona-debug-line': {
                const line = (evt as any).line ?? ''
                this.log.debug(`ts=${ts} kind=${evt.kind} line=${JSON.stringify(line)}`)
                break
            }

            case 'recoverable-error': {
                const { error } = evt as any
                this.log.warn(
                    `ts=${ts} kind=${evt.kind} error=${error ?? 'unknown'}`
                )
                break
            }

            case 'fatal-error': {
                const { error } = evt as any
                this.log.error(
                    `ts=${ts} kind=${evt.kind} error=${error ?? 'unknown'}`
                )
                break
            }

            default: {
                this.log.info(`ts=${ts} kind=${(evt as any).kind ?? 'unknown'}`)
                break
            }
        }
    }
}

// ---- Fanout sink: logger + state adapter -----------------------------------

class FanoutAtlonaControllerEventSink implements AtlonaControllerEventSink {
    private readonly sinks: AtlonaControllerEventSink[]

    constructor(...sinks: AtlonaControllerEventSink[]) {
        this.sinks = sinks
    }

    publish(evt: AtlonaControllerEvent): void {
        for (const sink of this.sinks) {
            try {
                sink.publish(evt)
            } catch {
                // Swallow per-sink errors so a bad consumer
                // doesn’t break the controller service.
            }
        }
    }
}

// ---- Plugin implementation -------------------------------------------------

const atlonaControllerPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    const env = process.env
    const { channel } = createLogger('atlona-controller-plugin', app.clientBuf)
    // Plugin lifecycle logs also go to the Atlona channel
    const logPlugin = channel(LogChannel.atlona_controller)

    // 1) Build config
    const cfg = buildAtlonaControllerConfigFromEnv(env)

    // 2) Instantiate sinks
    const loggerSink = new AtlonaControllerLoggerEventSink(app)
    const stateAdapter = new AtlonaControllerStateAdapter()

    const events: AtlonaControllerEventSink = new FanoutAtlonaControllerEventSink(
        loggerSink,
        {
            publish(evt: AtlonaControllerEvent): void {
                stateAdapter.handle(evt)
            },
        }
    )

    // 3) Instantiate service
    const controller = new AtlonaControllerService(cfg, { events })

    app.decorate('atlonaController', controller)

    // 4) Lifecycle hooks
    app.addHook('onReady', async () => {
        logPlugin.info('starting Atlona controller service')
        await controller.start()
    })

    app.addHook('onClose', async () => {
        logPlugin.info('stopping Atlona controller service')
        await controller.stop().catch((err: unknown) => {
            logPlugin.warn('error stopping Atlona controller service', {
                err: (err as Error).message,
            })
        })
    })
}

export default fp(atlonaControllerPlugin, {
    name: 'atlona-controller-plugin',
})