# AutoBench98 2.0 — Orchestrator State & Log Synchronization Plan (Final)

## 1) State model: domains, versioning, and ownership

- **Single authoritative state container** in the orchestrator (in-memory). All mutations flow through exported APIs; no direct external mutation.
- **Version counter** increments on every state change.
- **Domains (expanded):**
  - `meta`: startedAt, build, orchestratorStatus
  - `config`: request sampling, feature flags
  - `devices`: capture devices, power controllers, health/lastSeen
  - `streams`: ffmpeg/recorder sidecar status, endpoints
  - `jobs`: queue, running jobs, results, DAG/recipe refs
  - `pno`: status, lastRun, progress, findings
  - `logs`: bounded ring metadata
  - `serverConfig`: orchestrator-provided client config (see §4)

```ts
// Simplified illustration
export type AppState = {
  version: number;
  meta: { startedAt: string; build: string; status: 'booting'|'ready'|'error' };
  config: { requestSample: number; features: Record<string, boolean> };
  devices: Record<string, { type: string; status: string; lastSeen?: string }>;
  streams: Record<string, { status: string; url?: string }>;
  jobs: { queue: any[]; running: any[]; lastCompleted?: any };
  pno: { status: string; progress?: number; lastRunAt?: string; summary?: any };
  logs: { nextSeq: number; capacity: number; size: number; head: number };
  serverConfig: ServerConfig;
};
```

## 2) Mutations and projections

- Mutations are performed via a **typed API** (`set()`, `merge()`, `replaceState()`), each bumping `version`.
- **Projections** compute derived data (e.g., summarizing PNO findings).
- Avoid raw high-frequency metrics in state; compute projections before broadcast.

## 3) Transport: WebSocket contract (snapshot then diffs)

- Implemented via `@fastify/websocket` with **permessage-deflate**.
- **Connect flow:**
  1. Send `state.snapshot` → `{ type: 'state.snapshot', stateVersion, data: AppState }`
  2. Send `logs.history` → last N ring entries (server-driven count)
- **Live updates:**
  - `state.patch` (RFC 6902 ops)
  - `logs.append` (new log batches)
- **Client control:**
  - `state.resync` → full state again
  - `logs.replay { sinceSeq }`
- **Gap handling:** client compares `version` and `seq` and requests resync/replay if mismatched.

## 4) ServerConfig (server-driven client configuration)

- Distributed as part of every `state.snapshot` under `serverConfig`.
- Adopted automatically by the web client on connect.

```ts
export type ServerConfig = {
  logs: {
    snapshot: number;           // how many logs sent on connect
    capacity: number;           // suggested client ring size
    allowedChannels: string[];  // WS-visible channels
    minLevel: 'debug'|'info'|'warn'|'error'|'fatal';
  };
  ws: {
    heartbeatIntervalMs: number;
    heartbeatTimeoutMs: number;
    reconnectEnabled: boolean;
    reconnectMinMs: number;
    reconnectMaxMs: number;
    reconnectFactor: number;
    reconnectJitter: number;
  };
};
```

### Server

- Reads from environment:
  - `CLIENT_LOGS_SNAPSHOT`
  - `CLIENT_LOGS_CAPACITY`
  - `LOG_CHANNEL_ALLOWLIST`
  - `LOG_LEVEL_MIN`
  - `VITE_WS_HEARTBEAT_*` / reconnect params
- Included in `getSnapshot()` output.

### Client

- The Pinia store (`useLogs`) adopts this config automatically.
  - Updates capacity, minLevel, and allowedChannels.
  - Persists to localStorage.
  - Displays capacity (`cap`) from server, not hardcoded.

## 5) PNO logs: bounded server ring + stream

- Fixed-size **ring buffer** (default 500, configurable via env).
- Each entry: `{ seq, ts, channel, emoji, level, message, color }`.
- Ring exposed via `/core/logs.adapter` and broadcasted over WS.
- Server emits `logs.append` for new entries and `logs.history` on connect.
- Metadata (capacity, size, seq) resides in `state.logs`, not full entries.

## 6) WebSocket heartbeat, reconnection, and 💓 logging

- Heartbeats every `VITE_WS_HEARTBEAT_INTERVAL_MS` ms; timeout triggers reconnect.
- Reconnect uses jittered exponential backoff (`min`, `max`, `factor`, `jitter`).
- Orchestrator replies to `{ type: 'ping' }` with `{ type: 'pong' }`.
- Optional heartbeat logging via `WS_HEARTBEAT_LOG=true` adds 💓 entries to the websocket channel.

## 7) Front-end (Vue 3 + Pinia) state mirroring

- `` holds `AppState` mirror; updates on snapshots/patches.
- `` manages log entries and UI state.
  - Applies filters (channels, level, search).
  - Stores UI prefs (autoscroll, pause, filters, sort) in localStorage.
  - Handles server-driven capacity and minLevel.
  - Supports `adoptServerConfig(cfg)` for runtime updates.

## 8) Logs UI (Studio)

- **Dynamic channel legend** with multi-select checkboxes.
- **Improved contrast** for active filters.
- **All / None buttons:**
  - *All* → disables filter (shows all).
  - *None* → enables empty filter (shows none).
- **Additional features:**
  - Pause/resume
  - Autoscroll (top/bottom based on sort)
  - Keyword search
  - Level filter
  - Sort (asc/desc by timestamp; default newest first)
  - JSON export of filtered logs
  - LocalStorage persistence for all settings

## 9) Performance & safety

- **State patching** uses RFC 6902 with deep cloning.
- **Broadcast debouncing** (configurable in `serverConfig` or env) to coalesce updates.
- **Compression** enabled on WS.
- **Auth-ready**: handshake token or origin restriction can be added later.
- **Observability**: optional telemetry in `state.meta` (connected clients, errors, timings).

## 10) Testing strategy

- **Unit:** ring buffer wrap/seek, patch idempotence, version increments.
- **Integration:** multi-client connect/disconnect, patch sync, resync on gap.
- **Load:** 10 k logs/min burst tests, ensuring bounded memory and responsive UI.

## 11) Example environment variables (finalized)

```bash
# WebSocket log streaming
LOG_CHANNEL_ALLOWLIST=websocket,app,request,sidecar
LOG_LEVEL_MIN=debug
LOG_REDACT_REGEX=
CLIENT_LOGS_SNAPSHOT=200
CLIENT_LOGS_CAPACITY=500

# Heartbeat / reconnect
VITE_WS_HEARTBEAT_INTERVAL_MS=10000
VITE_WS_HEARTBEAT_TIMEOUT_MS=5000
VITE_WS_RECONNECT_ENABLED=true
VITE_WS_RECONNECT_MIN_MS=1000
VITE_WS_RECONNECT_MAX_MS=15000
VITE_WS_RECONNECT_FACTOR=1.8
VITE_WS_RECONNECT_JITTER=0.2
WS_HEARTBEAT_LOG=true
```

## 12) Directory structure snapshot

```
apps/orchestrator/src
  app.ts
  core/
    state.ts              # serverConfig + patching + versioning
    logs.adapter.ts       # log ring + WS integration
  plugins/
    ws.ts                 # WebSocket plugin (ping/pong, snapshot, append)
apps/web/src
  stores/
    mirror.ts             # mirror AppState
    logs.ts               # log store with filter/search/sort/pause
  components/
    LogsPane.vue          # enhanced log viewer
    WsStatusBadge.vue     # heartbeat status indicator
  composables/
    useOrchestratorWS.ts  # WS client composable
```

---

**Result:** a cohesive, versioned, patch-based orchestration layer with a mirrored Vue 3 front end, server‑driven configuration, and a feature-rich log viewer synchronized in real time.

