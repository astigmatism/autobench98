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
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void
}

export interface SerialPluginOptions {
  matchers?: SerialMatcher[]
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
  id: string              // e.g. "KB"
  kind?: string           // e.g. "arduino.ps2.keyboard"
  vendorId?: string
  productId?: string
  pathRegex?: string
  baudRate?: number
  serialNumber?: string
}

/* ----------------------- env helpers (safe parsing) ----------------------- */
function unescapeLineEnding(s: string | undefined, fallback: '\n' | '\r\n'): '\n' | '\r\n' {
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

function parseMatchersFromEnv(): SerialMatcher[] | undefined {
  const raw = process.env.SERIAL_MATCHERS_JSON
  if (!raw) return undefined
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return undefined
    return arr.map((m: any) => {
      const out: SerialMatcher = {
        kind: String(m.kind),
        identificationString: String(m.identificationString),
      }
      if (m.vendorId != null) out.vendorId = String(m.vendorId)
      if (m.productId != null) out.productId = String(m.productId)
      if (m.pathRegex) {
        try { out.pathRegex = new RegExp(String(m.pathRegex)) } catch { /* ignore bad regex */ }
      }
      if (m.baudRate != null) {
        const br = Number(m.baudRate)
        if (Number.isFinite(br)) out.baudRate = br
      }
      return out
    })
  } catch {
    return undefined
  }
}

function parseRequiredFromEnv(): { specs: Array<RequiredSpec & { _pathRe?: RegExp }>, error?: string } {
  const raw = process.env.SERIAL_REQUIRED_DEVICES_JSON
  if (!raw) return { specs: [] }
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return { specs: [] }
    const specs: Array<RequiredSpec & { _pathRe?: RegExp }> = []
    for (const item of arr) {
      if (!item?.id) continue
      const spec: RequiredSpec & { _pathRe?: RegExp } = {
        id: String(item.id),
        kind: item.kind ? String(item.kind) : undefined,
        vendorId: item.vendorId ? String(item.vendorId).toLowerCase().replace(/^0x/, '') : undefined,
        productId: item.productId ? String(item.productId).toLowerCase().replace(/^0x/, '') : undefined,
        pathRegex: item.pathRegex ? String(item.pathRegex) : undefined,
        baudRate: Number.isFinite(Number(item.baudRate)) ? Number(item.baudRate) : undefined,
        serialNumber: item.serialNumber ? String(item.serialNumber) : undefined,
      }
      if (spec.pathRegex) {
        try { spec._pathRe = new RegExp(spec.pathRegex) } catch { /* ignore bad regex */ }
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
  matchers: SerialMatcher[]
  identify: Partial<IdentifyConfig>
  defaultBaudRate: number
  rescanIntervalMs?: number
  summaryIntervalMs: number
  logPrefix: string
}

export default fp<SerialPluginOptions>(async function serialPlugin(app: FastifyInstance, opts) {
  const devices = new Map<string, DeviceRecord>()
  app.decorate('devices', devices)

  // 👇 Use the SAME buffer the WS plugin broadcasts from
  const { channel } = createLogger('orchestrator:serial', app.clientBuf as ClientLogBuffer | undefined)
  const log = channel(LogChannel.device)

  // -------------------- read env & build effective options -------------------
  const envDefaultBaud = parseIntEnv('SERIAL_DEFAULT_BAUD', 9600)
  const envRescanMs    = parseIntEnv('SERIAL_RESCAN_MS')
  const envSummaryMs   = parseIntEnv('SERIAL_SUMMARY_MS')
  const envLogPrefix   = parseStringEnv('SERIAL_LOG_PREFIX', 'serial')

  const envIdentify: Partial<IdentifyConfig> = {
    request: parseStringEnv('SERIAL_IDENTIFY_REQUEST', 'identify'),
    completion: ((): string | undefined => {
      const v = process.env.SERIAL_IDENTIFY_COMPLETION
      return v === '' ? undefined : (v ?? 'identify_complete')
    })(),
    parserDelimiter: unescapeLineEnding(process.env.SERIAL_PARSER_DELIM, '\r\n'),
    writeLineEnding: unescapeLineEnding(process.env.SERIAL_WRITE_EOL, '\n'),
    timeoutMs: parseIntEnv('SERIAL_TIMEOUT_MS', 5000),
    retries: parseIntEnv('SERIAL_RETRIES', 3),
  }

  const envMatchers = parseMatchersFromEnv()
  const { specs: requiredSpecs, error: requiredParseErr } = parseRequiredFromEnv()
  const failOnMissing = parseBoolEnv('SERIAL_FAIL_ON_MISSING', true)

  const effective: EffectiveOptions = {
    matchers: opts.matchers ?? envMatchers ?? [],
    identify: { ...envIdentify, ...(opts.identify ?? {}) },
    defaultBaudRate: opts.defaultBaudRate ?? envDefaultBaud ?? 9600,
    rescanIntervalMs: opts.rescanIntervalMs ?? envRescanMs, // optional by design
    summaryIntervalMs: (opts.summaryIntervalMs ?? envSummaryMs ?? opts.rescanIntervalMs ?? envRescanMs ?? 15000),
    logPrefix: opts.logPrefix ?? (envLogPrefix ?? 'serial'),
  }
  // --------------------------------------------------------------------------

  // --- concise init logs -----------------------------------------------------
  if (requiredParseErr) {
    log.warn(`SERIAL_REQUIRED_DEVICES_JSON parse error err="${requiredParseErr}"`)
  } else if (requiredSpecs.length > 0) {
    const list = requiredSpecs.map(s => s.id).join(',')
    log.info(`required devices configured ids=[${list}]`)
  }

  const matchersCount = effective.matchers.length
  if (matchersCount === 0) {
    log.warn('serial plugin loaded with no matchers; discovery disabled')
    return
  }

  // Map kind -> idToken (from matchers) so we can record idToken on DeviceRecord
  const kindToIdToken = new Map<string, string>()
  for (const m of effective.matchers) {
    if (m.kind && m.identificationString) kindToIdToken.set(m.kind, m.identificationString)
  }

  const discovery = new SerialDiscoveryService()

  // --- delta counters (for optional summaries) --------------------------------
  let deltaIdentified = 0
  let deltaErrors = 0
  let deltaLost = 0
  let summaryTimer: NodeJS.Timeout | null = null

  const tallyStatus = () => {
    const byStatus: Record<DeviceStatus, number> = { identifying: 0, ready: 0, error: 0, lost: 0 }
    for (const rec of devices.values()) {
      byStatus[rec.status] = (byStatus[rec.status] ?? 0) + 1
    }
    return byStatus
  }

  const logSummary = (reason: string) => {
    const by = tallyStatus()
    log.info(`devices summary reason=${reason} total=${devices.size} byStatus=${JSON.stringify(by)} delta={"identified":${deltaIdentified},"errors":${deltaErrors},"lost":${deltaLost}}`)
    deltaIdentified = 0; deltaErrors = 0; deltaLost = 0
  }
  // ---------------------------------------------------------------------------

  const upsert = (rec: DeviceRecord) => {
    devices.set(rec.id, rec)
    try { opts?.stateAdapter?.upsert?.(rec) } catch (err) {
      log.error(`stateAdapter.upsert failed err="${(err as Error).message}"`)
    }
  }

  const remove = (id: string) => {
    const existed = devices.delete(id)
    try { opts?.stateAdapter?.remove?.(id) } catch (err) {
      log.error(`stateAdapter.remove failed err="${(err as Error).message}"`)
    }
    if (existed) deltaLost++
  }

  // 🔇 Deduplicate “identifying …” spam: one line per (idToken, kind) per boot.
  const announcedIdentifying = new Set<string>()

  // Service → plugin log translation (concise)
  discovery.on('device:identifying', ({ id, path, vid, pid, kind }) => {
    const now = Date.now()
    const idToken = kindToIdToken.get(kind)
    upsert({ id, kind, path, vid, pid, idToken, status: 'identifying', lastSeen: now })

    // Only announce once per token+kind combo. Skip if no idToken (we don’t care about generic USB noise).
    if (idToken) {
      const key = `${idToken}:${kind}`
      if (!announcedIdentifying.has(key)) {
        log.info(`identifying id=${idToken} kind=${kind}`)
        announcedIdentifying.add(key)
      }
    }
  })

  discovery.on('device:identified', ({ id, path, vid, pid, kind, baudRate }) => {
    const now = Date.now()
    const idToken = kindToIdToken.get(kind)
    upsert({ id, kind, path, vid, pid, baudRate, idToken, status: 'ready', lastSeen: now })
    deltaIdentified++
    log.info(`ready id=${idToken ?? 'unknown'} kind=${kind} baud=${baudRate}`)
  })

  discovery.on('device:error', ({ id, path, kind /*, error*/ }) => {
    const now = Date.now()
    const safeId = id ?? `unknown:${path ?? 'unknown'}`
    const idToken = kind ? kindToIdToken.get(kind) : undefined
    upsert({ id: safeId, kind: kind ?? 'unknown', path: path ?? 'unknown', idToken, status: 'error', lastSeen: now, error: 'suppressed' })
    deltaErrors++
  })

  discovery.on('device:lost', ({ id }) => {
    remove(id)
    log.warn(`device lost id=${id}`)
  })

  // ---------------------- boot-time single-scan readiness gate ----------------
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
      matchers: effective.matchers,
      identify: { ...identifyDefaults, ...(effective.identify ?? {}) },
      defaultBaudRate: effective.defaultBaudRate,
      rescanIntervalMs: effective.rescanIntervalMs,
      logPrefix: effective.logPrefix,
    }

    // Start service (it should enumerate/emit immediately).
    await discovery.start(options)

    // ---- Single evaluation of required devices (no countdown, no wait) ----
    if (requiredSpecs.length > 0) {
      const missing = computeMissingSinglePass(requiredSpecs, devices)
      if (missing.length === 0) {
        const list = requiredSpecs.map(s => s.id).join(',')
        log.info(`required devices present at startup ids=[${list}]`)
      } else {
        const ids = missing.map(m => m.id).join(',')
        const msg = `startup requirement not met; missing ids=[${ids}]`
        if (failOnMissing) {
          log.error(msg)
          // Stop discovery so Node can exit cleanly
          try { await discovery.stop() } catch { /* ignore */ }
          throw new Error(msg)
        } else {
          log.warn(msg)
        }
      }
    }

    // Optional periodic summaries (unrelated to startup gating)
    const summaryEvery = effective.summaryIntervalMs
    if (summaryEvery && summaryEvery > 0) {
      const ms = Math.max(1000, summaryEvery)
      summaryTimer = setInterval(() => { logSummary('interval') }, ms)
      setTimeout(() => logSummary('startup'), 1000)
    }
  })

  app.addHook('onClose', async () => {
    const sz = devices.size
    log.info(`stopping serial discovery totalDevices=${sz}`)
    try { await discovery.stop() } catch { /* ignore */ }
    if (summaryTimer) { clearInterval(summaryTimer); summaryTimer = null }
    if (sz > 0 || (deltaIdentified + deltaErrors + deltaLost) > 0) {
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

function specMatchesRecord(spec: RequiredSpec & { _pathRe?: RegExp }, rec: DeviceRecord): boolean {
  // Accept either 'identifying' or 'ready' as "present" for startup.
  const acceptable = rec.status === 'identifying' || rec.status === 'ready'
  if (!acceptable) return false

  // Must match ID token if provided
  if (spec.id && rec.idToken && spec.id !== rec.idToken) return false
  if (spec.id && !rec.idToken) {
    // If we don't yet have idToken (very early), require kind to match to avoid false positives
    if (!spec.kind) return false
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

/** Single-pass: which required specs aren't satisfied by any acceptable device right now */
function computeMissingSinglePass(
  specs: Array<RequiredSpec & { _pathRe?: RegExp }>,
  devs: Map<string, DeviceRecord>
) {
  const candidates = Array.from(devs.values()).filter(d => d.status === 'identifying' || d.status === 'ready')
  const missing: Array<{ id: string; kind?: string }> = []
  for (const spec of specs) {
    const ok = candidates.some(rec => specMatchesRecord(spec, rec))
    if (!ok) missing.push({ id: spec.id, kind: spec.kind })
  }
  return missing
}