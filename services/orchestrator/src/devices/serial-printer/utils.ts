// services/orchestrator/src/core/devices/serial-printer/utils.ts

import type {
    SerialPrinterConfig,
    SerialPrinterReconnectPolicy,
    SerialPrinterFlowControl,
} from './types.js'

export const DEFAULT_PREVIEW_CHARS = 160

export function safeTruncate(input: string, maxChars: number): string {
    if (input.length <= maxChars) return input
    return `${input.slice(0, maxChars)}…`
}

export function normalizeLineEnding(raw: string, target: '\n' | '\r\n'): string {
    // Normalize CRLF and CR to LF, then convert to target
    const lf = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (target === '\n') return lf
    return lf.replace(/\n/g, '\r\n')
}

export function buildPreview(raw: string, maxChars: number): string {
    // Basic heuristic: normalize to LF for counting, then truncate
    const normalized = normalizeLineEnding(raw, '\n')
    return safeTruncate(normalized, maxChars)
}

/* -------------------------------------------------------------------------- */
/*  Env → config helpers                                                      */
/* -------------------------------------------------------------------------- */

function readIntEnv(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
}

function readBoolEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name]
    if (!raw) return fallback
    const v = raw.trim().toLowerCase()
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
    return fallback
}

function readStringEnv(name: string): string | undefined {
    const raw = process.env[name]
    if (raw === undefined || raw === '') return undefined
    return raw
}

function resolveLineEndingEnv(): '\n' | '\r\n' {
    const raw = readStringEnv('SERIAL_PRINTER_LINE_ENDING')
    if (!raw) return '\r\n'
    const v = raw.trim().toUpperCase()
    if (v === 'LF') return '\n'
    // default / CRLF
    return '\r\n'
}

function resolveFlowControlEnv(): SerialPrinterFlowControl {
    const raw = readStringEnv('SERIAL_PRINTER_FLOW_CONTROL')
    if (!raw) return 'software'
    const v = raw.trim().toLowerCase()
    if (v === 'none') return 'none'
    if (v === 'hardware') return 'hardware'
    // default / unknown => software (XON/XOFF)
    return 'software'
}

function buildReconnectPolicyFromEnv(): SerialPrinterReconnectPolicy {
    const enabled = readBoolEnv('SERIAL_PRINTER_RECONNECT_ENABLED', true)
    const maxAttempts = readIntEnv('SERIAL_PRINTER_RECONNECT_MAX_ATTEMPTS', 5)
    const baseDelayMs = readIntEnv('SERIAL_PRINTER_RECONNECT_BASE_DELAY_MS', 1000)
    const maxDelayMs = readIntEnv('SERIAL_PRINTER_RECONNECT_MAX_DELAY_MS', 10000)

    return {
        enabled,
        maxAttempts: maxAttempts < 0 ? 0 : maxAttempts,
        baseDelayMs: baseDelayMs > 0 ? baseDelayMs : 1000,
        maxDelayMs: maxDelayMs >= baseDelayMs ? maxDelayMs : baseDelayMs,
    }
}

/**
 * Build a SerialPrinterConfig from environment variables, with a fallback
 * portPath supplied by the caller (e.g., from serial discovery).
 *
 * Precedence:
 *   - SERIAL_PRINTER_PORT (if non-empty)
 *   - portPathFromDiscovery (argument)
 */
export function buildSerialPrinterConfigFromEnv(
    portPathFromDiscovery: string
): SerialPrinterConfig {
    const portOverride = readStringEnv('SERIAL_PRINTER_PORT')
    const portPath = (portOverride && portOverride.trim().length > 0)
        ? portOverride.trim()
        : portPathFromDiscovery

    const baudRate = readIntEnv('SERIAL_PRINTER_BAUD', 9600)
    const idleFlushMs = readIntEnv('SERIAL_PRINTER_IDLE_FLUSH_MS', 500)
    const maxQueuedJobs = readIntEnv('SERIAL_PRINTER_MAX_QUEUED_JOBS', 32)
    const lineEnding = resolveLineEndingEnv()
    const reconnect = buildReconnectPolicyFromEnv()
    const flowControl = resolveFlowControlEnv()

    return {
        portPath,
        baudRate: baudRate > 0 ? baudRate : 9600,
        lineEnding,
        idleFlushMs: idleFlushMs > 0 ? idleFlushMs : 500,
        maxQueuedJobs: maxQueuedJobs > 0 ? maxQueuedJobs : 32,
        reconnect,
        flowControl,
    }
}