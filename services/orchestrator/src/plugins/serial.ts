import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { createLogger, LogChannel, type ClientLogBuffer } from '@autobench98/logging'
import {
  SerialDiscoveryService,
  type IdentifyConfig,
  type SerialDiscoveryOptions,
  type SerialMatcher,
} from '../core/serial/SerialDiscoveryService.js'

export type DeviceStatus = 'identifying' | 'ready' | 'error' | 'lost'

export interface DeviceRecord {
  id: string
  kind: string
  path: string
  vid?: string
  pid?: string
  baudRate?: number
  /** Arduino "identify" response (e.g., KB, MS, FP, AC) derived from matcher */
  idToken?: string
  status: DeviceStatus
  lastSeen: number
  error?: string
}

/** Optional adapter: push device updates into your state container if desired. */
export interface DevicesStateAdapter {
  upsert: (rec: DeviceRecord) => void
  remove?: (id: string) => void
  log?: (
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    meta?: Record<string, unknown>
  ) => void
}

export interface SerialPluginOptions {
  /** No env-driven matchers. If you pass matchers here, they will be ignored.
   *  The only source of truth is SERIAL_REQUIRED_DEVICES_JSON. */
  matchers?: never
  identify?: Partial<IdentifyConfig>
  defaultBaudRate?: number
  rescanIntervalMs?: number
  stateAdapter?: DevicesStateAdapter
  logPrefix?: string
  /** Optional: override periodic summary interval (ms). Defaults to rescanIntervalMs or 15000. */
  summaryIntervalMs?: number
}

/** Required-device spec (from env JSON) */
type RequiredSpec = {
  id?: string // e.g. "KB" | "MS" | "FP"; if omitted => static device (no identify)
  kind?: string // e.g. "arduino.ps2.keyboard" (recommended)
  vendorId?: string
  productId?: string
  pathRegex?: string
  baudRate?: number
  serialNumber?: string
  /** If false, device is matched/observed but does NOT gate startup readiness. Defaults to true. */
  startupRequired?: boolean
}

/* ----------------------- env helpers (safe parsing) ----------------------- */
function unescapeLineEnding(
  s: string | undefined,
  fallback: '\n' | '\r\n'
): '\n' | '\r\n' {
  if (!s) return fallback
  if (s === '\\n') return '\n'
  if (s === '\\r\\n' || s === '\r\n') return '\r\n'
  if (s === '\n') return '\n'
  return fallback
}

function parseIntEnv(name: string, def?: number): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  return Number.isFinite(n) ? n : def
}

function parseBoolEnv(name: string, def: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return def
  const v = String(raw).trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function parseStringEnv(name: string, def?: string): string | undefined {
  const raw = process.env[name]
  if (raw === undefined) return def
  return raw
}

function parseRequiredFromEnv(): {
  specs: Array<RequiredSpec & { _pathRe?: RegExp }>
  error?: string
} {
  const raw = process.env.SERIAL_REQUIRED_DEVICES_JSON
  if (!raw) return { specs: [] }
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return { specs: [] }
    const specs: Array<RequiredSpec & { _pathRe?: RegExp }> = []
    for (const item of arr) {
      const spec: RequiredSpec & { _pathRe?: RegExp } = {
        id: item.id != null ? String(item.id) : undefined,
        kind: item.kind ? String(item.kind) : undefined,
        vendorId: item.vendorId
          ? String(item.vendorId).toLowerCase().replace(/^0x/, '')
          : undefined,
        productId: item.productId
          ? String(item.productId).toLowerCase().replace(/^0x/, '')
          : undefined,
        pathRegex: item.pathRegex ? String(item.pathRegex) : undefined,
        baudRate: Number.isFinite(Number(item.baudRate))
          ? Number(item.baudRate)
          : undefined,
        serialNumber: item.serialNumber ? String(item.serialNumber) : undefined,
        // Default to true so existing configs remain startup-gating
        startupRequired: item.startupRequired === false ? false : true,
      }
      if (spec.pathRegex) {
        try {
          spec._pathRe = new RegExp(spec.pathRegex)
        } catch {
          /* ignore bad regex */
        }
      }
      specs.push(spec)
    }
    return { specs }
  } catch (e) {
    return { specs: [], error: (e as Error).message }
  }
}
/* ------------------------------------------------------------------------- */

/** Keep rescanIntervalMs optional to match the service contract */
type EffectiveOptions = {
  identify: Partial<IdentifyConfig>
  defaultBaudRate: number
  rescanIntervalMs?: number
  summaryIntervalMs: number
  logPrefix: string
}

/** Build runtime matchers *only* from required specs. */
function buildMatchersFromRequired(
  specs: Array<RequiredSpec & { _pathRe?: RegExp }>
): SerialMatcher[] {
  // Token-present => active (identifyRequired true). No token => static (identifyRequired false).
  return specs.map((s) => {
    const m: SerialMatcher = {
      kind: s.kind ?? 'unknown',
      vendorId: s.vendorId,
      productId: s.productId,
      pathRegex: s._pathRe,
      baudRate: s.baudRate,
      serialNumber: s.serialNumber,
      identifyRequired: s.id ? true : false,
      keepOpenOnStatic: false, // default off; can revisit per device later
    }
    if (s.id) m.identificationString = s.id
    return m
  })
}

/** Mirror SerialDiscoveryService's device id format (used to prune stale probe records). */
function makeDiscoveryDeviceId(kind: string, path: string, vid?: string, pid?: string): string {
  return `usb:${vid ?? 'unknown'}:${pid ?? 'unknown'}:${kind}:${path}`
}

// Shape we’ll expose to the app for readiness querying
export type DeviceStatusSummary = {
  ready: boolean
  missing: Array<{ id: string; kind?: string }>
  devices: DeviceRecord[]
  byStatus: Record<DeviceStatus, number>
}

export default fp<SerialPluginOptions>(async function serialPlugin(
  app: FastifyInstance,
  opts
) {
  const devices = new Map<string, DeviceRecord>()
  app.decorate('devices', devices)

  // 👇 Use the SAME buffer the WS plugin broadcasts from
  const { channel } = createLogger(
    'orchestrator:serial',
    app.clientBuf as ClientLogBuffer | undefined
  )
  const log = channel(LogChannel.device)

  // -------------------- read env & build effective options -------------------
  const envDefaultBaud = parseIntEnv('SERIAL_DEFAULT_BAUD', 9600)
  const envRescanMs = parseIntEnv('SERIAL_RESCAN_MS')
  const envSummaryMs = parseIntEnv('SERIAL_SUMMARY_MS')
  const envLogPrefix = parseStringEnv('SERIAL_LOG_PREFIX', 'serial')

  const envIdentify: Partial<IdentifyConfig> = {
    request: parseStringEnv('SERIAL_IDENTIFY_REQUEST', 'identify'),
    completion: ((): string | undefined => {
      const v = process.env.SERIAL_IDENTIFY_COMPLETION
      return v === '' ? undefined : v ?? 'identify_complete'
    })(),
    parserDelimiter: unescapeLineEnding(
      process.env.SERIAL_PARSER_DELIM,
      '\r\n'
    ),
    writeLineEnding: unescapeLineEnding(process.env.SERIAL_WRITE_EOL, '\n'),
    timeoutMs: parseIntEnv('SERIAL_TIMEOUT_MS', 5000),
    retries: parseIntEnv('SERIAL_RETRIES', 3),
  }

  const { specs: requiredSpecs, error: requiredParseErr } =
    parseRequiredFromEnv()
  const failOnMissing = parseBoolEnv('SERIAL_FAIL_ON_MISSING', true)

  // Split into startup-gating vs auxiliary specs
  const startupSpecs = requiredSpecs.filter((s) => s.startupRequired !== false)
  const auxSpecs = requiredSpecs.filter((s) => s.startupRequired === false)

  // Explicit startup timeout (how long we’re willing to wait for required devices)
  const startupTimeoutMs =
    parseIntEnv('SERIAL_STARTUP_TIMEOUT_MS', 30000) ?? 30000

  const effective: EffectiveOptions = {
    identify: { ...envIdentify, ...(opts.identify ?? {}) },
    defaultBaudRate: opts.defaultBaudRate ?? envDefaultBaud ?? 9600,
    rescanIntervalMs: opts.rescanIntervalMs ?? envRescanMs, // optional by design
    summaryIntervalMs:
      opts.summaryIntervalMs ??
      envSummaryMs ??
      opts.rescanIntervalMs ??
      envRescanMs ??
      15000,
    logPrefix: opts.logPrefix ?? envLogPrefix ?? 'serial',
  }
  // --------------------------------------------------------------------------

  // --- concise init logs -----------------------------------------------------
  if (requiredParseErr) {
    log.warn(
      `SERIAL_REQUIRED_DEVICES_JSON parse error err="${requiredParseErr}"`
    )
  } else if (requiredSpecs.length > 0) {
    const startupIds = startupSpecs.map((s) => s.id ?? '(static)').join(',')
    const auxIds = auxSpecs.map((s) => s.id ?? '(static)').join(',')
    log.info(
      `serial env specs total=${requiredSpecs.length} ` +
        `startupRequired=${
          startupSpecs.length > 0 ? '[' + startupIds + ']' : '[]'
        } ` +
        `aux=${auxSpecs.length > 0 ? '[' + auxIds + ']' : '[]'}`
    )
  } else {
    log.warn(
      'no serial env specs configured; discovery will still scan, but startup gating will pass trivially'
    )
  }

  // Matchers are built from *all* specs (startup + aux), so devices are still discovered & wired.
  const runtimeMatchers: SerialMatcher[] =
    buildMatchersFromRequired(requiredSpecs)

  // Map kind -> idToken (from runtime matchers) so we can record idToken on DeviceRecord
  const kindToIdToken = new Map<string, string>()
  for (const m of runtimeMatchers) {
    if (m.kind && m.identificationString)
      kindToIdToken.set(m.kind, m.identificationString)
  }

  const discovery = new SerialDiscoveryService()

  // --- delta counters (for optional summaries) --------------------------------
  let deltaIdentified = 0
  let deltaErrors = 0
  let deltaLost = 0
  let summaryTimer: NodeJS.Timeout | null = null

  const tallyStatus = (): Record<DeviceStatus, number> => {
    const byStatus: Record<DeviceStatus, number> = {
      identifying: 0,
      ready: 0,
      error: 0,
      lost: 0,
    }
    for (const rec of devices.values()) {
      byStatus[rec.status] = (byStatus[rec.status] ?? 0) + 1
    }
    return byStatus
  }

  const logSummary = (reason: string) => {
    const by = tallyStatus()
    log.info(
      `devices summary reason=${reason} total=${
        devices.size
      } ` +
        `byStatus=${JSON.stringify(by)} delta={"identified":${deltaIdentified},"errors":${deltaErrors},"lost":${deltaLost}}`
    )
    deltaIdentified = 0
    deltaErrors = 0
    deltaLost = 0
  }
  // ---------------------------------------------------------------------------

  const upsert = (rec: DeviceRecord) => {
    devices.set(rec.id, rec)
    try {
      opts?.stateAdapter?.upsert?.(rec)
    } catch (err) {
      log.error(
        `stateAdapter.upsert failed err="${(err as Error).message}"`
      )
    }
  }

  const remove = (id: string) => {
    const existed = devices.delete(id)
    try {
      opts?.stateAdapter?.remove?.(id)
    } catch (err) {
      log.error(
        `stateAdapter.remove failed err="${(err as Error).message}"`
      )
    }
    if (existed) deltaLost++
  }

  /**
   * Prune the transient "unknown" probe record for a path once we have a real match.
   * This avoids stale "identifying" rows hanging around in summaries and readiness views.
   *
   * IMPORTANT: This is NOT a real device-lost event; it should not increment deltaLost.
   */
  const pruneUnknownProbeRecord = (path: string, vid?: string, pid?: string, keepId?: string) => {
    const unknownId = makeDiscoveryDeviceId('unknown', path, vid, pid)
    if (keepId && unknownId === keepId) return
    if (!devices.has(unknownId)) return

    devices.delete(unknownId)
    try {
      opts?.stateAdapter?.remove?.(unknownId)
    } catch (err) {
      log.error(
        `stateAdapter.remove (probe prune) failed err="${(err as Error).message}"`
      )
    }
  }

  // 👉 Public status function for the app (used by /ready and logs)
  const getDeviceStatus = (): DeviceStatusSummary => {
    const byStatus = tallyStatus()
    // Only startupSpecs participate in "missing"/ready calculations
    const missing = computeMissingSinglePass(startupSpecs, devices)
    const ready = startupSpecs.length === 0 || missing.length === 0

    return {
      ready,
      missing,
      devices: Array.from(devices.values()),
      byStatus,
    }
  }

  ;(app as any).getDeviceStatus = getDeviceStatus

  // Service → plugin log translation (concise)
  discovery.on('device:identifying', ({ id, path, vid, pid, kind }) => {
    const now = Date.now()
    const idToken = kindToIdToken.get(kind)
    upsert({
      id,
      kind,
      path,
      vid,
      pid,
      idToken,
      status: 'identifying',
      lastSeen: now,
    })
  })

  discovery.on(
    'device:identified',
    async ({ id, path, vid, pid, kind, baudRate }) => {
      const now = Date.now()
      const idToken = kindToIdToken.get(kind)

      // ✅ Fix: remove stale "unknown" probe record for this same (path, vid, pid)
      pruneUnknownProbeRecord(path, vid, pid, id)

      upsert({
        id,
        kind,
        path,
        vid,
        pid,
        baudRate,
        idToken,
        status: 'ready',
        lastSeen: now,
      })
      deltaIdentified++
      log.info(
        `ready id=${idToken ?? 'unknown'} kind=${kind} baud=${baudRate}`
      )

      // 👉 Power meter wiring
      if (kind === 'serial.powermeter' && (app as any).powerMeter) {
        const pm = (app as any).powerMeter as {
          onDeviceIdentified: (info: {
            id: string
            path: string
            baudRate?: number
          }) => Promise<void> | void
        }

        try {
          await pm.onDeviceIdentified({ id, path, baudRate })
        } catch (err) {
          log.warn(
            `powerMeter.onDeviceIdentified failed id=${id} path=${path} err="${
              (err as Error).message
            }"`
          )
        }
      }

      // 👉 Serial printer wiring
      if (kind === 'serial.printer' && (app as any).serialPrinter) {
        const sp = (app as any).serialPrinter as {
          onDeviceIdentified: (info: {
            id: string
            path: string
            baudRate?: number
          }) => Promise<void> | void
        }

        try {
          await sp.onDeviceIdentified({ id, path, baudRate })
        } catch (err) {
          log.warn(
            `serialPrinter.onDeviceIdentified failed id=${id} path=${path} err="${
              (err as Error).message
            }"`
          )
        }
      }

      // 👉 Atlona controller wiring
      if (kind === 'arduino.atlonacontroller' && (app as any).atlonaController) {
        const controller = (app as any).atlonaController as {
          onDeviceIdentified: (info: {
            id: string
            path: string
            baudRate?: number
          }) => Promise<void> | void
        }

        try {
          await controller.onDeviceIdentified({ id, path, baudRate })
        } catch (err) {
          log.warn(
            `atlonaController.onDeviceIdentified failed id=${id} path=${path} err="${
              (err as Error).message
            }"`
          )
        }
      }

      // 👉 PS2 keyboard wiring
      if (kind === 'arduino.ps2.keyboard' && (app as any).ps2Keyboard) {
        const kb = (app as any).ps2Keyboard as {
          onDeviceIdentified: (info: {
            id: string
            path: string
            baudRate?: number
          }) => Promise<void> | void
        }

        try {
          await kb.onDeviceIdentified({ id, path, baudRate })
        } catch (err) {
          log.warn(
            `ps2Keyboard.onDeviceIdentified failed id=${id} path=${path} err="${
              (err as Error).message
            }"`
          )
        }
      }

      // ✅ PS2 mouse wiring
      if (kind === 'arduino.ps2.mouse') {
        const hook = (app as any).ps2MouseOnDeviceIdentified as
          | ((info: { id: string; path: string; baudRate?: number }) => Promise<void> | void)
          | undefined

        const svc = (app as any).ps2Mouse as
          | {
              onDeviceIdentified: (info: { id: string; path: string; baudRate?: number }) => Promise<void> | void
            }
          | undefined

        try {
          if (typeof hook === 'function') {
            await hook({ id, path, baudRate })
          } else if (svc?.onDeviceIdentified) {
            await svc.onDeviceIdentified({ id, path, baudRate })
          }
        } catch (err) {
          log.warn(
            `ps2Mouse.onDeviceIdentified failed id=${id} path=${path} err="${
              (err as Error).message
            }"`
          )
        }
      }

      // 👉 Front panel wiring
      if (kind === 'arduino.frontpanel' && (app as any).frontPanel) {
        const fpSvc = (app as any).frontPanel as {
          onDeviceIdentified: (info: {
            id: string
            path: string
            baudRate?: number
          }) => Promise<void> | void
        }

        try {
          await fpSvc.onDeviceIdentified({ id, path, baudRate })
        } catch (err) {
          log.warn(
            `frontPanel.onDeviceIdentified failed id=${id} path=${path} err="${
              (err as Error).message
            }"`
          )
        }
      }
    }
  )

  discovery.on('device:error', ({ id, path, kind /*, error*/ }) => {
    const now = Date.now()
    const safeId = id ?? `unknown:${path ?? 'unknown'}`
    const idToken = kind ? kindToIdToken.get(kind) : undefined
    upsert({
      id: safeId,
      kind: kind ?? 'unknown',
      path: path ?? 'unknown',
      idToken,
      status: 'error',
      lastSeen: now,
      error: 'suppressed',
    })
    deltaErrors++
  })

  discovery.on('device:lost', async ({ id }) => {
    const rec = id ? devices.get(id) : undefined
    const kind = rec?.kind

    remove(id)
    log.warn(`device lost id=${id}`)

    if (kind === 'serial.powermeter' && (app as any).powerMeter) {
      const pm = (app as any).powerMeter as {
        onDeviceLost: (info: { id: string }) => Promise<void> | void
      }

      try {
        await pm.onDeviceLost({ id })
      } catch (err) {
        log.warn(
          `powerMeter.onDeviceLost failed id=${id} err="${
            (err as Error).message
          }"`
        )
      }
    }

    if (kind === 'serial.printer' && (app as any).serialPrinter) {
      const sp = (app as any).serialPrinter as {
        onDeviceLost: (info: { id: string }) => Promise<void> | void
      }

      try {
        await sp.onDeviceLost({ id })
      } catch (err) {
        log.warn(
          `serialPrinter.onDeviceLost failed id=${id} err="${
            (err as Error).message
          }"`
        )
      }
    }

    // 👉 Atlona controller lost wiring
    if (kind === 'arduino.atlonacontroller' && (app as any).atlonaController) {
      const controller = (app as any).atlonaController as {
        onDeviceLost: (info: { id: string }) => Promise<void> | void
      }

      try {
        await controller.onDeviceLost({ id })
      } catch (err) {
        log.warn(
          `atlonaController.onDeviceLost failed id=${id} err="${
            (err as Error).message
          }"`
        )
      }
    }

    // 👉 PS2 keyboard lost wiring
    if (kind === 'arduino.ps2.keyboard' && (app as any).ps2Keyboard) {
      const kb = (app as any).ps2Keyboard as {
        onDeviceLost: (info: { id: string }) => Promise<void> | void
      }

      try {
        await kb.onDeviceLost({ id })
      } catch (err) {
        log.warn(
          `ps2Keyboard.onDeviceLost failed id=${id} err="${
            (err as Error).message
          }"`
        )
      }
    }

    // ✅ PS2 mouse lost wiring
    if (kind === 'arduino.ps2.mouse') {
      const hook = (app as any).ps2MouseOnDeviceLost as
        | ((info: { id: string }) => Promise<void> | void)
        | undefined

      const svc = (app as any).ps2Mouse as
        | { onDeviceLost: (info: { id: string }) => Promise<void> | void }
        | undefined

      try {
        if (typeof hook === 'function') {
          await hook({ id })
        } else if (svc?.onDeviceLost) {
          await svc.onDeviceLost({ id })
        }
      } catch (err) {
        log.warn(
          `ps2Mouse.onDeviceLost failed id=${id} err="${(err as Error).message}"`
        )
      }
    }

    // 👉 Front panel lost wiring
    if (kind === 'arduino.frontpanel' && (app as any).frontPanel) {
      const fpSvc = (app as any).frontPanel as {
        onDeviceLost: (info: { id: string }) => Promise<void> | void
      }

      try {
        await fpSvc.onDeviceLost({ id })
      } catch (err) {
        log.warn(
          `frontPanel.onDeviceLost failed id=${id} err="${
            (err as Error).message
          }"`
        )
      }
    }
  })

  app.addHook('onReady', async () => {
    const identifyDefaults: IdentifyConfig = {
      request: 'identify',
      completion: 'identify_complete',
      parserDelimiter: '\r\n',
      writeLineEnding: '\n',
      timeoutMs: 5000,
      retries: 3,
    }

    const options: SerialDiscoveryOptions = {
      matchers: runtimeMatchers,
      identify: { ...identifyDefaults, ...(effective.identify ?? {}) },
      defaultBaudRate: effective.defaultBaudRate,
      rescanIntervalMs: effective.rescanIntervalMs,
      logPrefix: effective.logPrefix,
      settleWindowMs: startupTimeoutMs,
    }

    log.info(
      `startup scan begin matchers=${runtimeMatchers.length} startupRequired=${
        startupSpecs.length
      } ` +
        `ids=[${startupSpecs
          .map((s) => s.id ?? '(static)')
          .join(',')}] rescanMs=${effective.rescanIntervalMs ?? 0} ` +
        `timeoutMs=${startupTimeoutMs}`
    )

    // Start discovery; returns quickly.
    await discovery.start(options)

    // 🔑 Gating loop is now *in-line* and blocks onReady until satisfied or timeout.
    const startTs = Date.now()

    while (true) {
      const elapsed = Date.now() - startTs
      const status = getDeviceStatus()

      if (status.ready) {
        log.info(
          `startup scan satisfied after ${elapsed}ms devices=${
            status.devices.length
          } ` +
            `byStatus=${JSON.stringify(status.byStatus)}`
        )

        const summaryEvery = effective.summaryIntervalMs
        if (summaryEvery && summaryEvery > 0) {
          const ms = Math.max(1000, summaryEvery)
          summaryTimer = setInterval(() => {
            logSummary('interval')
          }, ms)
          setTimeout(() => logSummary('startup'), 1000)
        }
        break
      }

      if (elapsed >= startupTimeoutMs) {
        const candidates = status.devices
          .filter(
            (d) => d.status === 'identifying' || d.status === 'ready'
          )
          .map((d) => ({
            idToken: d.idToken ?? '(none)',
            kind: d.kind,
            status: d.status,
            path: d.path,
            vid: d.vid,
            pid: d.pid,
            baud: d.baudRate,
          }))

        if (candidates.length > 0) {
          log.warn(`startup candidates: ${JSON.stringify(candidates)}`)
        }

        const ids = status.missing.map((m) => m.id).join(',')
        const msg = `startup requirement not met; missing ids=[${ids}]`

        if (failOnMissing && startupSpecs.length > 0) {
          log.error(msg)
          try {
            await discovery.stop()
          } catch {
            /* ignore */
          }
          // 🔴 Instead of process.exit(1), throw to let Fastify/server.ts handle it.
          throw new Error(msg)
        } else {
          log.warn(msg)

          const summaryEvery = effective.summaryIntervalMs
          if (summaryEvery && summaryEvery > 0) {
            const ms = Math.max(1000, summaryEvery)
            summaryTimer = setInterval(() => {
              logSummary('interval')
            }, ms)
            setTimeout(() => logSummary('startup'), 1000)
          }
          break
        }
      }

      await sleep(100)
    }
  })

  // ---------------------- app.onClose cleanup --------------------------------
  app.addHook('onClose', async () => {
    const sz = devices.size
    log.info(`stopping serial discovery totalDevices=${sz}`)
    try {
      await discovery.stop()
    } catch {
      /* ignore */
    }
    if (summaryTimer) {
      clearInterval(summaryTimer)
      summaryTimer = null
    }
    if (sz > 0 || deltaIdentified + deltaErrors + deltaLost > 0) {
      logSummary('shutdown')
    }
    log.info('serial discovery stopped')
  })
})

/* ----------------------------- readiness utils ----------------------------- */

function normalizeHex(v?: string): string | undefined {
  if (!v) return undefined
  return String(v).toLowerCase().replace(/^0x/, '')
}

function specMatchesRecord(
  spec: RequiredSpec & { _pathRe?: RegExp },
  rec: DeviceRecord
): boolean {
  // Accept either 'identifying' or 'ready' as "present" for startup.
  const acceptable =
    rec.status === 'identifying' || rec.status === 'ready'
  if (!acceptable) return false

  if (spec.id) {
    if (rec.idToken && spec.id !== rec.idToken) return false
    if (!rec.idToken) {
      if (!spec.kind) return false
    }
  }

  if (spec.kind && spec.kind !== rec.kind) return false
  if (spec.vendorId) {
    const recVid = normalizeHex(rec.vid)
    if (!recVid || recVid !== normalizeHex(spec.vendorId)) return false
  }
  if (spec.productId) {
    const recPid = normalizeHex(rec.pid)
    if (!recPid || recPid !== normalizeHex(spec.productId)) return false
  }
  if (spec._pathRe) {
    if (!rec.path || !spec._pathRe.test(rec.path)) return false
  }
  if (typeof spec.baudRate === 'number') {
    if (rec.baudRate !== spec.baudRate) return false
  }
  return true
}

function computeMissingSinglePass(
  specs: Array<RequiredSpec & { _pathRe?: RegExp }>,
  devs: Map<string, DeviceRecord>
) {
  const candidates = Array.from(devs.values()).filter(
    (d) => d.status === 'identifying' || d.status === 'ready'
  )
  const missing: Array<{ id: string; kind?: string }> = []
  for (const spec of specs) {
    const ok = candidates.some((rec) => specMatchesRecord(spec, rec))
    if (!ok) missing.push({ id: spec.id ?? '(static)', kind: spec.kind })
  }
  return missing
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}
