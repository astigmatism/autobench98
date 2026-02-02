// services/orchestrator/src/plugins/powerMeter.ts

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import {
    createLogger,
    LogChannel,
    type ClientLogBuffer,
} from '@autobench98/logging'

import { SerialPowerMeterService } from '../devices/serial-powermeter/SerialPowerMeterService.js'
import {
    type PowerMeterEvent,
    type PowerMeterEventSink,
} from '../devices/serial-powermeter/types.js'
import { buildPowerMeterConfigFromEnv } from '../devices/serial-powermeter/utils.js'
import { PowerMeterStateAdapter } from '../adapters/powerMeter.adapter.js'

// ---- Fastify decoration ----------------------------------------------------

declare module 'fastify' {
    interface FastifyInstance {
        powerMeter: SerialPowerMeterService
        clientBuf: ClientLogBuffer
    }
}

// ---- Event sink using orchestrator logging ---------------------------------

class PowerMeterLoggerEventSink implements PowerMeterEventSink {
    private readonly logPm: ReturnType<ReturnType<typeof createLogger>['channel']>

    constructor(app: FastifyInstance) {
        const { channel } = createLogger('power-meter', app.clientBuf)
        this.logPm = channel(LogChannel.powermeter)
    }

    publish(evt: PowerMeterEvent): void {
        const ts = new Date(evt.at).toISOString()

        switch (evt.kind) {
            case 'meter-sample': {
                // High frequency -> NO log at all (avoid flooding client + server)
                break
            }

            case 'meter-device-identified': {
                const { id, path, baudRate } = evt as any
                this.logPm.info(
                    `kind=${evt.kind} id=${id ?? 'unknown'} path=${path ?? 'unknown'} baud=${baudRate ?? 'unknown'}`
                )
                break
            }

            case 'meter-device-connected': {
                const { path, baudRate } = evt as any
                this.logPm.info(
                    `kind=${evt.kind} path=${path ?? 'unknown'} baud=${baudRate ?? 'unknown'}`
                )
                break
            }

            case 'meter-device-disconnected': {
                const { path, reason } = evt as any
                this.logPm.warn(
                    `kind=${evt.kind} path=${path ?? 'unknown'} reason=${reason ?? 'unknown'}`
                )
                break
            }

            case 'meter-device-lost': {
                const { id } = evt as any
                this.logPm.warn(
                    `kind=${evt.kind} id=${id ?? 'unknown'}`
                )
                break
            }

            case 'recoverable-error': {
                const { error } = evt as any
                this.logPm.warn(
                    `kind=${evt.kind} error=${error ?? 'unknown'}`
                )
                break
            }

            case 'fatal-error': {
                const { error } = evt as any
                this.logPm.error(
                    `kind=${evt.kind} error=${error ?? 'unknown'}`
                )
                break
            }

            case 'recording-started': {
                const { recorderId } = evt as any
                this.logPm.info(
                    `kind=${evt.kind} recorderId=${recorderId ?? 'unknown'}`
                )
                break
            }

            case 'recording-finished': {
                const { recorderId } = evt as any
                this.logPm.info(
                    `kind=${evt.kind} recorderId=${recorderId ?? 'unknown'}`
                )
                break
            }

            case 'recording-cancelled': {
                const { recorderId, reason } = evt as any
                this.logPm.info(
                    `kind=${evt.kind} recorderId=${recorderId ?? 'unknown'} reason=${reason ?? 'unknown'}`
                )
                break
            }

            case 'meter-control-line': {
                const line = (evt as any).line ?? ''
                this.logPm.debug(`kind=${evt.kind} line=${JSON.stringify(line)}`)
                break
            }

            case 'meter-unknown-line': {
                const line = (evt as any).line ?? ''
                this.logPm.debug(`kind=${evt.kind} line=${JSON.stringify(line)}`)
                break
            }

            default: {
                // Fallback for any future event kinds
                this.logPm.info(`kind=${(evt as any).kind ?? 'unknown'}`)
                break
            }
        }
    }
}

// ---- Fanout sink: logger + state adapter -----------------------------------

class FanoutPowerMeterEventSink implements PowerMeterEventSink {
    private readonly sinks: PowerMeterEventSink[]

    constructor(...sinks: PowerMeterEventSink[]) {
        this.sinks = sinks
    }

    publish(evt: PowerMeterEvent): void {
        for (const sink of this.sinks) {
            try {
                sink.publish(evt)
            } catch {
                // Swallow per-sink errors so a bad consumer
                // doesn’t break the power meter service.
            }
        }
    }
}

// ---- Plugin implementation -------------------------------------------------

const powerMeterPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    const env = process.env
    const { channel } = createLogger('power-meter-plugin', app.clientBuf)
    const logPlugin = channel(LogChannel.app)

    // 1) Build config
    const pmConfig = buildPowerMeterConfigFromEnv(env)
    // logPlugin.info('power meter config built', { config: pmConfig })

    // 2) Instantiate sinks
    const loggerSink = new PowerMeterLoggerEventSink(app)
    const stateAdapter = new PowerMeterStateAdapter()

    const pmEvents: PowerMeterEventSink = new FanoutPowerMeterEventSink(
        loggerSink,
        {
            publish(evt: PowerMeterEvent): void {
                stateAdapter.handle(evt)
            },
        }
    )

    // 3) Instantiate service
    const powerMeterService = new SerialPowerMeterService(pmConfig, { events: pmEvents })

    // Expose on Fastify instance so other plugins can use it
    app.decorate('powerMeter', powerMeterService)

    // 4) Lifecycle hooks: start/stop the service
    app.addHook('onReady', async () => {
        logPlugin.info('starting power meter service')
        await powerMeterService.start()
    })

    app.addHook('onClose', async () => {
        logPlugin.info('stopping power meter service')
        await powerMeterService.stop().catch((err: unknown) => {
            logPlugin.warn('error stopping power meter service', {
                err: (err as Error).message,
            })
        })
    })
}

export default fp(powerMeterPlugin, {
    name: 'power-meter-plugin',
})