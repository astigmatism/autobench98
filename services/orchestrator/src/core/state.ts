// services/orchestrator/src/core/state.ts
import { EventEmitter } from 'node:events'
import * as jsonpatch from 'fast-json-patch' // CJS/ESM-safe import
import type {
    CfImagerState as CfImagerSnapshot,
    CfImagerMediaStatus,
} from '../devices/cf-imager/types.js'
import type { KeyboardStateSlice as PS2KeyboardSnapshot } from '../devices/ps2-keyboard/types.js'

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

    // Current in-progress job (if any)
    currentJob: {
        id: number
        startedAt: number
    } | null

    // Last completed job, summary only
    lastJob: {
        id: number
        createdAt: number
        completedAt: number
        preview: string
    } | null

    // Canonical, full text of the last completed job (backend raw)
    lastJobFullText: string | null

    // Rolling history of recent jobs (full text, server-side bounded)
    history: {
        id: number
        createdAt: number
        completedAt: number
        text: string
    }[]

    // Maximum number of history entries the server keeps
    historyLimit: number

    // Rolling history of recent jobs (summary only, unchanged)
    recentJobs: {
        id: number
        createdAt: number
        completedAt: number
        preview: string
    }[]

    // UI hint for how many to keep in recentJobs
    maxRecentJobs: number
}

/* -------------------------------------------------------------------------- */
/*  Atlona controller snapshot                                                */
/* -------------------------------------------------------------------------- */

export type AtlonaControllerSnapshot = {
    phase: 'disconnected' | 'connecting' | 'ready' | 'error'
    message?: string
    identified: boolean
    switches: {
        1: { name: 'menu'; isHeld: boolean }
        2: { name: 'minus'; isHeld: boolean }
        3: { name: 'plus'; isHeld: boolean }
    }
}

/* -------------------------------------------------------------------------- */
/*  PS2 Keyboard snapshot (alias of KeyboardStateSlice)                       */
/* -------------------------------------------------------------------------- */

// PS2KeyboardSnapshot is imported from ../devices/ps2-keyboard/types.js as KeyboardStateSlice.

/* -------------------------------------------------------------------------- */
/*  CF Imager snapshot (alias of CfImagerState)                               */
/* -------------------------------------------------------------------------- */

export type CfImagerMediaSnapshot = CfImagerMediaStatus

// CfImagerSnapshot is imported as CfImagerState above and aliased.
// (already named CfImagerSnapshot in the import)

/* -------------------------------------------------------------------------- */
/*  Sidecar snapshot                                                          */
/* -------------------------------------------------------------------------- */

export type SidecarSnapshot = {
    // Raw env values (for debug/inspection in the UI if needed).
    host: string
    port: number

    // Canonical base URL as seen from the orchestrator host.
    // NOTE: This may or may not be directly usable from the browser depending
    // on how Studio is hosted; the frontend can still choose to ignore it.
    baseUrl: string

    // Path for the MJPEG stream on the sidecar.
    streamPath: string

    // Convenience, fully combined URL (baseUrl + streamPath).
    // Frontend panes can use this directly if it matches their hosting model,
    // or override/ignore it if the orchestrator proxies /stream differently.
    streamUrl: string

    // Lightweight health/status; initially unknown.
    status: 'unknown' | 'up' | 'down'
    lastCheckedAt: number | null
    lastError?: string
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
    atlonaController: AtlonaControllerSnapshot
    ps2Keyboard: PS2KeyboardSnapshot
    cfImager: CfImagerSnapshot
    sidecar: SidecarSnapshot
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
    return v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
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

// How many full-text jobs to keep in memory/server snapshots
const SERIAL_PRINTER_HISTORY_LIMIT = num(process.env.SERIAL_PRINTER_HISTORY_LIMIT, 10)

// Sidecar env-derived defaults
const SIDECAR_HOST = (process.env.SIDECAR_HOST || '127.0.0.1').trim()
const SIDECAR_PORT = num(process.env.SIDECAR_PORT, 3100)
// For now the sidecar only promises /stream; screenshot/recordings are separate.
const SIDECAR_STREAM_PATH = '/stream'
const SIDECAR_BASE_URL = `http://${SIDECAR_HOST}:${SIDECAR_PORT}`
const SIDECAR_STREAM_URL = `${SIDECAR_BASE_URL}${SIDECAR_STREAM_PATH}`

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
/*  Initial serial printer slice                                              */
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
    lastJobFullText: null,
    history: [],
    historyLimit: SERIAL_PRINTER_HISTORY_LIMIT,
    recentJobs: [],
    maxRecentJobs: 20,
}

/* -------------------------------------------------------------------------- */
/*  Initial Atlona controller slice                                           */
/* -------------------------------------------------------------------------- */

const initialAtlonaController: AtlonaControllerSnapshot = {
    phase: 'disconnected',
    message: undefined,
    identified: false,
    switches: {
        1: { name: 'menu', isHeld: false },
        2: { name: 'minus', isHeld: false },
        3: { name: 'plus', isHeld: false },
    },
}

/* -------------------------------------------------------------------------- */
/*  Initial PS2 keyboard slice                                                */
/* -------------------------------------------------------------------------- */

const initialPs2Keyboard: PS2KeyboardSnapshot = {
    phase: 'disconnected',
    power: 'unknown',
    identified: false,

    deviceId: null,
    devicePath: null,
    baudRate: null,

    busy: false,
    queueDepth: 0,
    currentOp: null,

    lastError: null,
    errorHistory: [],
    operationHistory: [],

    updatedAt: Date.now(),
}

/* -------------------------------------------------------------------------- */
/*  Initial CF Imager slice                                                   */
/* -------------------------------------------------------------------------- */

const initialCfImager: CfImagerSnapshot = {
    phase: 'disconnected',
    media: 'none',
    message: undefined,
    device: undefined,
    fs: {
        rootPath: '/',
        cwd: '/',
        entries: [],
    },
    currentOp: undefined,
    lastError: undefined,
    // NEW: initial free-space hint is unknown
    diskFreeBytes: undefined,
}

/* -------------------------------------------------------------------------- */
/*  Initial Sidecar slice                                                     */
/* -------------------------------------------------------------------------- */

const initialSidecar: SidecarSnapshot = {
    host: SIDECAR_HOST,
    port: SIDECAR_PORT,
    baseUrl: SIDECAR_BASE_URL,
    streamPath: SIDECAR_STREAM_PATH,
    streamUrl: SIDECAR_STREAM_URL,
    status: 'unknown',
    lastCheckedAt: null,
    lastError: undefined,
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
    atlonaController: initialAtlonaController,
    ps2Keyboard: initialPs2Keyboard,
    cfImager: initialCfImager,
    sidecar: initialSidecar,
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
/*  Serial printer update helpers                                             */
/* -------------------------------------------------------------------------- */

export function setSerialPrinterSnapshot(next: SerialPrinterSnapshot) {
    set('serialPrinter', next)
}

export function updateSerialPrinterSnapshot(partial: {
    phase?: SerialPrinterSnapshot['phase']
    message?: string
    currentJob?: SerialPrinterSnapshot['currentJob']
    lastJob?: SerialPrinterSnapshot['lastJob']
    lastJobFullText?: string | null
    stats?: Partial<SerialPrinterSnapshot['stats']>
    history?: SerialPrinterSnapshot['history']
    historyLimit?: number
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
            partial.currentJob !== undefined
                ? partial.currentJob
                : prev.currentJob,
        lastJob: partial.lastJob ?? prev.lastJob,
        lastJobFullText:
            partial.lastJobFullText !== undefined
                ? partial.lastJobFullText
                : prev.lastJobFullText,
        stats: mergedStats,
        history: partial.history ?? prev.history,
        historyLimit: partial.historyLimit ?? prev.historyLimit,
        recentJobs: partial.recentJobs ?? prev.recentJobs,
        maxRecentJobs: partial.maxRecentJobs ?? prev.maxRecentJobs,
    }

    set('serialPrinter', merged)
}

/* -------------------------------------------------------------------------- */
/*  Atlona controller update helpers                                          */
/* -------------------------------------------------------------------------- */

export function setAtlonaControllerSnapshot(next: AtlonaControllerSnapshot) {
    set('atlonaController', next)
}

export function updateAtlonaControllerSnapshot(partial: {
    phase?: AtlonaControllerSnapshot['phase']
    message?: string
    identified?: boolean
    switches?: {
        1?: { isHeld: boolean }
        2?: { isHeld: boolean }
        3?: { isHeld: boolean }
    }
}) {
    const prev = state.atlonaController

    const switches = {
        ...prev.switches,
    }

    if (partial.switches?.[1]) {
        switches[1] = { ...switches[1], ...partial.switches[1] }
    }
    if (partial.switches?.[2]) {
        switches[2] = { ...switches[2], ...partial.switches[2] }
    }
    if (partial.switches?.[3]) {
        switches[3] = { ...switches[3], ...partial.switches[3] }
    }

    const merged: AtlonaControllerSnapshot = {
        phase: partial.phase ?? prev.phase,
        message: partial.message ?? prev.message,
        identified: partial.identified ?? prev.identified,
        switches,
    }

    set('atlonaController', merged)
}

/* -------------------------------------------------------------------------- */
/*  PS2 keyboard update helpers                                               */
/* -------------------------------------------------------------------------- */

export function setPS2KeyboardSnapshot(next: PS2KeyboardSnapshot) {
    set('ps2Keyboard', next)
}

export function updatePS2KeyboardSnapshot(partial: Partial<PS2KeyboardSnapshot>) {
    const prev = state.ps2Keyboard

    // Shallow merge is sufficient because nested arrays/objects are replaced
    // as whole snapshots by the adapter.
    const merged: PS2KeyboardSnapshot = {
        ...prev,
        ...clone(partial),
        // Ensure updatedAt always moves forward if caller didn’t specify it.
        updatedAt:
            (partial as any).updatedAt !== undefined
                ? (partial as any).updatedAt
                : Date.now(),
    }

    set('ps2Keyboard', merged)
}

/* -------------------------------------------------------------------------- */
/*  CF Imager update helpers                                                  */
/* -------------------------------------------------------------------------- */

export function setCfImagerSnapshot(next: CfImagerSnapshot) {
    set('cfImager', next)
}

export function updateCfImagerSnapshot(partial: {
    phase?: CfImagerSnapshot['phase']
    media?: CfImagerSnapshot['media']
    message?: string
    device?: CfImagerSnapshot['device']
    fs?: Partial<CfImagerSnapshot['fs']>
    currentOp?: CfImagerSnapshot['currentOp']
    lastError?: string
    diskFreeBytes?: CfImagerSnapshot['diskFreeBytes']
}) {
    const prev = state.cfImager

    const fs: CfImagerSnapshot['fs'] = {
        ...prev.fs,
        ...(partial.fs ?? {}),
    }

    const merged: CfImagerSnapshot = {
        phase: partial.phase ?? prev.phase,
        media: partial.media ?? prev.media,
        message: partial.message ?? prev.message,
        device: partial.device ?? prev.device,
        fs,
        currentOp: partial.currentOp ?? prev.currentOp,
        lastError: partial.lastError ?? prev.lastError,
        diskFreeBytes:
            partial.diskFreeBytes !== undefined
                ? partial.diskFreeBytes
                : prev.diskFreeBytes,
    }

    set('cfImager', merged)
}

/* -------------------------------------------------------------------------- */
/*  Sidecar update helpers                                                    */
/* -------------------------------------------------------------------------- */

export function setSidecarSnapshot(next: SidecarSnapshot) {
    set('sidecar', next)
}

export function updateSidecarSnapshot(partial: Partial<SidecarSnapshot>) {
    const prev = state.sidecar
    const merged: SidecarSnapshot = {
        ...prev,
        ...partial,
    }
    set('sidecar', merged)
}
