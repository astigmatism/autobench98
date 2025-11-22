/* eslint-disable no-console */
// services/orchestrator/src/core/serial/SerialDiscoveryService.ts
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
 */
export interface SerialMatcher {
  kind: string                     // e.g. 'arduino.ps2.keyboard', 'serial.printer', 'serial.powermeter'
  identificationString?: string    // token device returns to 'identify' (active mode)
  vendorId?: string                // optional coarse/static filters (hex, e.g. "0403")
  productId?: string
  serialNumber?: string            // optional exact device binding (e.g. "A7005IDU")
  pathRegex?: RegExp
  baudRate?: number                // override per matcher

  // --- static mode controls ---
  identifyRequired?: boolean       // default: true. Set false to use static mode (no identify write).
  keepOpenOnStatic?: boolean       // default: false. If true, keep port open after static recognition.
}

/** Handshake configuration for identification (active mode). */
export interface IdentifyConfig {
  request: string                  // 'identify'
  successResponse?: string         // rarely useful in token-first mode
  completion?: string              // 'identify_complete'
  writeLineEnding?: '\n' | '\r\n'
  parserDelimiter?: '\n' | '\r\n'  // Arduino println is CRLF => '\r\n'
  timeoutMs?: number               // per read attempt
  retries?: number                 // per port (open/write/read retries)
}

/** Discovery options */
export interface SerialDiscoveryOptions {
  matchers: SerialMatcher[]
  defaultBaudRate?: number
  identify: IdentifyConfig
  rescanIntervalMs?: number        // 0/undefined = single pass only
  logPrefix?: string
  /** Purely informational for upper layers; not used internally for timers. */
  settleWindowMs?: number
}

/** Events emitted by the service */
export interface SerialDiscoveryEvents {
  'log': (evt: { level: 'debug' | 'info' | 'warn' | 'error'; msg: string; meta?: Record<string, unknown> }) => void
  'device:identifying': (evt: { id: string; path: string; vid?: string; pid?: string; kind: string }) => void
  'device:identified': (evt: { id: string; path: string; vid?: string; pid?: string; kind: string; baudRate: number }) => void
  'device:error': (evt: { id?: string; path?: string; kind?: string; error: Error }) => void
  'device:lost': (evt: { id: string }) => void
}

/** Minimal typed EventEmitter */
type EventNames = keyof SerialDiscoveryEvents;
class TypedEmitter extends EventEmitter {
  override on<T extends EventNames>(event: T, listener: SerialDiscoveryEvents[T]): this { return super.on(event, listener as any) }
  override off<T extends EventNames>(event: T, listener: SerialDiscoveryEvents[T]): this { return super.off(event, listener as any) }
  override emit<T extends EventNames>(event: T, ...args: Parameters<SerialDiscoveryEvents[T]>): boolean {
    return super.emit(event, ...(args as any))
  }
}

/**
 * SerialDiscoveryService (hybrid: token-first + static)
 */
export class SerialDiscoveryService extends TypedEmitter {
  private options!: SerialDiscoveryOptions
  private started = false

  // Live resources
  private openPorts = new Map<string, SerialPort>()
  private parsers = new Map<string, ReadlineParser>()
  private claimedPaths = new Set<string>() // paths with a successful recognition

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

    // Single concise startup line
    this.emitLog(
      'info',
      `serial discovery start matchers=${this.options.matchers.length} rescanMs=${this.options.rescanIntervalMs ?? 0}`
    )

    await this.scanOnce()

    if (this.options.rescanIntervalMs && this.options.rescanIntervalMs > 0) {
      this.rescanTimer = setInterval(() => {
        this.scanOnce().catch((err) =>
          this.emitLog('debug', `rescan failed err="${err.message}"`)
        )
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
    this.emitLog('info', 'serial discovery stopped')
  }

  // ----- core flow -----
  private async scanOnce(): Promise<void> {
    const ports = await SerialPort.list()
    const present = new Set<string>(ports.map(p => p.path).filter(Boolean) as string[])

    // Detect lost devices
    for (const path of Array.from(this.claimedPaths)) {
      if (!present.has(path)) {
        await this.safeClose(path)
        this.claimedPaths.delete(path)
        const id = this.makeDeviceId('unknown', path, undefined, undefined)
        this.emit('device:lost', { id })
        this.emitLog('warn', `lost path=${path}`)
      }
    }

    // Probe each available path (sequentially)
    for (const info of ports) {
      const path = info.path
      if (!path) continue
      if (this.claimedPaths.has(path)) continue

      // If *no* matcher considers this path eligible, skip quickly.
      const eligible = this.eligibleMatchersForPath(
        path,
        info.vendorId,
        info.productId,
        info.serialNumber
      )
      if (eligible.length === 0) continue

      const vid = normalizeHex(info.vendorId)
      const pid = normalizeHex(info.productId)
      const serial = info.serialNumber

      // Announce a probe (kind unknown at this point)
      const tempKind = 'unknown'
      const tempId = this.makeDeviceId(tempKind, path, vid, pid)
      this.emit('device:identifying', { id: tempId, path, vid, pid, kind: tempKind })

      try {
        // 1) Active/token-first: send 'identify' and map by token.
        const active = eligible.filter(m => m.identifyRequired !== false && !!m.identificationString)
        if (active.length > 0) {
          const { token, baudUsed } = await this.readIdentityToken(path)
          const matched = this.findMatcherByTokenAndFilters(
            token,
            path,
            vid,
            pid,
            serial,
            active
          )
          if (matched) {
            const id = this.makeDeviceId(matched.kind, path, vid, pid)
            await this.onRecognized(
              path,
              matched,
              id,
              vid,
              pid,
              baudUsed,
              /*fromActive=*/true
            )
            continue
          } else {
            this.emitLog('debug', `token "${token}" not in active set for path=${path}`)
          }
        }

        // 2) Static: choose a matcher that fits VID/PID/pathRegex/serialNumber without probing.
        const statics = eligible.filter(m => m.identifyRequired === false)
        if (statics.length > 0) {
          const pick = this.pickBestStatic(statics, path, vid, pid, serial)
          if (pick) {
            const id = this.makeDeviceId(pick.kind, path, vid, pid)
            await this.onRecognized(
              path,
              pick,
              id,
              vid,
              pid,
              pick.baudRate ?? this.options.defaultBaudRate!,
              /*fromActive=*/false
            )
            continue
          }
        }

        // If we get here, we couldn't positively match the device.
        throw new Error('No matching matcher after probe')
      } catch (err: any) {
        this.emit('device:error', {
          id: tempId,
          path,
          kind: tempKind,
          error: err instanceof Error ? err : new Error(String(err))
        })
        // Downgraded to debug so failures don't flood normal logs
        this.emitLog('debug', `probe failed path=${path} err="${(err as Error)?.message}"`)
      } finally {
        // Close any unclaimed port
        if (!this.claimedPaths.has(path)) {
          await this.safeClose(path)
        }
      }
    }
  }

  /**
   * Return matchers that would even consider this path (by regex/VID/PID/serial or no filters).
   *
   * serialNumber is an additional positive constraint:
   * - If the matcher has serialNumber, it MUST match exactly.
   * - If the matcher omits serialNumber, we ignore the device serialNumber.
   */
  private eligibleMatchersForPath(
    path: string,
    vendorId?: string,
    productId?: string,
    serialNumber?: string
  ): SerialMatcher[] {
    const vid = normalizeHex(vendorId)
    const pid = normalizeHex(productId)
    const sn = serialNumber?.toString()

    return (this.options.matchers ?? []).filter(m => {
      const okPath = m.pathRegex ? m.pathRegex.test(path) : true
      const okVid  = m.vendorId ? normalizeHex(m.vendorId) === vid : true
      const okPid  = m.productId ? normalizeHex(m.productId) === pid : true
      const okSn   = m.serialNumber ? m.serialNumber === sn : true
      return okPath && okVid && okPid && okSn
    })
  }

  private makeDeviceId(kind: string, path: string, vid?: string, pid?: string): string {
    return `usb:${vid ?? 'unknown'}:${pid ?? 'unknown'}:${kind}:${path}`
  }

  /** Open, send identify, return raw token. Keeps port closed unless recognized. */
  private async readIdentityToken(path: string): Promise<{ token: string; baudUsed: number }> {
    const baudRate = this.options.defaultBaudRate!
    const { request, writeLineEnding, parserDelimiter, timeoutMs, retries } = this.options.identify

    let attempt = 0
    let lastErr: Error | null = null

    while (attempt < (retries ?? 1)) {
      attempt++
      try {
        const { port, parser } = await this.openPort(path, baudRate, parserDelimiter ?? '\r\n')

        const line = await this.requestIdentify(
          port,
          parser,
          `${request}${writeLineEnding ?? '\n'}`,
          timeoutMs ?? 5000
        )

        const token = (line ?? '').trim()
        if (!token) throw new Error('Empty identify response')

        // Close here; we'll reopen/keep-open if we actually claim it.
        await this.closeNow(path, port)
        return { token, baudUsed: baudRate }
      } catch (err: any) {
        lastErr = err instanceof Error ? err : new Error(String(err))
        await sleep(250)
        await this.safeClose(path)
      }
    }

    throw lastErr ?? new Error('identify failed')
  }

  /**
   * Match a token to one of the provided active matchers, honoring optional
   * VID/PID/path/serial filters again.
   */
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
      const okVid  = m.vendorId ? normalizeHex(m.vendorId) === vidN : true
      const okPid  = m.productId ? normalizeHex(m.productId) === pidN : true
      const okSn   = m.serialNumber ? m.serialNumber === sn : true

      if (okPath && okVid && okPid && okSn) return m
    }
    return undefined
  }

  /** Choose the static matcher with the strongest constraints satisfied. */
  private pickBestStatic(
    statics: SerialMatcher[],
    path: string,
    vid?: string,
    pid?: string,
    serialNumber?: string
  ): SerialMatcher | undefined {
    const vidN = normalizeHex(vid)
    const pidN = normalizeHex(pid)
    const sn = serialNumber?.toString()

    const scored = statics
      .map(m => {
        let score = 0
        if (m.vendorId && normalizeHex(m.vendorId) === vidN) score += 2
        if (m.productId && normalizeHex(m.productId) === pidN) score += 2
        if (m.pathRegex && m.pathRegex.test(path)) score += 1
        if (m.serialNumber && m.serialNumber === sn) score += 3 // strong tie to a specific device
        return { m, score }
      })
      .filter(x => x.score > 0)

    if (scored.length === 0) return undefined
    scored.sort((a, b) => b.score - a.score)
    return scored[0].m
  }

  /** Handle a recognized device (both active and static). */
  private async onRecognized(
    path: string,
    matched: SerialMatcher,
    id: string,
    vid: string | undefined,
    pid: string | undefined,
    baud: number,
    fromActive: boolean
  ): Promise<void> {
    // Open & optionally finalize handshake for active; for static, open if keeping open.
    if (fromActive) {
      const { port, parser } = await this.openPort(
        path,
        matched.baudRate ?? baud,
        this.options.identify.parserDelimiter ?? '\r\n'
      )

      const completion = this.options.identify.completion
      if (completion) {
        try {
          await this.writeLine(
            port,
            `${completion}${this.options.identify.writeLineEnding ?? '\n'}`
          )
        } catch {
          // non-fatal
        }
      }

      this.openPorts.set(path, port)
      this.parsers.set(path, parser)
    } else {
      if (matched.keepOpenOnStatic) {
        const { port, parser } = await this.openPort(
          path,
          matched.baudRate ?? baud,
          this.options.identify.parserDelimiter ?? '\r\n'
        )
        this.openPorts.set(path, port)
        this.parsers.set(path, parser)
      } else {
        await this.safeClose(path)
      }
    }

    this.claimedPaths.add(path)
    this.emit('device:identified', {
      id,
      path,
      vid,
      pid,
      kind: matched.kind,
      baudRate: matched.baudRate ?? baud
    })
    this.emitLog(
      'info',
      `identified path=${path} kind=${matched.kind} mode=${fromActive ? 'active' : 'static'} baud=${matched.baudRate ?? baud}`
    )
  }

  // ----- low-level -----
  private async openPort(path: string, baudRate: number, delimiter: string): Promise<{ port: SerialPort; parser: ReadlineParser }> {
    const port = new SerialPort({ path, baudRate, autoOpen: false })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Timeout opening ${path} @ ${baudRate}`)) }, 3000)
      const onOpen = () => { cleanup(); resolve() }
      const onError = (err: Error) => { cleanup(); reject(err) }
      const cleanup = () => { clearTimeout(timer); port.off('open', onOpen); port.off('error', onError) }

      port.on('open', onOpen)
      port.on('error', onError)
      port.open()
    })

    const parser = port.pipe(new ReadlineParser({ delimiter }))
    return { port, parser }
  }

  private async requestIdentify(
    port: SerialPort,
    parser: ReadlineParser,
    requestLine: string,
    timeoutMs: number
  ): Promise<string> {
    await this.flushAndDrain(port)

    const response = await new Promise<string>((resolve, reject) => {
      const onData = (data: string) => { cleanup(); resolve(data) }
      const onError = (err: Error) => { cleanup(); reject(err) }
      const timer = setTimeout(() => { cleanup(); reject(new Error('Identify timeout')) }, timeoutMs)

      const cleanup = () => { clearTimeout(timer); parser.off('data', onData); parser.off('error', onError) }

      parser.on('data', onData)
      parser.on('error', onError)

      port.write(requestLine, (err) => { if (err) { cleanup(); reject(err) } })
    })

    return response
  }

  private async writeLine(port: SerialPort, line: string): Promise<void> {
    await this.flushAndDrain(port)
    await new Promise<void>((resolve, reject) => {
      port.write(line, (err) => (err ? reject(err) : resolve()))
    })
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
function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)) }