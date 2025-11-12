/* eslint-disable no-console */
// services/orchestrator/src/core/serial/SerialDiscoveryService.ts
import { EventEmitter } from 'events'
import { SerialPort } from 'serialport'
import { ReadlineParser } from '@serialport/parser-readline'

/**
 * A matcher declares how we recognize and classify a device.
 */
export interface SerialMatcher {
  kind: string                     // e.g. 'arduino.ps2.keyboard'
  identificationString: string     // expected response to 'identify'
  vendorId?: string                // e.g. '2341'
  productId?: string               // e.g. '8037'
  pathRegex?: RegExp
  baudRate?: number                // override per matcher
}

/**
 * Handshake configuration for identification.
 */
export interface IdentifyConfig {
  request: string                  // 'identify'
  successResponse?: string         // defaults to matcher.identificationString
  completion?: string              // 'identify_complete'
  writeLineEnding?: '\n' | '\r\n'
  parserDelimiter?: '\n' | '\r\n'  // Arduino println is CRLF => '\r\n'
  timeoutMs?: number               // per attempt
  retries?: number                 // per port
}

/**
 * Discovery options
 */
export interface SerialDiscoveryOptions {
  matchers: SerialMatcher[]
  defaultBaudRate?: number
  identify: IdentifyConfig
  rescanIntervalMs?: number        // 0/undefined = single pass only
  logPrefix?: string
}

/** Event contracts emitted by the service */
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
 * SerialDiscoveryService
 * - Enumerates serial ports
 * - Matches ports to configured SerialMatchers
 * - Performs identify handshake and claims paths
 * - Emits events; does NOT mutate external state
 */
export class SerialDiscoveryService extends TypedEmitter {
  private options!: SerialDiscoveryOptions
  private started = false

  private openPorts = new Map<string, SerialPort>()
  private parsers = new Map<string, ReadlineParser>()
  private claimedPaths = new Set<string>()
  private rescanTimer: NodeJS.Timeout | null = null

  public async start(opts: SerialDiscoveryOptions): Promise<void> {
    if (this.started) return
    this.started = true

    // Defaults for the identify handshake
    const defaultIdentify: IdentifyConfig = {
      request: 'identify',
      completion: 'identify_complete',
      writeLineEnding: '\n',
      parserDelimiter: '\r\n', // Arduino Serial.println -> CRLF
      timeoutMs: 5000,
      retries: 3,
    }

    // Merge defaults
    this.options = {
      ...opts,
      defaultBaudRate: opts.defaultBaudRate ?? 9600,
      identify: {
        ...defaultIdentify,
        ...(opts.identify ?? {}),
      }
    }

    // Keep service logs terse and let the plugin decide what to surface.
    this.emitLog('debug', `serial discovery starting m=${this.options.matchers.length} rescanMs=${this.options.rescanIntervalMs ?? 0}`)

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
        try { await new Promise<void>((resolve) => port.close(() => resolve())) }
        catch (err) { this.emitLog('debug', `close error path=${path} err="${(err as Error).message}"`) }
      })
    )

    this.parsers.clear()
    this.openPorts.clear()
    this.emitLog('info', 'serial discovery stopped')
  }

  // ----- core flow -----
  private async scanOnce(): Promise<void> {
    const ports = await SerialPort.list()

    for (const info of ports) {
      const path = info.path
      if (!path) continue
      if (this.claimedPaths.has(path)) continue

      const matcher = this.pickMatcher(info)
      if (!matcher) continue // unmatched ports are uninteresting

      const vid = normalizeHex(info.vendorId)
      const pid = normalizeHex(info.productId)
      const kind = matcher.kind
      const id = this.makeDeviceId(kind, path, vid, pid)

      // Emit identifying event (plugin will produce the visible one-liner)
      this.emit('device:identifying', { id, path, vid, pid, kind })
      this.emitLog('debug', `identifying path=${path} kind=${kind}${vid ? ` vid=${vid}` : ''}${pid ? ` pid=${pid}` : ''}`)

      try {
        await this.identifyOnPort(path, matcher, id, vid, pid)
      } catch (err: any) {
        this.emit('device:error', { id, path, kind, error: err })
        this.emitLog('debug', `identify failed path=${path} kind=${kind} err="${err?.message}"`)
      }
    }
  }

  private pickMatcher(info: Awaited<ReturnType<typeof SerialPort.list>>[number]): SerialMatcher | undefined {
    const path = info.path || ''
    const vid = normalizeHex(info.vendorId)
    const pid = normalizeHex(info.productId)

    for (const m of this.options.matchers) {
      const vidMatch = m.vendorId ? normalizeHex(m.vendorId) === vid : true
      const pidMatch = m.productId ? normalizeHex(m.productId) === pid : true
      const pathMatch = m.pathRegex ? m.pathRegex.test(path) : true
      if (vidMatch && pidMatch && pathMatch) {
        return m
      }
    }
    return undefined
  }

  private makeDeviceId(kind: string, path: string, vid?: string, pid?: string): string {
    return `usb:${vid ?? 'unknown'}:${pid ?? 'unknown'}:${kind}:${path}`
  }

  private async identifyOnPort(
    path: string,
    matcher: SerialMatcher,
    id: string,
    vid?: string,
    pid?: string
  ): Promise<void> {
    const baudRate = matcher.baudRate ?? this.options.defaultBaudRate!
    const { request, completion, successResponse, writeLineEnding, parserDelimiter, timeoutMs, retries } = this.options.identify

    let attempt = 0
    while (attempt < (retries ?? 1)) {
      attempt++

      try {
        const { port, parser } = await this.openPort(path, baudRate, parserDelimiter ?? '\r\n')

        const line = await this.requestIdentify(
          port,
          parser,
          `${request}${writeLineEnding ?? '\n'}`,
          timeoutMs ?? 5000,
          { id, kind: matcher.kind, path }
        )

        const expected = successResponse ?? matcher.identificationString
        if (line.trim() !== expected) {
          throw new Error(`Unexpected identify response: '${line.trim()}', expected '${expected}'`)
        }

        if (completion) {
          await this.writeLine(port, `${completion}${writeLineEnding ?? '\n'}`)
        }

        this.claimedPaths.add(path)
        this.openPorts.set(path, port)
        this.parsers.set(path, parser)

        // Success signal; plugin will log the compact one-liner
        this.emit('device:identified', { id, path, vid, pid, kind: matcher.kind, baudRate })
        this.emitLog('debug', `ready path=${path} kind=${matcher.kind} baud=${baudRate}`)
        return
      } catch (err: any) {
        await sleep(300)
        await this.safeClose(path)
        if (attempt >= (retries ?? 1)) throw err
      }
    }
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
    timeoutMs: number,
    _meta: { id: string; path: string; kind: string }
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

  private async safeClose(path: string): Promise<void> {
    const port = this.openPorts.get(path)
    if (!port) return
    await new Promise<void>((resolve) => port.close(() => resolve()))
    this.openPorts.delete(path)
    this.parsers.delete(path)
  }

  private emitLog(level: 'debug' | 'info' | 'warn' | 'error', msg: string, _meta?: Record<string, unknown>) {
    const prefix = this.options?.logPrefix ? `[${this.options.logPrefix}] ` : ''
    // Emit *single-line* messages; meta omitted to avoid pretty multi-line dumps
    this.emit('log', { level, msg: `${prefix}${msg}` })
  }
}

// ---------- utils ----------
function normalizeHex(v?: string): string | undefined {
  if (!v) return undefined
  return v.toString().replace(/^0x/i, '').toLowerCase()
}
function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)) }