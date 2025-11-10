// apps/orchestrator/src/core/state.ts
import { EventEmitter } from 'node:events'
import * as jsonpatch from 'fast-json-patch' // CJS/ESM-safe import

/**
 * Client-consumable server configuration shipped inside the state snapshot.
 * Frontend should adopt these, avoiding client-side .env for these knobs.
 */
export type ServerConfig = {
    logs: {
        snapshot: number            // how many log entries server sends on connect
        capacity: number            // suggested client-side ring buffer size
        allowedChannels: string[]   // WS-visible channels (already filtered server-side)
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

/**
 * Server-authoritative application state (seed this with your real domains).
 * You can expand this shape freely; the snapshot broadcast will carry whatever is here.
 */
export type AppState = {
    version: number
    meta: { startedAt: string; status: 'booting' | 'ready' | 'error' }
    layout: { rows: number; cols: number }
    message: string
    serverConfig: ServerConfig
}

/** Payload for incremental patch broadcasts */
export type PatchEvent = {
    from: number
    to: number
    patch: jsonpatch.Operation[]
}

/* ---------------------------
   Env helpers (safe parsing)
--------------------------- */
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
        .map(s => s.trim())
        .filter(Boolean)
}

/* ---------------------------
   Initial config from env
--------------------------- */
// Logs
const LOGS_SNAPSHOT = num(process.env.CLIENT_LOGS_SNAPSHOT, 200)
// Suggest a client capacity (introduce SERVER-driven capacity; falls back to 500)
const LOGS_CAPACITY = num(process.env.CLIENT_LOGS_CAPACITY, 500)
// Visibility / level come from your existing WS log filter envs
const LOG_ALLOWED = csv(process.env.LOG_CHANNEL_ALLOWLIST)
const LOG_MIN = (process.env.LOG_LEVEL_MIN ?? 'debug').toLowerCase() as ServerConfig['logs']['minLevel']

// WS heartbeat + reconnect (we expose the same values to the client)
const WS_HEARTBEAT_INTERVAL_MS = num(process.env.VITE_WS_HEARTBEAT_INTERVAL_MS, 10_000)
const WS_HEARTBEAT_TIMEOUT_MS  = num(process.env.VITE_WS_HEARTBEAT_TIMEOUT_MS, 5_000)
const WS_RECONNECT_ENABLED     = bool(process.env.VITE_WS_RECONNECT_ENABLED, true)
const WS_RECONNECT_MIN_MS      = num(process.env.VITE_WS_RECONNECT_MIN_MS, 1_000)
const WS_RECONNECT_MAX_MS      = num(process.env.VITE_WS_RECONNECT_MAX_MS, 15_000)
const WS_RECONNECT_FACTOR      = num(process.env.VITE_WS_RECONNECT_FACTOR, 1.8)
const WS_RECONNECT_JITTER      = num(process.env.VITE_WS_RECONNECT_JITTER, 0.2)

const startedAt = new Date().toISOString()

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
            minLevel: LOG_MIN
        },
        ws: {
            heartbeatIntervalMs: WS_HEARTBEAT_INTERVAL_MS,
            heartbeatTimeoutMs: WS_HEARTBEAT_TIMEOUT_MS,
            reconnectEnabled: WS_RECONNECT_ENABLED,
            reconnectMinMs: WS_RECONNECT_MIN_MS,
            reconnectMaxMs: WS_RECONNECT_MAX_MS,
            reconnectFactor: WS_RECONNECT_FACTOR,
            reconnectJitter: WS_RECONNECT_JITTER
        }
    }
}

/**
 * Event bus for state changes.
 *  - 'snapshot' => (state: AppState)
 *  - 'patch'    => (evt: PatchEvent)
 */
export const stateEvents = new EventEmitter()

/** Deep clone via JSON (sufficient here since state is POJO) */
function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T
}

/** Emit both patch and snapshot (keeps existing listeners working) */
function emitChanges(prev: AppState, next: AppState) {
    const ops = jsonpatch.compare(prev, next) // RFC 6902 ops to transform prev -> next
    if (ops.length > 0) {
        stateEvents.emit('patch', {
            from: prev.version,
            to: next.version,
            patch: ops
        } satisfies PatchEvent)
    }
    stateEvents.emit('snapshot', clone(next))
}

/** Read-only snapshot (clone) */
export function getSnapshot(): AppState {
    return clone(state)
}

/** Replace entire state (careful): computes and emits patch + snapshot */
export function replaceState(next: Omit<AppState, 'version'> & { version?: number }) {
    const prev = clone(state)
    const version = (typeof next.version === 'number' ? next.version : state.version) + 1
    const updated: AppState = { ...next, version }
    state = updated
    emitChanges(prev, updated)
}

/** Merge helper for small updates; expands with real domain setters over time */
export function set<K extends keyof AppState>(key: K, value: AppState[K]) {
    const prev = clone(state)
    // ensure we replace nested objects so diffing remains precise
    const nextShallow = { ...state, [key]: clone(value) } as AppState
    const updated: AppState = { ...nextShallow, version: state.version + 1 }
    state = updated
    emitChanges(prev, updated)
}

/** Tiny demos you can call from routes/tests */
export function setMessage(text: string) {
    set('message', text)
}
export function setLayout(rows: number, cols: number) {
    set('layout', { rows, cols })
}

/** Optional: update parts of serverConfig at runtime (e.g., admin UI later) */
export function setServerConfig(partial: Partial<ServerConfig>) {
    set('serverConfig', { ...state.serverConfig, ...clone(partial) })
}