import { type ChannelColor, LogChannel } from './types.js'

export const CHANNEL_AS_LEVEL = true as const

export const CHANNELS: Record<LogChannel, { emoji: string, color: ChannelColor }> = {
    [LogChannel.orchestrator]:   { emoji: '🛰️', color: 'blue' },
    [LogChannel.sidecar]:        { emoji: '🧩', color: 'yellow' },
    [LogChannel.ffmpeg]:         { emoji: '🎬', color: 'magenta' },
    [LogChannel.stream]:         { emoji: '📺', color: 'cyan' },
    [LogChannel.ocr]:            { emoji: '🔎', color: 'green' },
    // More generic device marker
    [LogChannel.device]:         { emoji: '🛠️', color: 'red' },
    [LogChannel.benchmark]:      { emoji: '⏱️', color: 'green' },
    [LogChannel.websocket]:      { emoji: '🔗', color: 'cyan' },
    [LogChannel.app]:            { emoji: '📦', color: 'blue' },
    [LogChannel.request]:        { emoji: '📝', color: 'purple' },
    // Power meter-specific channel
    [LogChannel.powermeter]:     { emoji: '🔌', color: 'yellow' },
    // Serial printer-specific channel
    [LogChannel.serial_printer]: { emoji: '🖨️', color: 'white' },
}

export const ANSI: Record<ChannelColor, string> = {
    blue: '\x1b[34m',
    yellow: '\x1b[33m',
    green: '\x1b[32m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    red: '\x1b[31m',
    white: '\x1b[37m',
    purple: '\x1b[95m' // bright magenta (purple-ish)
}

export const RESET = '\x1b[0m'

export const CUSTOM_LEVELS: Record<LogChannel, number> = {
    [LogChannel.orchestrator]:   30,
    [LogChannel.sidecar]:        30,
    [LogChannel.ffmpeg]:         30,
    [LogChannel.stream]:         30,
    [LogChannel.ocr]:            30,
    [LogChannel.device]:         30,
    [LogChannel.benchmark]:      30,
    [LogChannel.websocket]:      30,
    [LogChannel.app]:            30,
    [LogChannel.request]:        30,
    [LogChannel.powermeter]:     30,
    [LogChannel.serial_printer]: 30,
}