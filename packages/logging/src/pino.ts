import pino, { type Logger, type LoggerOptions, type LogFn } from 'pino'
import pinoPretty from 'pino-pretty'
import {
    type ClientLogLevel,
    type LoggerBundle,
    type ChannelLogger,
    type ClientLogBuffer,
    LogChannel
} from './types.js'
import { CHANNELS, ANSI, RESET, CUSTOM_LEVELS, CHANNEL_AS_LEVEL } from './channels.js'

// Extend pino's options to include levelKey (present at runtime, missing in your typings)
type PinoOptionsExt = LoggerOptions & { levelKey?: string }

export function createLogger(service: string, clientBuf?: ClientLogBuffer): LoggerBundle {
    const PRETTY = String(process.env.PRETTY_LOGS ?? 'true').toLowerCase() === 'true'
    const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info'

    let base: Logger

    const options: PinoOptionsExt = {
        levelKey: 'lvl',                          // hide default 'level' from pino-pretty
        level: LOG_LEVEL,
        base: { service },
        customLevels: CUSTOM_LEVELS,
        useOnlyCustomLevels: false,
        formatters: {
            level() { return { lvl: '' } },      // suppress textual level in JSON
            log(obj) { return obj }
        },
        hooks: {
            logMethod(args: unknown[], method: LogFn): void {
                let ch: LogChannel | undefined

                if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
                    const maybe = args[0] as Record<string, unknown>
                    if (typeof maybe.channel === 'string') ch = maybe.channel as LogChannel
                }

                if (ch && CHANNELS[ch]) {
                    const meta = CHANNELS[ch]
                    const prefix = `${ANSI[meta.color]}${meta.emoji} [${ch}]:${RESET}`

                    if (args.length >= 2 && typeof args[1] === 'string') {
                        args[1] = `${prefix} ${String(args[1])}`
                    } else if (args.length >= 1 && typeof args[0] === 'string') {
                        args[0] = `${prefix} ${String(args[0])}`
                    } else {
                        args.push(prefix)
                    }
                }

                Reflect.apply(method, base as object, args as Parameters<LogFn>)
            }
        }
    }

    const destination = PRETTY
        ? pinoPretty({
            translateTime: 'SYS:standard', // [YYYY-MM-DD HH:mm:ss.SSS +0000]
            colorize: true,
            singleLine: false,             // ← allow multi-line objects
            // keep these ignored fields out of output
            ignore: 'pid,hostname,service,channel,lvl'
            // NOTE: no messageFormat — we want pretty to print msg + object props
        })
        : undefined

    base = destination ? pino(options, destination) : pino(options)

    const fanout = (channel: LogChannel, level: ClientLogLevel, message: string): void => {
        if (!clientBuf) return
        const meta = CHANNELS[channel]
        clientBuf.push({
            ts: Date.now(),
            channel,
            emoji: meta.emoji,
            color: meta.color,
            level,
            message
        })
    }

    type CustomLevelLogger = Logger & Record<LogChannel, (obj: object, msg?: string) => void>
    const callCustomLevel = (ch: LogChannel, message: string, extra?: Record<string, unknown>): void => {
        const l = base as CustomLevelLogger
        const write = typeof l[ch] === 'function' ? l[ch] : base.info.bind(base)
        if (extra) write({ channel: ch, ...extra }, message)
        else write({ channel: ch }, message)
    }

    const channel = (ch: LogChannel): ChannelLogger => ({
        debug: (msg: string, extra?: Record<string, unknown>): void => {
            base.debug(extra ? { channel: ch, ...extra } : { channel: ch }, msg)
            fanout(ch, 'debug', msg)
        },
        info: (msg: string, extra?: Record<string, unknown>): void => {
            if (CHANNEL_AS_LEVEL) {
                callCustomLevel(ch, msg, extra)
            } else {
                base.info(extra ? { channel: ch, ...extra } : { channel: ch }, msg)
            }
            fanout(ch, 'info', msg)
        },
        warn: (msg: string, extra?: Record<string, unknown>): void => {
            base.warn(extra ? { channel: ch, ...extra } : { channel: ch }, msg)
            fanout(ch, 'warn', msg)
        },
        error: (msg: string, extra?: Record<string, unknown>): void => {
            base.error(extra ? { channel: ch, ...extra } : { channel: ch }, msg)
            fanout(ch, 'error', msg)
        },
        fatal: (msg: string, extra?: Record<string, unknown>): void => {
            base.fatal(extra ? { channel: ch, ...extra } : { channel: ch }, msg)
            fanout(ch, 'fatal', msg)
        }
    })

    return { base, channel }
}

// With Fastify logger disabled, we don't expose pino options for it
export function makeFastifyLoggerOptions(_service: string): LoggerOptions {
    return { enabled: false } as unknown as LoggerOptions
}