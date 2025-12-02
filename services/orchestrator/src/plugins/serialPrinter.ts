// services/orchestrator/src/plugins/serialPrinter.ts

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import {
    createLogger,
    LogChannel,
    type ClientLogBuffer,
} from '@autobench98/logging'
import { SerialPrinterStateAdapter } from '../adapters/serialPrinter.adapter.js'
import { SerialPrinterService } from '../devices/serial-printer/SerialPrinterService.js'
import { SerialPrinterEvent, SerialPrinterEventSink } from '../devices/serial-printer/types.js'
import { buildSerialPrinterConfigFromEnv } from '../devices/serial-printer/utils.js'

// ---- Fastify decoration ----------------------------------------------------

declare module 'fastify' {
    interface FastifyInstance {
        serialPrinter: SerialPrinterService
        clientBuf: ClientLogBuffer
    }
}

// ---- Event sink using orchestrator logging ---------------------------------

class SerialPrinterLoggerEventSink implements SerialPrinterEventSink {
    private readonly logSp: ReturnType<ReturnType<typeof createLogger>['channel']>

    constructor(app: FastifyInstance) {
        const { channel } = createLogger('serial-printer', app.clientBuf)
        this.logSp = channel(LogChannel.serial_printer)
    }

    publish(evt: SerialPrinterEvent): void {
        const ts = new Date(evt.at).toISOString()

        switch (evt.kind) {
            case 'job-started': {
                const { jobId } = evt
                this.logSp.info(
                    `kind=job-started ts=${ts} jobId=${jobId}`
                )
                break
            }

            case 'job-chunk': {
                // Intentionally NO logging of chunk text; high-frequency, noisy
                // You *could* add a very low-volume debug line here if desired.
                break
            }

            case 'job-completed': {
                const { job } = evt
                const sizeChars = job.raw.length
                const durationMs = job.completedAt - job.createdAt
                this.logSp.info(
                    `kind=job-completed ts=${ts} jobId=${job.id} sizeChars=${sizeChars} durationMs=${durationMs}`
                )
                break
            }

            case 'device-connected': {
                const { portPath } = evt
                this.logSp.info(
                    `kind=device-connected ts=${ts} port=${portPath}`
                )
                break
            }

            case 'device-disconnected': {
                const { portPath, reason } = evt
                this.logSp.warn(
                    `kind=device-disconnected ts=${ts} port=${portPath} reason=${reason}`
                )
                break
            }

            case 'recoverable-error': {
                const { error } = evt
                this.logSp.warn(
                    `kind=recoverable-error ts=${ts} error=${error}`
                )
                break
            }

            case 'fatal-error': {
                const { error } = evt
                this.logSp.error(
                    `kind=fatal-error ts=${ts} error=${error}`
                )
                break
            }

            default: {
                this.logSp.info(`kind=${(evt as any).kind ?? 'unknown'} ts=${ts}`)
                break
            }
        }
    }
}

// ---- Fanout sink: logger + state adapter -----------------------------------

class FanoutSerialPrinterEventSink implements SerialPrinterEventSink {
    private readonly sinks: SerialPrinterEventSink[]

    constructor(...sinks: SerialPrinterEventSink[]) {
        this.sinks = sinks
    }

    publish(evt: SerialPrinterEvent): void {
        for (const sink of this.sinks) {
            try {
                sink.publish(evt)
            } catch {
                // Swallow per-sink errors so a bad consumer
                // doesn’t break the printer service.
            }
        }
    }
}

// ---- Plugin implementation -------------------------------------------------

const serialPrinterPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    const env = process.env
    const { channel } = createLogger('serial-printer-plugin', app.clientBuf)
    const logPlugin = channel(LogChannel.app)

    // For now we rely on env for port configuration. You can optionally
    // pass a discovered port path here instead of '' if you have a
    // SerialDiscovery layer that finds the FTDI device.
    const discoveredPort = env.SERIAL_PRINTER_DISCOVERED_PORT ?? ''

    const spConfig = buildSerialPrinterConfigFromEnv(discoveredPort)

    logPlugin.info(
        `serial-printer config portPath=${spConfig.portPath || '<none>'} baudRate=${spConfig.baudRate} idleFlushMs=${spConfig.idleFlushMs} maxQueuedJobs=${spConfig.maxQueuedJobs} flowControl=${spConfig.flowControl}`
    )

    const loggerSink = new SerialPrinterLoggerEventSink(app)
    const stateAdapter = new SerialPrinterStateAdapter()

    const spEvents: SerialPrinterEventSink = new FanoutSerialPrinterEventSink(
        loggerSink,
        {
            publish(evt: SerialPrinterEvent): void {
                stateAdapter.handle(evt)
            },
        }
    )

    const serialPrinterService = new SerialPrinterService(spConfig, { events: spEvents })

    // Expose on Fastify instance so other plugins / routes can use it.
    app.decorate('serialPrinter', serialPrinterService)

    // Lifecycle hooks: start/stop the service with the app.
    app.addHook('onReady', async () => {
        logPlugin.info('starting serial printer service')
        await serialPrinterService.start().catch((err: unknown) => {
            logPlugin.warn('error starting serial printer service', {
                err: (err as Error).message,
            })
        })
    })

    app.addHook('onClose', async () => {
        logPlugin.info('stopping serial printer service')
        await serialPrinterService.stop().catch((err: unknown) => {
            logPlugin.warn('error stopping serial printer service', {
                err: (err as Error).message,
            })
        })
    })
}

export default fp(serialPrinterPlugin, {
    name: 'serial-printer-plugin',
})