import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import {
    createLogger,
    LogChannel,
    type ClientLogBuffer,
} from '@autobench98/logging'

import { CfImagerService } from '../devices/cf-imager/CfImagerService.js'
import {
    type CfImagerEvent,
    type CfImagerEventSink,
} from '../devices/cf-imager/types.js'
import { buildCfImagerConfigFromEnv } from '../devices/cf-imager/utils.js'
import { CfImagerStateAdapter } from '../adapters/cfImager.adapter.js'
import {
    CfBlockDiscoveryService,
    type CfBlockDiscoveryConfig,
} from '../devices/cf-imager/CfBlockDiscoveryService.js'

declare module 'fastify' {
    interface FastifyInstance {
        cfImager: CfImagerService
        clientBuf: ClientLogBuffer
    }
}

// ---- Event sink using orchestrator logging ---------------------------------

class CfImagerLoggerEventSink implements CfImagerEventSink {
    private readonly log: ReturnType<ReturnType<typeof createLogger>['channel']>

    constructor(app: FastifyInstance) {
        const { channel } = createLogger('cf-imager', app.clientBuf)
        this.log = channel(LogChannel.cf_imager)
    }

    publish(evt: CfImagerEvent): void {
        const ts = new Date(evt.at).toISOString()

        switch (evt.kind) {
            case 'cf-device-identified': {
                const d = evt.device
                this.log.info(
                    `kind=${evt.kind} id=${d.id} path=${d.path} vid=${d.vendorId ?? 'n/a'} pid=${d.productId ?? 'n/a'}`
                )
                break
            }

            case 'cf-device-disconnected': {
                this.log.warn(
                    `kind=${evt.kind} deviceId=${evt.deviceId} reason=${evt.reason}`
                )
                break
            }

            case 'cf-fs-updated': {
                const fs = evt.fs
                this.log.debug(
                    `kind=${evt.kind} cwd=${fs.cwd} entries=${fs.entries.length}`
                )
                break
            }

            case 'cf-op-started': {
                const op = evt.op
                this.log.info(
                    `kind=${evt.kind} op=${op.kind} src=${op.source} dest=${op.destination}`
                )
                break
            }

            case 'cf-op-progress': {
                const op = evt.op
                // this.log.debug(
                //     `kind=${evt.kind} op=${op.kind} pct=${op.progressPct.toFixed(1)}`
                // )
                break
            }

            case 'cf-op-completed': {
                const op = evt.op
                this.log.info(
                    `kind=${evt.kind} op=${op.kind} src=${op.source} dest=${op.destination}`
                )
                break
            }

            case 'cf-op-error': {
                const op = evt.op
                this.log.error(
                    `kind=${evt.kind} error=${evt.error} opKind=${op?.kind ?? 'n/a'}`
                )
                break
            }

            case 'cf-error': {
                this.log.error(`kind=${evt.kind} error=${evt.error}`)
                break
            }
        }
    }
}

// ---- Fanout sink: logger + state adapter -----------------------------------

class FanoutCfImagerEventSink implements CfImagerEventSink {
    private readonly sinks: CfImagerEventSink[]

    constructor(...sinks: CfImagerEventSink[]) {
        this.sinks = sinks
    }

    publish(evt: CfImagerEvent): void {
        for (const sink of this.sinks) {
            try {
                sink.publish(evt)
            } catch {
                // Do not let a bad consumer break the service.
            }
        }
    }
}

// ---- Plugin implementation -------------------------------------------------

const cfImagerPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    const env = process.env
    const { channel } = createLogger('cf-imager-plugin', app.clientBuf)

    // NOTE: use cf_imager channel, not app
    const logPlugin = channel(LogChannel.cf_imager)

    // 1) Build config for the imaging service (FS root + scripts).
    const cfConfig = buildCfImagerConfigFromEnv(env)

    // 2) Instantiate sinks
    const loggerSink = new CfImagerLoggerEventSink(app)
    const stateAdapter = new CfImagerStateAdapter()

    const cfEvents: CfImagerEventSink = new FanoutCfImagerEventSink(
        loggerSink,
        {
            publish(evt: CfImagerEvent): void {
                stateAdapter.handle(evt)
            },
        }
    )

    // 3) Instantiate service
    const cfImagerService = new CfImagerService(cfConfig, {
        events: cfEvents,
        log: logPlugin,
    })


    // Expose on Fastify instance
    app.decorate('cfImager', cfImagerService)

    // 4) Optional block-device discovery for the CF reader
    const cfVendorId = (env.CF_IMAGER_USB_VENDOR_ID ?? '').trim() || undefined
    const cfProductId = (env.CF_IMAGER_USB_PRODUCT_ID ?? '').trim() || undefined
    const cfSerial = (env.CF_IMAGER_USB_SERIAL ?? '').trim() || undefined
    const pollMs =
        Number.isFinite(Number(env.CF_IMAGER_USB_POLL_MS))
            ? Number(env.CF_IMAGER_USB_POLL_MS)
            : 3000

    let blockDiscovery: CfBlockDiscoveryService | null = null

    if (cfVendorId || cfProductId || cfSerial) {
        const cfg: CfBlockDiscoveryConfig = {
            vendorId: cfVendorId,
            productId: cfProductId,
            serialNumber: cfSerial,
            pollIntervalMs: pollMs || 3000,
        }

        blockDiscovery = new CfBlockDiscoveryService(cfg, {
            onPresent: async (info) => {
                // single-line, no meta object
                logPlugin.info(
                    `CF reader present (block discovery) id=${info.id} path=${info.path} vid=${info.vendorId ?? 'n/a'} pid=${info.productId ?? 'n/a'} serial=${info.serialNumber ?? 'n/a'}`
                )

                await cfImagerService.onDeviceIdentified({
                    id: info.id,
                    path: info.path,
                    vendorId: info.vendorId,
                    productId: info.productId,
                    serialNumber: info.serialNumber,
                })
            },
            onLost: async ({ id }) => {
                logPlugin.warn(
                    `CF reader lost (block discovery) id=${id}`
                )
                await cfImagerService.onDeviceLost({ id })
            },
            log: (level, msg, meta) => {
                const m = meta ?? {}

                // Convert meta into a flat suffix string for single-line logs
                const suffixEntries = Object.entries(m).map(
                    ([k, v]) => `${k}=${String(v)}`
                )
                const suffix = suffixEntries.length > 0 ? ` ${suffixEntries.join(' ')}` : ''

                if (level === 'debug') {
                    logPlugin.debug(`${msg}${suffix}`)
                } else if (level === 'info') {
                    logPlugin.info(`${msg}${suffix}`)
                } else if (level === 'warn') {
                    logPlugin.warn(`${msg}${suffix}`)
                } else {
                    logPlugin.error(`${msg}${suffix}`)
                }
            },
        })
    } else {
        logPlugin.info(
            'CF block discovery disabled (no CF_IMAGER_USB_VENDOR_ID/PRODUCT_ID/SERIAL configured)'
        )
    }

    // 5) Lifecycle hooks
    app.addHook('onReady', async () => {
        logPlugin.info('starting cf imager service')
        await cfImagerService.start()

        if (blockDiscovery) {
            logPlugin.info(
                `starting CF block discovery vid=${cfVendorId ?? 'n/a'} pid=${cfProductId ?? 'n/a'} serial=${cfSerial ?? 'n/a'} pollMs=${pollMs}`
            )
            blockDiscovery.start()
        }
    })

    app.addHook('onClose', async () => {
        logPlugin.info('stopping cf imager service')
        await cfImagerService.stop().catch((err: unknown) => {
            logPlugin.warn(
                `error stopping cf imager service err="${(err as Error).message}"`
            )
        })

        if (blockDiscovery) {
            logPlugin.info('stopping CF block discovery')
            await blockDiscovery.stop().catch((err: unknown) => {
                logPlugin.warn(
                    `error stopping CF block discovery err="${(err as Error).message}"`
                )
            })
        }
    })
}

export default fp(cfImagerPlugin, {
    name: 'cf-imager-plugin',
})