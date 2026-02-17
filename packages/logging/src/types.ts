// packages/logging/src/types.ts

export enum LogChannel {
    orchestrator = 'orchestrator',
    sidecar = 'sidecar',
    ffmpeg = 'ffmpeg',
    stream = 'stream',
    ocr = 'ocr',
    device = 'device',
    keyboard = 'keyboard',
    mouse = 'mouse',
    benchmark = 'benchmark',
    websocket = 'websocket',
    app = 'app',
    request = 'request',
    powermeter = 'powermeter',
    serial_printer = 'serial-printer',
    atlona_controller = 'atlona-controller',
    cf_imager = 'cf-imager',
    frontpanel = 'frontpanel',

    // ✅ Google Sheets integration (result sink)
    google_sheets = 'google-sheets',
}

export type ChannelColor =
    | 'blue'
    | 'yellow'
    | 'green'
    | 'magenta'
    | 'cyan'
    | 'red'
    | 'white'
    | 'purple'
    | 'orange'

export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface ClientLog {
    ts: number
    channel: LogChannel
    emoji: string
    color: ChannelColor
    level: ClientLogLevel
    message: string
}

export type ClientLogListener = (log: ClientLog) => void

export interface ClientLogBuffer {
    push: (log: ClientLog) => void
    getLatest: (n: number) => ClientLog[]
    subscribe: (listener: ClientLogListener) => () => void
}

export interface ChannelLogger {
    debug: (msg: string, extra?: Record<string, unknown>) => void
    info:  (msg: string, extra?: Record<string, unknown>) => void
    warn:  (msg: string, extra?: Record<string, unknown>) => void
    error: (msg: string, extra?: Record<string, unknown>) => void
    fatal: (msg: string, extra?: Record<string, unknown>) => void
}

export interface LoggerBundle {
    base: import('pino').Logger
    channel: (ch: LogChannel) => ChannelLogger
}
