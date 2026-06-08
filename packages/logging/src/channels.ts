// packages/logging/src/channels.ts
import { type ChannelColor, LogChannel } from './types.js'

export const CHANNEL_AS_LEVEL = true as const

export const CHANNELS: Record<LogChannel, { emoji: string, color: ChannelColor }> = {
    [LogChannel.orchestrator]:    { emoji: '🛰️', color: 'blue' },
    [LogChannel.sidecar]:         { emoji: '🧩', color: 'yellow' },
    [LogChannel.ffmpeg]:          { emoji: '🎬', color: 'magenta' },
    [LogChannel.stream]:          { emoji: '📺', color: 'cyan' },
    [LogChannel.ocr]:             { emoji: '🔎', color: 'green' },

    // More generic device marker
    [LogChannel.device]:          { emoji: '🛠️', color: 'red' },

    // Keyboard-specific channel
    [LogChannel.keyboard]:        { emoji: '⌨️', color: 'cyan' },

    // Mouse-specific channel
    [LogChannel.mouse]:           { emoji: '🖱️', color: 'white' },

    [LogChannel.benchmark]:       { emoji: '⏱️', color: 'green' },
    [LogChannel.websocket]:       { emoji: '🔗', color: 'cyan' },
    [LogChannel.app]:             { emoji: '📦', color: 'blue' },
    [LogChannel.request]:         { emoji: '📝', color: 'purple' },

    // Power meter-specific channel
    [LogChannel.powermeter]:      { emoji: '🔌', color: 'yellow' },

    // Serial printer-specific channel
    [LogChannel.serial_printer]:  { emoji: '🖨️', color: 'white' },

    // Atlona controller-specific channel
    [LogChannel.atlona_controller]: { emoji: '📽️', color: 'purple' },

    [LogChannel.cf_imager]:       { emoji: '💾', color: 'cyan' },
    [LogChannel.frontpanel]:      { emoji: '⏻', color: 'red' },

    // ✅ Google Sheets integration (result sink) — stands out in orange
    [LogChannel.google_sheets]:   { emoji: '📊', color: 'orange' },

    // ✅ Tips & Information panel
    [LogChannel.tips]:            { emoji: '💡', color: 'yellow' },
}

export const ANSI: Record<ChannelColor, string> = {
    blue: '\x1b[34m',
    yellow: '\x1b[33m',
    green: '\x1b[32m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    red: '\x1b[31m',
    white: '\x1b[37m',
    purple: '\x1b[95m',        // bright magenta (purple-ish)

    // 256-color "orange" (works in most modern terminals; falls back gracefully in others)
    orange: '\x1b[38;5;208m',
}

export const RESET = '\x1b[0m'

export const CUSTOM_LEVELS: Record<LogChannel, number> = {
    [LogChannel.orchestrator]:    30,
    [LogChannel.sidecar]:         30,
    [LogChannel.ffmpeg]:          30,
    [LogChannel.stream]:          30,
    [LogChannel.ocr]:             30,
    [LogChannel.device]:          30,
    [LogChannel.keyboard]:        30,
    [LogChannel.mouse]:           30,
    [LogChannel.benchmark]:       30,
    [LogChannel.websocket]:       30,
    [LogChannel.app]:             30,
    [LogChannel.request]:         30,
    [LogChannel.powermeter]:      30,
    [LogChannel.serial_printer]:  30,
    [LogChannel.atlona_controller]: 30,
    [LogChannel.cf_imager]:       30,
    [LogChannel.frontpanel]:      30,

    // ✅ Google Sheets integration
    [LogChannel.google_sheets]:   30,

    // ✅ Tips & Information panel
    [LogChannel.tips]:            30,
}
