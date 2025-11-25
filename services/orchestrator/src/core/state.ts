// services/orchestrator/src/core/state.ts
import { EventEmitter } from 'node:events'
import * as jsonpatch from 'fast-json-patch' // CJS/ESM-safe import

/**
 * Client-consumable server configuration shipped inside the state snapshot.
 * Frontend should adopt these, avoiding client-side .env for these knobs.
 */
export type ServerConfig = {
    logs: {
        snapshot: number
        capacity: number
        allowedChannels: string[]
        minLevel: 'debug' | 'info' | 'warn' | 'error' | 'fatal'
    }
    ws: {
        heartbeatIntervalMs: number
        heartbeatTimeoutMs: number
        reconnectEnabled: boolean
        reconnectMinMs: number
        reconnectMaxMs: number
        reconnectFactor: number
        reconnectJitter: number
    }
}

/* -------------------------------------------------------------------------- */
/*  Power meter snapshot (unchanged except formatting)                        */
/* -------------------------------------------------------------------------- */

export type PowerMeterSnapshot = {
    phase: 'disconnected' | 'connecting' | 'streaming' | 'error'
    message?: string
    stats: {
        totalSamples: number
        bytesReceived: number
        lastSampleAt: number | null
        lastErrorAt: number | null
    }
    lastSample: {
        ts: string
        watts: number
        volts: number
        amps: number
    } | null
}

/* -------------------------------------------------------------------------- */
/*  Serial printer snapshot (UPDATED)                                         */
/* -------------------------------------------------------------------------- */

export type SerialPrinterSnapshot = {
    // High-level phase
    phase: 'disconnected' | 'connected' | 'queued' | 'error' | 'receiving'

    // Optional human-readable message
    message?: string

    // Lightweight stats
    stats: {
        totalJobs: number
        bytesReceived: number
        lastJobAt: number | null
        lastErrorAt: number | null
    }

    // Live in-progress job (streamed text as it arrives)
    currentJob: {
        id: number
        startedAt: number
        text: string
    } | null

    // Last completed job, summary only
    lastJob: {
        id: number
        createdAt: number
        completedAt: number
        preview: string
    } | null

    // Rolling history of recent jobs
    recentJobs: {
        id: number
        createdAt: number
        completedAt: number
        preview: string
    }[]

    // UI hint for how many to keep
    maxRecentJobs: number
}

/* -------------------------------------------------------------------------- */
/*  Full AppState                                                             */
/* -------------------------------------------------------------------------- */

export type AppState = {
    version: number
    meta: { startedAt: string; status: 'booting' | 'ready' | 'error' }
    layout: { rows: number; cols: number }
    message: string
    serverConfig: ServerConfig
    powerMeter: PowerMeterSnapshot
    serialPrinter: SerialPrinterSnapshot
}

/* -------------------------------------------------------------------------- */
/*  Patch event and state internals                                           */
/* -------------------------------------------------------------------------- */

export type PatchEvent = {
    from: number
    to: number
    patch: jsonpatch.Operation[]
}

/* ENV helpers */
function num(v: unknown, def: number): number {
    const n = Number(v)
    return Number.isFinite(n) ? n : def
}
function bool(v: unknown, def: boolean): boolean {
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase()
        if (s === 'true') return true
        if (s === 'false') return false
    }
    if (typeof v === 'boolean') return v
    return def
}
function csv(v: unknown): string[] {
    if (typeof v !== 'string') return []
    return v.split(',').map(s => s.trim()).filter(Boolean)
}

/* -------------------------------------------------------------------------- */
/*  Initial configuration                                                     */
/* -------------------------------------------------------------------------- */

const LOGS_SNAPSHOT = num(process.env.CLIENT_LOGS_SNAPSHOT, 200)
const LOGS_CAPACITY = num(process.env.CLIENT_LOGS_CAPACITY, 500)
const LOG_ALLOWED = csv(process.env.LOG_CHANNEL_ALLOWLIST)
const LOG_MIN = (process.env.LOG_LEVEL_MIN ?? 'debug').toLowerCase() as ServerConfig['logs']['minLevel']

const WS_HEARTBEAT_INTERVAL_MS = num(process.env.VITE_WS_HEARTBEAT_INTERVAL_MS, 10_000)
const WS_HEARTBEAT_TIMEOUT_MS = num(process.env.VITE_WS_HEARTBEAT_TIMEOUT_MS, 5_000)
const WS_RECONNECT_ENABLED = bool(process.env.VITE_WS_RECONNECT_ENABLED, true)
const WS_RECONNECT_MIN_MS = num(process.env.VITE_WS_RECONNECT_MIN_MS, 1_000)
const WS_RECONNECT_MAX_MS = num(process.env.VITE_WS_RECONNECT_MAX_MS, 15_000)
const WS_RECONNECT_FACTOR = num(process.env.VITE_WS_RECONNECT_FACTOR, 1.8)
const WS_RECONNECT_JITTER = num(process.env.VITE_WS_RECONNECT_JITTER, 0.2)

const startedAt = new Date().toISOString()

/* -------------------------------------------------------------------------- */
/*  Initial power meter slice                                                 */
/* -------------------------------------------------------------------------- */

const initialPowerMeter: PowerMeterSnapshot = {
    phase: 'disconnected',
    message: undefined,
    stats: {
        totalSamples: 0,
        bytesReceived: 0,
        lastSampleAt: null,
        lastErrorAt: null,
    },
    lastSample: null,
}

/* -------------------------------------------------------------------------- */
/*  Initial serial printer slice (UPDATED with currentJob)                    */
/* -------------------------------------------------------------------------- */

const initialSerialPrinter: SerialPrinterSnapshot = {
    phase: 'disconnected',
    message: undefined,
    stats: {
        totalJobs: 0,
        bytesReceived: 0,
        lastJobAt: null,
        lastErrorAt: null,
    },
    currentJob: null,
    lastJob: null,
    recentJobs: [],
    maxRecentJobs: 20,
}

/* -------------------------------------------------------------------------- */
/*  Initial full state                                                        */
/* -------------------------------------------------------------------------- */

let state: AppState = {
    version: 1,
    meta: { startedAt, status: 'ready' },
    layout: { rows: 1, cols: 1 },
    message: 'Hello from orchestrator',
    serverConfig: {
        logs: {
            snapshot: LOGS_SNAPSHOT,
            capacity: LOGS_CAPACITY,
            allowedChannels: LOG_ALLOWED,
            minLevel: LOG_MIN,
        },
        ws: {
            heartbeatIntervalMs: WS_HEARTBEAT_INTERVAL_MS,
            heartbeatTimeoutMs: WS_HEARTBEAT_TIMEOUT_MS,
            reconnectEnabled: WS_RECONNECT_ENABLED,
            reconnectMinMs: WS_RECONNECT_MIN_MS,
            reconnectMaxMs: WS_RECONNECT_MAX_MS,
            reconnectFactor: WS_RECONNECT_FACTOR,
            reconnectJitter: WS_RECONNECT_JITTER,
        },
    },
    powerMeter: initialPowerMeter,
    serialPrinter: initialSerialPrinter,
}

/* -------------------------------------------------------------------------- */
/*  Internal event emission helpers                                           */
/* -------------------------------------------------------------------------- */

export const stateEvents = new EventEmitter()

function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T
}

function emitChanges(prev: AppState, next: AppState) {
    const ops = jsonpatch.compare(prev, next)
    if (ops.length > 0) {
        stateEvents.emit('patch', {
            from: prev.version,
            to: next.version,
            patch: ops,
        } satisfies PatchEvent)
    }
    stateEvents.emit('snapshot', clone(next))
}

/* -------------------------------------------------------------------------- */
/*  Public state update wrappers                                              */
/* -------------------------------------------------------------------------- */

export function getSnapshot(): AppState {
    return clone(state)
}

export function replaceState(next: Omit<AppState, 'version'> & { version?: number }) {
    const prev = clone(state)
    const version = (typeof next.version === 'number' ? next.version : state.version) + 1
    const updated: AppState = { ...next, version }
    state = updated
    emitChanges(prev, updated)
}

export function set<K extends keyof AppState>(key: K, value: AppState[K]) {
    const prev = clone(state)
    const nextShallow = {
        ...state,
        [key]: clone(value),
        version: state.version + 1,
    } as AppState
    state = nextShallow
    emitChanges(prev, nextShallow)
}

export function setMessage(text: string) {
    set('message', text)
}

export function setLayout(rows: number, cols: number) {
    set('layout', { rows, cols })
}

export function setServerConfig(partial: Partial<ServerConfig>) {
    set('serverConfig', { ...state.serverConfig, ...clone(partial) })
}

/* -------------------------------------------------------------------------- */
/*  Power meter update helpers                                                */
/* -------------------------------------------------------------------------- */

export function setPowerMeterSnapshot(next: PowerMeterSnapshot) {
    set('powerMeter', next)
}

export function updatePowerMeterSnapshot(partial: {
    phase?: PowerMeterSnapshot['phase']
    message?: string
    lastSample?: PowerMeterSnapshot['lastSample']
    stats?: Partial<PowerMeterSnapshot['stats']>
}) {
    const prev = state.powerMeter
    const mergedStats: PowerMeterSnapshot['stats'] = {
        ...prev.stats,
        ...(partial.stats ?? {}),
    }

    const merged: PowerMeterSnapshot = {
        phase: partial.phase ?? prev.phase,
        message: partial.message ?? prev.message,
        lastSample: partial.lastSample ?? prev.lastSample,
        stats: mergedStats,
    }

    set('powerMeter', merged)
}

/* -------------------------------------------------------------------------- */
/*  Serial printer update helpers (UPDATED)                                   */
/* -------------------------------------------------------------------------- */

export function setSerialPrinterSnapshot(next: SerialPrinterSnapshot) {
    set('serialPrinter', next)
}

export function updateSerialPrinterSnapshot(partial: {
    phase?: SerialPrinterSnapshot['phase']
    message?: string
    currentJob?: SerialPrinterSnapshot['currentJob'] | null
    lastJob?: SerialPrinterSnapshot['lastJob']
    stats?: Partial<SerialPrinterSnapshot['stats']>
    recentJobs?: SerialPrinterSnapshot['recentJobs']
    maxRecentJobs?: number
}) {
    const prev = state.serialPrinter

    const mergedStats: SerialPrinterSnapshot['stats'] = {
        ...prev.stats,
        ...(partial.stats ?? {}),
    }

    const merged: SerialPrinterSnapshot = {
        phase: partial.phase ?? prev.phase,
        message: partial.message ?? prev.message,
        currentJob:
            partial.currentJob !== undefined ? partial.currentJob : prev.currentJob,
        lastJob: partial.lastJob ?? prev.lastJob,
        stats: mergedStats,
        recentJobs: partial.recentJobs ?? prev.recentJobs,
        maxRecentJobs: partial.maxRecentJobs ?? prev.maxRecentJobs,
    }

    set('serialPrinter', merged)
}