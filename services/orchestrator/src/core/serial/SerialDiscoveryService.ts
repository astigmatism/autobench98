/* eslint-disable no-console */
import { EventEmitter } from 'events'
import { SerialPort } from 'serialport'
import { ReadlineParser } from '@serialport/parser-readline'

/**
 * A matcher declares how we recognize and classify a device.
 *
 * Two modes:
 *  - Active (token-first): identificationString is present (e.g., 'KB' | 'MS' | 'FP').
 *    We open the port and send 'identify', then match by the returned token.
 *  - Static (no-probe): identifyRequired=false, match by VID/PID/pathRegex/serialNumber only.
 *    We do NOT send any commands. Optionally keep the port open.
 *
 * NOTE: Matchers are provided at runtime by the orchestrator plugin; there is no env-driven
 * matcher parsing here.
 *
 * Safety-critical ownership rule:
 *  - SerialDiscoveryService must NOT keep active/token-first ports open after identification.
 *    Dedicated device services must own those ports exclusively.
 */
export interface SerialMatcher {
  kind: string // e.g. 'arduino.ps2.keyboard', 'serial.printer', 'serial.powermeter'
  identificationString?: string // token device returns to 'identify' (active mode)
  vendorId?: string // optional coarse/static filters (hex, e.g. "0403")
  productId?: string
  serialNumber?: string // optional exact device binding (e.g. "A7005IDU")
  pathRegex?: RegExp
  baudRate?: number // override per matcher

  // --- static mode controls ---
  identifyRequired?: boolean // default: true. Set false to use static mode (no identify write).
  keepOpenOnStatic?: boolean // default: false. If true, keep port open after static recognition.
}

/** Handshake configuration for identification (active mode). */
export interface IdentifyConfig {
  request: string // 'identify'
  successResponse?: string // rarely useful in token-first mode
  completion?: string // 'identify_complete' (NOTE: discovery does not send completion)
  writeLineEnding?: '\n' | '\r\n'
  parserDelimiter?: '\n' | '\r\n' // Arduino println is CRLF => '\r\n'
  timeoutMs?: number // per read attempt
  retries?: number // per port (open/write/read retries)
}

/** Discovery options */
export interface SerialDiscoveryOptions {
  matchers: SerialMatcher[]
  defaultBaudRate?: number
  identify: IdentifyConfig
  rescanIntervalMs?: number // 0/undefined = single pass only
  logPrefix?: string
  /** Purely informational for upper layers; not used internally for timers. */
  settleWindowMs?: number
}

/** Events emitted by the service */
export interface SerialDiscoveryEvents {
  log: (evt: {
    level: 'debug' | 'info' | 'warn' | 'error'
    msg: string
    meta?: Record<string, unknown>
  }) => void
  'device:identifying': (evt: {
    id: string
    path: string
    vid?: string
    pid?: string
    kind: string
  }) => void
  'device:identified': (evt: {
    id: string
    path: string
    vid?: string
    pid?: string
    kind: string
    baudRate: number
  }) => void
  'device:error': (evt: { id?: string; path?: string; kind?: string; error: Error }) => void
  'device:lost': (evt: { id: string }) => void
}

/** Minimal typed EventEmitter */
type EventNames = keyof SerialDiscoveryEvents
class TypedEmitter extends EventEmitter {
  override on<T extends EventNames>(event: T, listener: SerialDiscoveryEvents[T]): this {
    return super.on(event, listener as any)
  }
  override off<T extends EventNames>(event: T, listener: SerialDiscoveryEvents[T]): this {
    return super.off(event, listener as any)
  }
  override emit<T extends EventNames>(event: T, ...args: Parameters<SerialDiscoveryEvents[T]>): boolean {
    return super.emit(event, ...(args as any))
  }
}

/**
 * SerialDiscoveryService (hybrid: token-first + static, non-blocking)
 *
 * NOTE: `start()` returns quickly; scans run in the background so callers
 * (e.g. Fastify onReady hooks) aren’t blocked.
 */
export class SerialDiscoveryService extends TypedEmitter {
  private options!: SerialDiscoveryOptions
  private started = false

  // Live resources owned by discovery
  private openPorts = new Map<string, SerialPort>()
  private parsers = new Map<string, ReadlineParser>()

  // Recognition bookkeeping
  private claimedPaths = new Set<string>() // paths with a successful recognition
  private claimedIdByPath = new Map<string, string>() // stable IDs for device:lost

  // Rescan/lifecycle
  private rescanTimer: NodeJS.Timeout | null = null

  public async start(opts: SerialDiscoveryOptions): Promise<void> {
    if (this.started) return
    this.started = true

    const defaultIdentify: IdentifyConfig = {
      request: 'identify',
      completion: 'identify_complete',
      writeLineEnding: '\n',
      parserDelimiter: '\r\n', // Arduino Serial.println -> CRLF
      timeoutMs: 5000,
      retries: 3,
    }

    this.options = {
      ...opts,
      defaultBaudRate: opts.defaultBaudRate ?? 9600,
      identify: {
        ...defaultIdentify,
        ...(opts.identify ?? {}),
      },
      settleWindowMs: opts.settleWindowMs ?? 1500,
    }

    this.emitLog(
      'info',
      `serial discovery start matchers=${this.options.matchers.length} rescanMs=${
        this.options.rescanIntervalMs ?? 0
      }`
    )

    void this.scanOnce().catch((err) => {
      const e = err instanceof Error ? err : new Error(String(err))
      this.emitLog('debug', `initial scan failed err="${e.message}"`)
    })

    if (this.options.rescanIntervalMs && this.options.rescanIntervalMs > 0) {
      this.rescanTimer = setInterval(() => {
        this.scanOnce().catch((err) => this.emitLog('debug', `rescan failed err="${(err as Error).message}"`))
      }, this.options.rescanIntervalMs)
    }
  }

  public async stop(): Promise<void> {
    this.started = false
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer)
      this.rescanTimer = null
    }

    const toClose = Array.from(this.openPorts.entries())
    await Promise.allSettled(
      toClose.map(async ([path, port]) => {
        try {
          await new Promise<void>((resolve) => port.close(() => resolve()))
        } catch (err) {
          this.emitLog('debug', `close error path=${path} err="${(err as Error).message}"`)
        }
      })
    )

    this.parsers.clear()
    this.openPorts.clear()
    this.claimedPaths.clear()
    this.claimedIdByPath.clear()
    this.emitLog('info', 'serial discovery stopped')
  }

  // ----- core flow -----
  private async scanOnce(): Promise<void> {
    const ports = await SerialPort.list()
    const present = new Set<string>(ports.map((p) => p.path).filter(Boolean) as string[])

    // Detect lost devices (by missing path)
    for (const path of Array.from(this.claimedPaths)) {
      if (!present.has(path)) {
        await this.safeClose(path)
        this.claimedPaths.delete(path)

        const id = this.claimedIdByPath.get(path) ?? this.makeDeviceId('unknown', path, undefined, undefined)
        this.claimedIdByPath.delete(path)

        this.emit('device:lost', { id })
        this.emitLog('warn', `lost path=${path} id=${id}`)
      }
    }

    // Probe each available path (sequentially)
    for (const info of ports) {
      const path = info.path
      if (!path) continue
      if (this.claimedPaths.has(path)) continue

      const eligible = this.eligibleMatchersForPath(path, info.vendorId, info.productId, info.serialNumber)
      if (eligible.length === 0) continue

      const vid = normalizeHex(info.vendorId)
      const pid = normalizeHex(info.productId)
      const serial = info.serialNumber

      const tempKind = 'unknown'
      const tempId = this.makeDeviceId(tempKind, path, vid, pid)
      this.emit('device:identifying', { id: tempId, path, vid, pid, kind: tempKind })

      try {
        let active = eligible.filter((m) => m.identifyRequired !== false && !!m.identificationString)
        const statics = eligible.filter((m) => m.identifyRequired === false)
        let baudUsed = this.options.defaultBaudRate!

        const staticIsExact = this.hasExactStaticMatch(statics, vid, pid, serial)

        if (staticIsExact) {
          this.emitLog(
            'info',
            `static exact match; skipping active identify path=${path} vid=${vid ?? 'n/a'} pid=${pid ?? 'n/a'} serial=${
              serial ?? 'n/a'
            }`
          )
          active = []
        }

        // 1) Active/token-first: send 'identify' and map by token.
        if (active.length > 0) {
          try {
            const { token, baudUsed: tokenBaud } = await this.readIdentityToken(path)
            baudUsed = tokenBaud

            const matched = this.findMatcherByTokenAndFilters(token, path, vid, pid, serial, active)
            if (matched) {
              const id = this.makeDeviceId(matched.kind, path, vid, pid)
              await this.onRecognized(path, matched, id, vid, pid, baudUsed, true)
              continue
            }
          } catch (err: any) {
            const e = err instanceof Error ? err : new Error(String(err))
            this.emitLog('debug', `active identify failed path=${path} err="${e.message}"`)
          }
        }

        // 2) Static
        if (statics.length > 0) {
          const pick = this.pickBestStatic(statics, path, vid, pid, serial)
          if (pick) {
            const id = this.makeDeviceId(pick.kind, path, vid, pid)
            await this.onRecognized(path, pick, id, vid, pid, pick.baudRate ?? baudUsed, false)
            continue
          }
        }

        this.emitLog('debug', `no successful match after active/static probing path=${path}`)
        throw new Error('No matching matcher after probe')
      } catch (err: any) {
        const error = err instanceof Error ? err : new Error(String(err))
        this.emit('device:error', { id: tempId, path, kind: tempKind, error })
        this.emitLog('debug', `probe failed path=${path} err="${error.message}"`)
      } finally {
        if (!this.claimedPaths.has(path)) {
          await this.safeClose(path)
        }
      }
    }
  }

  private eligibleMatchersForPath(path: string, vendorId?: string, productId?: string, serialNumber?: string): SerialMatcher[] {
    const vid = normalizeHex(vendorId)
    const pid = normalizeHex(productId)
    const sn = serialNumber?.toString()

    const list = (this.options.matchers ?? []).filter((m) => {
      const okPath = m.pathRegex ? m.pathRegex.test(path) : true

      const okVid = m.vendorId && vid ? normalizeHex(m.vendorId) === vid : true
      const okPid = m.productId && pid ? normalizeHex(m.productId) === pid : true
      const okSn = m.serialNumber && sn ? m.serialNumber === sn : true

      return okPath && okVid && okPid && okSn
    })

    this.emitLog(
      'debug',
      `eligible matchers for path=${path} count=${list.length} vid=${vid ?? 'n/a'} pid=${pid ?? 'n/a'} serial=${sn ?? 'n/a'}`
    )

    return list
  }

  private hasExactStaticMatch(statics: SerialMatcher[], vid?: string, pid?: string, serialNumber?: string): boolean {
    const vidN = normalizeHex(vid)
    const pidN = normalizeHex(pid)
    const sn = serialNumber?.toString()

    for (const m of statics) {
      if (m.serialNumber && sn && m.serialNumber === sn) return true

      const matchesVid = m.vendorId && vidN ? normalizeHex(m.vendorId) === vidN : false
      const matchesPid = m.productId && pidN ? normalizeHex(m.productId) === pidN : false

      if (m.vendorId && m.productId && matchesVid && matchesPid) return true
    }

    return false
  }

  private makeDeviceId(kind: string, path: string, vid?: string, pid?: string): string {
    return `usb:${vid ?? 'unknown'}:${pid ?? 'unknown'}:${kind}:${path}`
  }

  /** Open, send identify, return raw token. Always closes the port. */
  private async readIdentityToken(path: string): Promise<{ token: string; baudUsed: number }> {
    const baudRate = this.options.defaultBaudRate!
    const { request, writeLineEnding, parserDelimiter, timeoutMs, retries } = this.options.identify

    let attempt = 0
    let lastErr: Error | null = null

    while (attempt < (retries ?? 1)) {
      attempt++
      try {
        const { port, parser } = await this.openPort(path, baudRate, parserDelimiter ?? '\r\n')

        const line = await this.requestIdentify(port, parser, `${request}${writeLineEnding ?? '\n'}`, timeoutMs ?? 5000)
        const token = (line ?? '').trim()
        if (!token) throw new Error('Empty identify response')

        await this.closeNow(path, port)
        return { token, baudUsed: baudRate }
      } catch (err: any) {
        const e = err instanceof Error ? err : new Error(String(err))
        lastErr = e
        await this.safeClose(path)
        await sleep(250)
      }
    }

    throw lastErr ?? new Error('identify failed')
  }

  private findMatcherByTokenAndFilters(
    token: string,
    path: string,
    vid?: string,
    pid?: string,
    serialNumber?: string,
    candidates?: SerialMatcher[]
  ): SerialMatcher | undefined {
    const tokenLower = token.toLowerCase()
    const list = candidates ?? this.options.matchers
    const vidN = normalizeHex(vid)
    const pidN = normalizeHex(pid)
    const sn = serialNumber?.toString()

    for (const m of list) {
      if (m.identifyRequired === false) continue
      if (!m.identificationString) continue
      if (m.identificationString.toLowerCase() !== tokenLower) continue

      const okPath = m.pathRegex ? m.pathRegex.test(path) : true
      const okVid = m.vendorId && vidN ? normalizeHex(m.vendorId) === vidN : true
      const okPid = m.productId && pidN ? normalizeHex(m.productId) === pidN : true
      const okSn = m.serialNumber && sn ? m.serialNumber === sn : true

      if (okPath && okVid && okPid && okSn) return m
    }

    return undefined
  }

  private pickBestStatic(statics: SerialMatcher[], path: string, vid?: string, pid?: string, serialNumber?: string): SerialMatcher | undefined {
    const vidN = normalizeHex(vid)
    const pidN = normalizeHex(pid)
    const sn = serialNumber?.toString()

    const scored = statics
      .map((m) => {
        let score = 0
        if (m.vendorId && vidN && normalizeHex(m.vendorId) === vidN) score += 2
        if (m.productId && pidN && normalizeHex(m.productId) === pidN) score += 2
        if (m.pathRegex && m.pathRegex.test(path)) score += 1
        if (m.serialNumber && sn && m.serialNumber === sn) score += 3
        return { m, score }
      })
      .filter((x) => x.score > 0)

    if (scored.length === 0) return undefined
    scored.sort((a, b) => b.score - a.score)
    return scored[0].m
  }

  private async onRecognized(
    path: string,
    matched: SerialMatcher,
    id: string,
    vid: string | undefined,
    pid: string | undefined,
    baud: number,
    fromActive: boolean
  ): Promise<void> {
    // Safety-critical ownership: never keep active/token-first ports open.
    const keepOpen = fromActive ? false : matched.keepOpenOnStatic === true

    // Ensure discovery releases the FD unless explicitly configured for static keep-open.
    if (!keepOpen) {
      await this.safeClose(path)
    } else {
      await this.openPort(path, matched.baudRate ?? baud, this.options.identify.parserDelimiter ?? '\r\n')
    }

    this.claimedPaths.add(path)
    this.claimedIdByPath.set(path, id)

    this.emit('device:identified', {
      id,
      path,
      vid,
      pid,
      kind: matched.kind,
      baudRate: matched.baudRate ?? baud,
    })
    this.emitLog('info', `identified path=${path} kind=${matched.kind} mode=${fromActive ? 'active' : 'static'} baud=${matched.baudRate ?? baud}`)
  }

  private async openPort(path: string, baudRate: number, delimiter: string): Promise<{ port: SerialPort; parser: ReadlineParser }> {
    // Close any prior discovery-owned port for this path first.
    await this.safeClose(path)

    // IMPORTANT: do not disable OS locking. Let exclusive ownership fail loudly.
    const port = new SerialPort({ path, baudRate, autoOpen: false })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Timeout opening ${path} @ ${baudRate}`))
      }, 3000)
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = (err: Error) => {
        cleanup()
        reject(err)
      }
      const cleanup = () => {
        clearTimeout(timer)
        port.off('open', onOpen)
        port.off('error', onError)
      }

      port.on('open', onOpen)
      port.on('error', onError)
      port.open()
    })

    const parser = port.pipe(new ReadlineParser({ delimiter }))

    // Track for safeClose/stop cleanup.
    this.openPorts.set(path, port)
    this.parsers.set(path, parser)

    port.on('close', () => {
      if (this.openPorts.get(path) === port) {
        this.openPorts.delete(path)
        this.parsers.delete(path)
      }
    })

    return { port, parser }
  }

  private async requestIdentify(port: SerialPort, parser: ReadlineParser, requestLine: string, timeoutMs: number): Promise<string> {
    await this.flushAndDrain(port)

    const response = await new Promise<string>((resolve, reject) => {
      const onData = (data: string) => {
        const trimmed = (data ?? '').toString().trim()
        if (!trimmed) return
        const lower = trimmed.toLowerCase()
        if (lower.startsWith('debug:')) return
        cleanup()
        resolve(trimmed)
      }
      const onError = (err: Error) => {
        cleanup()
        reject(err)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Identify timeout'))
      }, timeoutMs)

      const cleanup = () => {
        clearTimeout(timer)
        parser.off('data', onData)
        parser.off('error', onError)
      }

      parser.on('data', onData)
      parser.on('error', onError)

      port.write(requestLine, (err) => {
        if (err) {
          cleanup()
          reject(err)
        }
      })
    })

    return response
  }

  private async flushAndDrain(port: SerialPort): Promise<void> {
    await new Promise<void>((resolve) => port.flush(() => resolve()))
    await new Promise<void>((resolve) => port.drain(() => resolve()))
  }

  private async closeNow(path: string, port: SerialPort): Promise<void> {
    await new Promise<void>((resolve) => port.close(() => resolve()))
    if (this.openPorts.get(path) === port) this.openPorts.delete(path)
    this.parsers.delete(path)
  }

  private async safeClose(path: string): Promise<void> {
    const port = this.openPorts.get(path)
    if (!port) return
    await new Promise<void>((resolve) => port.close(() => resolve()))
    this.openPorts.delete(path)
    this.parsers.delete(path)
    this.emitLog('debug', `safeClose path=${path}`)
  }

  private emitLog(level: 'debug' | 'info' | 'warn' | 'error', msg: string, _meta?: Record<string, unknown>) {
    const prefix = this.options?.logPrefix ? `[${this.options.logPrefix}] ` : ''
    this.emit('log', { level, msg: `${prefix}${msg}` })
  }
}

// ---------- utils ----------
function normalizeHex(v?: string): string | undefined {
  if (!v) return undefined
  return v.toString().replace(/^0x/i, '').toLowerCase()
}
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}
