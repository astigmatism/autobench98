// services/orchestrator/src/plugins/sinks-plugin.ts
import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'

import { createLogger, LogChannel } from '@autobench98/logging'

import { SinkManager } from '../core/sinks/sink-manager.js'
import { SheetsSink } from '../core/sinks/sheets/sheets.sink.js'
import { buildSheetsConfigFromEnv } from '../core/sinks/sheets/sheets.config.js'

import { SheetsHost } from '../core/sheets/sheets.host.js'
import { SheetsGateway } from '../core/sheets/sheets.gateway.js'

declare module 'fastify' {
  interface FastifyInstance {
    sinkManager?: SinkManager
    sheetsGateway?: SheetsGateway
  }
}

const sinksPlugin = fp(
  async (app: FastifyInstance) => {
    // SAFETY: All subsystems must log into the shared client buffer so Studio can see them.
    // Do NOT call makeClientBuffer() in plugins.
    const anyApp = app as any
    if (!anyApp.clientBuf) {
      throw new Error(
        'sinks-plugin: app.clientBuf is missing. Ensure app decorates clientBuf before registering sinks-plugin.'
      )
    }

    const { channel } = createLogger('orchestrator:sinks', anyApp.clientBuf)
    const logApp = channel(LogChannel.app)
    const logGoogleSheets = channel(LogChannel.google_sheets)

    const sheetsCfg = buildSheetsConfigFromEnv()

    // key=value style to match the rest of your console output
    logApp.info(
      `kind=sinks-plugin-config ` +
        `sheetsEnabled=${sheetsCfg.enabled} ` +
        `sheetsDryRun=${sheetsCfg.dryRun} ` +
        `sheetsLockMode=${sheetsCfg.lockMode} ` +
        `workersBlocking=${sheetsCfg.workersBlocking} ` +
        `workersBackground=${sheetsCfg.workersBackground} ` +
        `spreadsheetIdPresent=${Boolean(sheetsCfg.spreadsheetId)} ` +
        `serviceAccountEmailPresent=${Boolean(sheetsCfg.serviceAccountEmail)} ` +
        `privateKeyPresent=${Boolean(sheetsCfg.privateKey)} ` +
        `authStrategy=${sheetsCfg.auth.strategy} ` +
        `cacheEnabled=${sheetsCfg.cache.enabled} ` +
        `cacheMaxEntries=${sheetsCfg.cache.maxEntries} ` +
        `cacheSheetMetaTtlMs=${sheetsCfg.cache.sheetMetaTtlMs} ` +
        `cacheKeyMapTtlMs=${sheetsCfg.cache.keyMapTtlMs} ` +
        `cacheRangeTtlMs=${sheetsCfg.cache.rangeTtlMs}`
    )

    // Shared host: one set of worker pools for BOTH sink publishing and gateway reads/writes
    const sheetsHost = new SheetsHost({ config: sheetsCfg, logger: logGoogleSheets })

    // Gateway: general-purpose Sheets "database" API for reads/lookups + template ops
    const sheetsGateway = new SheetsGateway({ host: sheetsHost, logger: logGoogleSheets })

    const sinkManager = new SinkManager({
      logger: logApp,
      sinks: [
        new SheetsSink({
          config: sheetsCfg,
          logger: logGoogleSheets,
          host: sheetsHost,
        }),
      ],
    })

    // Decorate Fastify instance
    app.decorate('sinkManager', sinkManager)
    app.decorate('sheetsGateway', sheetsGateway)

    app.addHook('onReady', async () => {
      await sinkManager.initAll()
    })

    app.addHook('onClose', async () => {
      await sinkManager.shutdownAll()
    })
  },
  {
    name: 'sinks-plugin',
  }
)

export default sinksPlugin
export { sinksPlugin }
