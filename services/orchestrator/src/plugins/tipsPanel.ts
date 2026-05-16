import fp from 'fastify-plugin'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { createLogger, LogChannel, type ClientLogBuffer } from '@autobench98/logging'
import {
    peek,
    updateTipsPanelSnapshot,
    type TipsPanelCurrent,
    type TipsServerConfig,
} from '../core/state.js'
import type { SheetsGateway } from '../core/sheets/sheets.gateway.js'
import { TipsPanelService } from '../core/tips-panel/TipsPanelService.js'
import type { TipsPanelEvent, TipsPanelEventSink } from '../core/tips-panel/types.js'

declare module 'fastify' {
    interface FastifyInstance {
        clientBuf: ClientLogBuffer
        sheetsGateway?: SheetsGateway

        /**
         * Tips-only per-client API surface, used by ws.ts.
         *
         * IMPORTANT:
         * - This is intentionally tips-scoped and does NOT affect global snapshot broadcast.
         * - Implementation is provided by tipsPanel plugin to avoid ws.ts importing the service directly.
         */
        tipsPanelService?: {
            nextForClient: (clientId: string) => Promise<TipsPanelCurrent | null>
        }
    }
}

function isTipsServerConfig(x: unknown): x is TipsServerConfig {
    if (!x || typeof x !== 'object') return false
    const o = x as Record<string, unknown>
    return (
        typeof o.enabled === 'boolean' &&
        typeof o.intervalMs === 'number' &&
        typeof o.pageDelim === 'string' &&
        typeof o.tab === 'string' &&
        typeof o.cacheTtlMs === 'number' &&
        typeof o.strict === 'boolean' &&
        Array.isArray(o.defaultCategories) &&
        typeof o.maxTextChars === 'number' &&
        typeof o.maxPagesPerTip === 'number' &&
        typeof (o as any).categoryHeaderRow === 'number' &&
        typeof (o as any).tipsStartRow === 'number' &&
        // 0 disables; otherwise 1-based row index.
        typeof (o as any).categoryPropsRow === 'number'
    )
}

function safeStr(x: unknown, fallback = ''): string {
    return typeof x === 'string' && x.trim() ? x.trim() : fallback
}

function safeNum(x: unknown, fallback = 0): number {
    const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN
    return Number.isFinite(n) ? n : fallback
}

function boolTo01(x: boolean): '0' | '1' {
    return x ? '1' : '0'
}

function safeClientId(x: unknown): string {
    if (typeof x !== 'string') return ''
    const s = x.trim()
    if (!s) return ''
    if (s.length > 128) return ''
    return s
}

const tipsPanelPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    const { channel } = createLogger('orchestrator:tips', app.clientBuf)

    // SAFETY: LogChannel members can drift across packages; fall back instead of throwing.
    const logTips =
        (LogChannel as any)?.tips !== undefined
            ? (channel((LogChannel as any).tips) as any)
            : channel(LogChannel.websocket)

    // IMPORTANT: config is sourced from AppState (env-parsed in core/state.ts)
    const tipsCfgUnknown = peek()?.serverConfig?.tips as unknown

    if (!isTipsServerConfig(tipsCfgUnknown)) {
        logTips.error(
            'tips config kind=tips-config-invalid reason=missing-or-bad-shape source=peek().serverConfig.tips action=idle'
        )
        updateTipsPanelSnapshot({
            phase: 'error',
            message: 'tips config missing/invalid (serverConfig.tips)',
        })
        return
    }

    const tipsCfg = tipsCfgUnknown

    if (!tipsCfg.enabled) {
        logTips.info('tips kind=tips-disabled enabled=false action=idle')
        updateTipsPanelSnapshot({
            phase: 'disabled',
            message: 'Tips disabled (TIPS_ENABLED=false)',
            current: null,
            eligibleCategories: [],
        })
        return
    }

    const sheets = app.sheetsGateway
    if (!sheets) {
        // SAFETY: do not create a SheetsHost here; that would duplicate workers.
        logTips.error(
            'tips kind=tips-sheets-gateway-missing enabled=true action=idle reason=sinks-plugin-not-registered'
        )
        updateTipsPanelSnapshot({
            phase: 'error',
            message: 'SheetsGateway missing (sinks plugin not registered?)',
            current: null,
        })
        return
    }

    // Config summary (non-sensitive). Keep strictly key=value.
    const defaultCategoriesCount = Array.isArray(tipsCfg.defaultCategories)
        ? tipsCfg.defaultCategories.length
        : 0

    logTips.info(
        'tips kind=tips-enabled enabled=true ' +
            `intervalMs=${safeNum(tipsCfg.intervalMs, 0)} ` +
            `tab=${safeStr(tipsCfg.tab, '')} ` +
            `cacheTtlMs=${safeNum(tipsCfg.cacheTtlMs, 0)} ` +
            `strict=${boolTo01(!!tipsCfg.strict)} ` +
            `defaultCategoriesCount=${defaultCategoriesCount} ` +
            `maxTextChars=${safeNum(tipsCfg.maxTextChars, 0)} ` +
            `maxPagesPerTip=${safeNum(tipsCfg.maxPagesPerTip, 0)} ` +
            `categoryHeaderRow=${safeNum((tipsCfg as any).categoryHeaderRow, 0)} ` +
            `tipsStartRow=${safeNum((tipsCfg as any).tipsStartRow, 0)} ` +
            `categoryPropsRow=${safeNum((tipsCfg as any).categoryPropsRow, 0)}`
    )

    // Event sink: updates AppState + logs instrumentation (key=value only).
    // SAFETY: never log full tip text; only log counts/ids.
    const sink: TipsPanelEventSink = {
        publish(evt: TipsPanelEvent): void {
            const at = evt.at
            const prev = peek().tipsPanel
            const totalEvents = (prev?.stats?.totalEvents ?? 0) + 1

            // Logging (all key=value, no structured object meta)
            if (evt.kind === 'tips-loading') {
                const msg = safeStr(evt.message, 'Loading tips…')
                logTips.info(`tips kind=tips-event event=tips-loading at=${at} message=${msg}`)
            } else if (evt.kind === 'tips-ready') {
                const msg = safeStr(evt.message, '')
                logTips.info(
                    `tips kind=tips-event event=tips-ready at=${at}${msg ? ` message=${msg}` : ''}`
                )
            } else if (evt.kind === 'tips-error') {
                logTips.error(`tips kind=tips-event event=tips-error at=${at} error=${evt.error}`)
            } else if (evt.kind === 'tips-refreshed') {
                logTips.info(
                    `tips kind=tips-event event=tips-refreshed at=${at} totalTips=${evt.totalTips} totalCategories=${evt.totalCategories}`
                )
            } else if (evt.kind === 'tips-eligible-categories') {
                const count = Array.isArray(evt.categories) ? evt.categories.length : 0
                logTips.info(
                    `tips kind=tips-event event=tips-eligible-categories at=${at} count=${count}`
                )
            } else if (evt.kind === 'tips-current') {
                const c = evt.current
                const textChars = typeof c.text === 'string' ? c.text.length : 0
                logTips.debug(
                    'tips kind=tips-event event=tips-current ' +
                        `at=${at} category=${c.category} tipId=${c.tipId} ` +
                        `pageIndex=${c.pageIndex} pageCount=${c.pageCount} ` +
                        `hasImage=${boolTo01(!!c.imageUrl)} textChars=${textChars}`
                )
            }

            // State updates (existing behavior preserved)
            if (evt.kind === 'tips-loading') {
                updateTipsPanelSnapshot({
                    phase: 'loading',
                    message: evt.message ?? 'Loading tips…',
                    stats: { totalEvents, lastEventAt: at },
                })
                return
            }

            if (evt.kind === 'tips-ready') {
                updateTipsPanelSnapshot({
                    phase: 'ready',
                    message: evt.message,
                    stats: { totalEvents, lastEventAt: at },
                })
                return
            }

            if (evt.kind === 'tips-error') {
                updateTipsPanelSnapshot({
                    phase: 'error',
                    message: evt.error,
                    stats: { totalEvents, lastEventAt: at, lastErrorAt: at },
                })
                return
            }

            if (evt.kind === 'tips-refreshed') {
                updateTipsPanelSnapshot({
                    phase: 'ready',
                    message: undefined,
                    stats: {
                        totalEvents,
                        lastEventAt: at,
                        lastRefreshAt: at,
                        totalTips: evt.totalTips,
                        totalCategories: evt.totalCategories,
                    },
                })
                return
            }

            if (evt.kind === 'tips-eligible-categories') {
                updateTipsPanelSnapshot({
                    eligibleCategories: evt.categories,
                    stats: { totalEvents, lastEventAt: at },
                })
                return
            }

            if (evt.kind === 'tips-current') {
                updateTipsPanelSnapshot({
                    phase: 'ready',
                    current: evt.current,
                    stats: { totalEvents, lastEventAt: at },
                })
                return
            }
        },
    }

    const svc = new TipsPanelService({
        config: tipsCfg,
        sheets,
        // Route TipsPanelService logs to the tips channel.
        logger: logTips,
        events: sink,
    })

    /**
     * Expose tips-only per-client API for ws.ts.
     *
     * Safety notes:
     * - This does NOT change the existing global snapshot behavior.
     * - Typed as TipsPanelCurrent|null to reduce drift.
     */
    try {
        app.decorate('tipsPanelService', {
            nextForClient: async (clientId: string): Promise<TipsPanelCurrent | null> => {
                const id = safeClientId(clientId)
                if (!id) throw new Error('invalid clientId')
                return await svc.nextForClient(id)
            },
        })
    } catch {
        // If already decorated, do not override silently.
        logTips.warn('tips kind=tips-service-decorate-skip reason=already-decorated')
    }

    let startInFlight: Promise<void> | null = null

    app.addHook('onReady', async () => {
        logTips.info('tips kind=tips-start requestedBy=fastify-onReady mode=background')

        if (startInFlight) {
            logTips.warn('tips kind=tips-start-skip reason=already-starting')
            return
        }

        startInFlight = (async () => {
            try {
                await svc.start()
                logTips.info('tips kind=tips-start-ok')
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                logTips.error(`tips kind=tips-start-failed error=${msg}`)
                sink.publish({ kind: 'tips-error', at: Date.now(), error: msg })
            } finally {
                startInFlight = null
            }
        })()

        // IMPORTANT:
        // Do not await tips startup here.
        // Tips is non-critical UI content and must not block Fastify readiness.
        void startInFlight
    })

    app.addHook('onClose', async () => {
        logTips.info('tips kind=tips-stop requestedBy=fastify-onClose')
        try {
            await svc.stop()
            logTips.info('tips kind=tips-stop-ok')
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            logTips.warn(`tips kind=tips-stop-failed error=${msg}`)
        }
    })
}

export default fp(tipsPanelPlugin, {
    name: 'tips-panel-plugin',
})
