// services/orchestrator/src/plugins/sinks-plugin.ts
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import {
  createLogger,
  LogChannel,
  type ClientLogBuffer,
} from '@autobench98/logging'

import { SinkManager } from '../core/sinks/sink-manager.js'
import { SheetsSink } from '../core/sinks/sheets/sheets.sink.js'
import { buildSheetsConfigFromEnv } from '../core/sinks/sheets/sheets.config.js'

declare module 'fastify' {
  interface FastifyInstance {
    // logging (shared buffer for UI)
    clientBuf: ClientLogBuffer

    // sinks
    sinkManager?: SinkManager
    sheetsSink?: SheetsSink
  }
}

/**
 * sinks-plugin
 *
 * Purpose:
 * - Instantiate result sinks (Google Sheets, etc.)
 * - Decorate app with { sinkManager, sheetsSink }
 * - Manage sink lifecycle via onReady/onClose
 *
 * Logging format convention:
 * - Message strings should be "key=value key=value" so pino-pretty output matches other subsystems
 *   (avoid structured objects in logs unless explicitly needed).
 */
const plugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  // SAFETY: enforce shared buffer (logs must reach UI)
  if (!app.clientBuf) {
    throw new Error(
      'sinks-plugin: app.clientBuf missing. app.ts must decorate app.clientBuf with makeClientBuffer() before registering sinks-plugin.'
    )
  }

  const { channel } = createLogger('orchestrator:sinks-plugin', app.clientBuf)

  // Plugin lifecycle/config logs: keep as app
  const logApp = channel(LogChannel.app)

  // Google Sheets integration logs: dedicated channel (orange)
  const logGoogleSheets = channel(LogChannel.google_sheets)

  const env = process.env
  const sheetsCfg = buildSheetsConfigFromEnv(env)

  // SAFETY: log only presence flags + tuning values; never log secrets.
  logApp.info(
    [
      'kind=sinks-plugin-config-loaded',
      `sheetsEnabled=${sheetsCfg.enabled}`,
      `sheetsDryRun=${sheetsCfg.dryRun}`,
      `sheetsLockMode=${sheetsCfg.lockMode}`,
      `workersBlocking=${sheetsCfg.workersBlocking}`,
      `workersBackground=${sheetsCfg.workersBackground}`,
      `spreadsheetIdPresent=${Boolean(sheetsCfg.spreadsheetId)}`,
      `serviceAccountEmailPresent=${Boolean(sheetsCfg.serviceAccountEmail)}`,
      `privateKeyPresent=${Boolean(sheetsCfg.privateKey)}`,
    ].join(' ')
  )

  // SheetsSink should log on its own dedicated channel.
  const sheetsSink = new SheetsSink({
    config: sheetsCfg,
    logger: logGoogleSheets,
  })

  // SinkManager is generic; keep its logs on app unless/until you want a dedicated "sinks" channel.
  const sinkManager = new SinkManager({
    sinks: [sheetsSink],
    logger: logApp,
  })

  app.decorate('sheetsSink', sheetsSink)
  app.decorate('sinkManager', sinkManager)

  app.addHook('onReady', async () => {
    logApp.info('kind=sinks-plugin-onReady action=initAll')
    await sinkManager.initAll()
    logApp.info('kind=sinks-plugin-initAll-complete')
  })

  app.addHook('onClose', async () => {
    logApp.info('kind=sinks-plugin-onClose action=shutdownAll')
    await sinkManager.shutdownAll()
    logApp.info('kind=sinks-plugin-shutdownAll-complete')
  })
}

export default fp(plugin, { name: 'sinks-plugin' })
