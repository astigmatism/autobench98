// services/orchestrator/src/core/devices/atlona-controller/utils.ts

import type { AtlonaControllerConfig, AtlonaSwitchId, AtlonaSwitchName } from './types.js'

export function buildAtlonaControllerConfigFromEnv(env: NodeJS.ProcessEnv): AtlonaControllerConfig {
    const reconnectEnabled = parseBoolSafe(env.ATLONA_RECONNECT_ENABLED, true)
    const reconnectMaxAttempts = parseIntSafe(env.ATLONA_RECONNECT_MAX_ATTEMPTS, 0)
    const reconnectBaseDelayMs = parseIntSafe(env.ATLONA_RECONNECT_BASE_DELAY_MS, 1000)
    const reconnectMaxDelayMs = parseIntSafe(env.ATLONA_RECONNECT_MAX_DELAY_MS, 10_000)

    return {
        reconnect: {
            enabled: reconnectEnabled,
            maxAttempts: reconnectMaxAttempts,
            baseDelayMs: reconnectBaseDelayMs,
            maxDelayMs: reconnectMaxDelayMs,
        },
    }
}

function parseIntSafe(value: string | undefined, fallback: number): number {
    if (!value) return fallback
    const n = Number.parseInt(value, 10)
    return Number.isNaN(n) ? fallback : n
}

function parseBoolSafe(value: string | undefined, fallback: boolean): boolean {
    if (value == null || value === '') return fallback
    const v = value.toLowerCase()
    if (v === 'true' || v === '1' || v === 'yes') return true
    if (v === 'false' || v === '0' || v === 'no') return false
    return fallback
}

/**
 * Map numeric switch ID (1–3) to semantic name.
 */
export function mapSwitchIdToName(id: AtlonaSwitchId): AtlonaSwitchName {
    switch (id) {
        case 1: return 'menu'
        case 2: return 'minus'
        case 3: return 'plus'
    }
}

/**
 * Small clamp helper for reconnection backoff.
 */
export function computeReconnectDelay(
    baseDelayMs: number,
    maxDelayMs: number,
    attempt: number
): number {
    if (baseDelayMs <= 0) baseDelayMs = 1000
    if (maxDelayMs < baseDelayMs) maxDelayMs = baseDelayMs

    const exp = Math.pow(2, Math.max(0, attempt - 1))
    let candidate = baseDelayMs * exp

    if (candidate > maxDelayMs) candidate = maxDelayMs
    if (candidate < baseDelayMs) candidate = baseDelayMs

    return candidate
}