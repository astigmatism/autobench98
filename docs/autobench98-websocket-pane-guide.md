# General Guide: Building WebSocket‑Driven Panes in the Autobench98 Orchestrator/Web Client

> **Purpose**  
> This document is a reusable blueprint for building _any_ WebSocket‑driven pane in Autobench98 — not just the power meter.
> It is written to be:
>
> -   **Human‑readable** (for you / other engineers)
> -   **Model‑readable** (for future AI assistants asked to implement new panes)

The architecture is split into **four main layers**:

1. **Service layer (backend domain service)** – talks to hardware/external systems, emits structured events
2. **State layer (backend app state + diffs)** – maintains `AppState`, computes JSON Patches
3. **WebSocket transport (backend WS plugin)** – broadcasts snapshots/patches/logs to connected clients
4. **Client mirror + panes (frontend)** – mirrors server state and renders panes from that mirror

Each new live pane you build is mostly about wiring a **service → adapter → AppState → WS → mirror → pane** chain.

---

## 1. Concepts & Responsibilities

### 1.1 Service vs Adapter vs State vs Pane

-   **Service (backend domain)**

    -   Knows _how_ to talk to a device or subsystem (serial, HTTP, process, etc.).
    -   Works with **domain types** (e.g., `FooSample`, `FooState`).
    -   Emits **structured events** to a generic `EventSink` interface.
    -   Has **no knowledge of WebSockets, Fastify, Vue, or panes**.

-   **Adapter (backend)**

    -   Listens to service events via the `EventSink`.
    -   Translates them into **changes to `AppState`** (through helpers like `updateFooSnapshot`).
    -   Has **no device logic**; it trusts events from the service.

-   **State (`state.ts`, backend)**

    -   Owns the canonical `AppState` object.
    -   Increments `version` for each change.
    -   Computes **JSON Patch** diffs between old state and new state.
    -   Emits state changes through an `EventEmitter` (`stateEvents`).

-   **WebSocket plugin (`ws.ts`, backend)**

    -   Manages the `/ws` endpoint.
    -   On connect: sends `welcome`, a `state.snapshot`, and log history.
    -   On state changes: sends `state.patch` messages.
    -   Handles client messages (`hello`, `ping`, `subscribe`, etc.).

-   **Mirror store (`mirror.ts`, frontend)**

    -   Holds a reactive copy `{ version, data }` of `AppState`.
    -   Receives `state.snapshot` + `state.patch` from WS client.
    -   Applies JSON Patches with `fast-json-patch` and updates its version.

-   **Pane (e.g., `FooPane.vue`, frontend)**
    -   Reads from the mirror (`mirror.data`).
    -   Interprets a specific slice of `AppState` (e.g., `mirror.data.fooService`).
    -   Defines all UI behaviors (controls, charts, etc.).
    -   Never talks directly to the WS socket or backend services.

---

## 2. Backend State Management (`state.ts`)

### 2.1 AppState Shape

`AppState` is the server‑authoritative state mirrored to clients. Example (simplified):

```ts
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

export type FooSnapshot = {
    phase: 'disconnected' | 'connecting' | 'ready' | 'error'
    message?: string
    stats: {
        totalEvents: number
        lastEventAt: number | null
        lastErrorAt: number | null
    }
    data: unknown | null
}

export type AppState = {
    version: number
    meta: { startedAt: string; status: 'booting' | 'ready' | 'error' }
    layout: { rows: number; cols: number }
    message: string
    serverConfig: ServerConfig
    fooService: FooSnapshot // <--- your new slice
    // other slices: powerMeter, logs, etc.
}
```

When adding a new pane backed by a service, you will:

1. Define a **snapshot type** for it (`FooSnapshot`).
2. Extend `AppState` with a new field (`fooService: FooSnapshot`).
3. Create **initial state** for that slice.

### 2.2 Initial State & Global State Variable

```ts
const startedAt = new Date().toISOString()

const initialFoo: FooSnapshot = {
    phase: 'disconnected',
    message: undefined,
    stats: {
        totalEvents: 0,
        lastEventAt: null,
        lastErrorAt: null
    },
    data: null
}

let state: AppState = {
    version: 1,
    meta: { startedAt, status: 'ready' },
    layout: { rows: 1, cols: 1 },
    message: 'Hello from orchestrator',
    serverConfig: {
        /* ... from env ... */
    },
    fooService: initialFoo
    // ... other slices (e.g., powerMeter)
}
```

### 2.3 EventEmitter and Cloning

```ts
export const stateEvents = new EventEmitter()

function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T
}
```

We clone to keep `AppState` a plain JS object and prevent accidental mutation by listeners.

### 2.4 Emitting Changes with JSON Patch

```ts
function emitChanges(prev: AppState, next: AppState) {
    const ops = jsonpatch.compare(prev, next)

    if (ops.length > 0) {
        stateEvents.emit('patch', {
            from: prev.version,
            to: next.version,
            patch: ops
        })
    }

    stateEvents.emit('snapshot', clone(next))
}
```

-   `compare(prev, next)` computes RFC‑6902 JSON Patch operations that transform `prev` into `next`.
-   `patch` listeners receive a minimal diff; `snapshot` listeners can ignore patches and just use full state.

### 2.5 Helpers: `getSnapshot`, `replaceState`, `set`, `setFooSnapshot`, `updateFooSnapshot`

```ts
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
    const nextShallow = { ...state, [key]: clone(value) } as AppState
    const updated: AppState = { ...nextShallow, version: state.version + 1 }
    state = updated
    emitChanges(prev, updated)
}

// Specific helpers for a new slice
export function setFooSnapshot(next: FooSnapshot) {
    set('fooService', next)
}

export function updateFooSnapshot(
    partial: Partial<FooSnapshot> & {
        stats?: Partial<FooSnapshot['stats']>
    }
) {
    const mergedStats = partial.stats
        ? { ...state.fooService.stats, ...clone(partial.stats) }
        : state.fooService.stats

    const merged: FooSnapshot = {
        ...state.fooService,
        ...clone(partial),
        stats: mergedStats
    }

    set('fooService', merged)
}
```

**Key pattern**: _service adapters never manipulate `AppState` directly_. They call helper functions like `updateFooSnapshot`.

---

## 3. Backend Service Pattern

A “service” is any component that:

-   Maintains its own internal state, buffers, etc.
-   Communicates with hardware, processes, HTTP APIs, etc.
-   Emits **domain events** to `PowerMeterEventSink`‑like sinks.

### 3.1 Event Sink Interface (Generic Pattern)

For a generic subsystem, define something like:

```ts
export type FooPhase = 'idle' | 'busy' | 'error'

export type FooSample = {
    ts: string
    value: number
    meta?: Record<string, unknown>
}

export type FooEvent =
    | { kind: 'foo-started'; at: number }
    | { kind: 'foo-stopped'; at: number; reason?: string }
    | { kind: 'foo-sample'; at: number; sample: FooSample }
    | { kind: 'foo-error'; at: number; error: string }
    | { kind: 'foo-recovered'; at: number }

export interface FooEventSink {
    publish(evt: FooEvent): void
}
```

Then your service receives `FooEventSink` in its constructor:

```ts
interface FooServiceDeps {
    events: FooEventSink
}

export class FooService {
    private readonly config: FooConfig
    private readonly deps: FooServiceDeps

    constructor(config: FooConfig, deps: FooServiceDeps) {
        this.config = config
        this.deps = deps
    }

    // ... internal methods that call this.deps.events.publish(...)
}
```

### 3.2 Service Lifecycle Expectations

-   `start()` – sets up any long‑lived (or periodic) background work, or nothing.
-   `stop()` – tears down resources, timers, connections.
-   Additional lifecycle methods (like `onDeviceIdentified`, `onDeviceLost`) depending on the domain.

### 3.3 Error & Reconnect Strategy

For anything that can be intermittently unavailable:

-   Track stats (`lastErrorAt`, `totalFailures`, etc.).
-   Publish both **recoverable** and **fatal** events. Example pattern:

```ts
this.deps.events.publish({
    kind: 'foo-error',
    at: Date.now(),
    error: `Failed to open foo connection: ${err.message}`
})
```

-   Let the adapter decide how to present this to AppState (`phase: 'connecting'` vs `phase: 'error'`).

---

## 4. Backend Adapters: Service → AppState

An adapter translates domain events into updates on the `AppState` slice for that service.

### 4.1 Example Generic Adapter

```ts
import { getSnapshot, updateFooSnapshot } from '../core/state.js'
import { type FooEvent, type FooSample } from '../core/foo/types.js'

export class FooStateAdapter {
    private sampleCount = 0

    handle(evt: FooEvent): void {
        switch (evt.kind) {
            case 'foo-started': {
                updateFooSnapshot({
                    phase: 'connecting',
                    message: undefined
                })
                return
            }

            case 'foo-recovered': {
                const snap = getSnapshot()
                const stats = snap.fooService.stats
                updateFooSnapshot({
                    phase: 'ready',
                    message: undefined,
                    stats: {
                        ...stats,
                        lastErrorAt: null
                    }
                })
                return
            }

            case 'foo-sample': {
                this.sampleCount += 1
                const sample: FooSample = evt.sample
                const snap = getSnapshot()
                const stats = snap.fooService.stats

                updateFooSnapshot({
                    phase: 'ready',
                    data: sample, // or a simplified view
                    stats: {
                        totalEvents: stats.totalEvents + 1,
                        lastEventAt: evt.at,
                        lastErrorAt: stats.lastErrorAt
                    }
                })
                return
            }

            case 'foo-error': {
                const snap = getSnapshot()
                const stats = snap.fooService.stats
                updateFooSnapshot({
                    phase: 'connecting',
                    message: evt.error,
                    stats: {
                        ...stats,
                        lastErrorAt: evt.at
                    }
                })
                return
            }

            case 'foo-stopped': {
                updateFooSnapshot({
                    phase: 'disconnected',
                    message: evt.reason ?? 'Stopped'
                })
                return
            }
        }
    }
}
```

### 4.2 Fanout Sink (Logging + State Update)

In your Fastify plugin, create a fanout sink so multiple consumers can subscribe to the same events:

```ts
class FooLoggerEventSink implements FooEventSink {
    private readonly logFoo: ReturnType<ReturnType<typeof createLogger>['channel']>

    constructor(app: FastifyInstance) {
        const { channel } = createLogger('foo', app.clientBuf)
        this.logFoo = channel(LogChannel.app)
    }

    publish(evt: FooEvent): void {
        const ts = new Date(evt.at).toISOString()
        this.logFoo.info(`kind=${evt.kind}`)
    }
}

class FanoutFooEventSink implements FooEventSink {
    private readonly sinks: FooEventSink[]
    constructor(...sinks: FooEventSink[]) {
        this.sinks = sinks
    }
    publish(evt: FooEvent): void {
        for (const sink of this.sinks) {
            try {
                sink.publish(evt)
            } catch {
                /* ignore per-sink failure */
            }
        }
    }
}
```

---

## 5. Fastify Plugin for a Service

Each service is usually wrapped in a **Fastify plugin** to:

-   Instantiate the service and its event sinks
-   Bind it to the app instance (`app.fooService = ...`)
-   Hook into `onReady` / `onClose`

### 5.1 Example Plugin Skeleton

```ts
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { createLogger, LogChannel, type ClientLogBuffer } from '@autobench98/logging'

import { FooService } from '../core/foo/FooService.js'
import { type FooEvent, type FooEventSink } from '../core/foo/types.js'
import { FooStateAdapter } from '../adapters/foo.adapter.js'
import { buildFooConfigFromEnv } from '../core/foo/utils.js'

declare module 'fastify' {
    interface FastifyInstance {
        fooService: FooService
        clientBuf: ClientLogBuffer
    }
}

const fooPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    const env = process.env
    const { channel } = createLogger('foo-plugin', app.clientBuf)
    const logPlugin = channel(LogChannel.app)

    const fooConfig = buildFooConfigFromEnv(env)

    const loggerSink = new FooLoggerEventSink(app)
    const stateAdapter = new FooStateAdapter()

    const fooEvents: FooEventSink = new FanoutFooEventSink(loggerSink, {
        publish: (evt: FooEvent) => stateAdapter.handle(evt)
    })

    const fooService = new FooService(fooConfig, { events: fooEvents })
    app.decorate('fooService', fooService)

    app.addHook('onReady', async () => {
        logPlugin.info('starting foo service')
        await fooService.start()
    })

    app.addHook('onClose', async () => {
        logPlugin.info('stopping foo service')
        await fooService.stop().catch((err: unknown) => {
            logPlugin.warn('error stopping foo service', {
                err: (err as Error).message
            })
        })
    })
}

export default fp(fooPlugin, {
    name: 'foo-service-plugin'
})
```

This plugin is a **template**: swap out `FooService` and associated types to onboard a new subsystem.

---

## 6. WebSocket Plugin (`ws.ts`)

The WS plugin is generic: it doesn’t care whether a patch came from fooService, powerMeter, or something else.

### 6.1 Initial Frames on Connect

```ts
app.get('/ws', { websocket: true }, (socket, _req) => {
  sockets.add(socket)

  try {
    socket.send(JSON.stringify({
      type: 'welcome',
      serverTime: new Date().toISOString()
    }))

    const snap = getSnapshot()
    socket.send(JSON.stringify({
      type: 'state.snapshot',
      stateVersion: snap.version,
      data: snap
    }))

    // logs.history, etc...
  } catch (e) {
    logWs.error('failed to send initial frames', { err: (e as Error).message })
  }
```

### 6.2 Client Messages

```ts
socket.on('message', (data: RawData) => {
    try {
        const text = typeof data === 'string' ? data : data.toString()
        const msg = JSON.parse(text)

        if (msg?.type === 'hello') {
            socket.send(JSON.stringify({ type: 'ack', ok: true }))
            return
        }

        if (msg?.type === 'ping') {
            socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
            // (optional heartbeat log)
            return
        }

        if (msg?.type === 'subscribe') {
            const includeSnapshot = !!msg?.payload?.includeSnapshot
            if (includeSnapshot) {
                const snap2 = getSnapshot()
                socket.send(
                    JSON.stringify({
                        type: 'state.snapshot',
                        stateVersion: snap2.version,
                        data: snap2
                    })
                )
                // optional logsHistory handling
            }
            return
        }
    } catch {
        // ignore malformed payload
    }
})
```

### 6.3 Broadcasting State Changes

```ts
const onSnapshot = (snap: AppState) => {
    const payload = JSON.stringify({
        type: 'state.snapshot',
        stateVersion: snap.version,
        data: snap
    })
    for (const ws of sockets) {
        if (ws.readyState === ws.OPEN) ws.send(payload)
    }
}

const onPatch = (evt: { from: number; to: number; patch: unknown[] }) => {
    const payload = JSON.stringify({
        type: 'state.patch',
        fromVersion: evt.from,
        toVersion: evt.to,
        patch: evt.patch
    })
    for (const ws of sockets) {
        if (ws.readyState === ws.OPEN) ws.send(payload)
    }
}

stateEvents.on('snapshot', onSnapshot)
stateEvents.on('patch', onPatch)
```

The WS plugin doesn’t need to be modified when you add new slices; it just forwards patches.

---

## 7. Frontend: Mirror Store

The **mirror store** keeps a live copy of server `AppState` and version.

### 7.1 Pinia Store

```ts
import { defineStore } from 'pinia'
import type { Operation } from 'fast-json-patch'
import { applyPatch } from 'fast-json-patch'

export const useMirror = defineStore('mirror', {
    state: () => ({ version: 0, data: {} as Record<string, any> }),
    actions: {
        replaceSnapshot(version: number, data: any) {
            this.version = version
            this.data = data
        },
        applyPatch(from: number, to: number, patch: Operation[]) {
            if (from !== this.version) return false
            const res = applyPatch(this.data, patch, false, false)
            this.version = to
            this.data = res.newDocument
            return true
        }
    }
})
```

### 7.2 WS Client → Mirror

The WS client (`wsClient` + `startRealtime`) routes `state.snapshot` and `state.patch` into this store:

```ts
if (m?.type === 'state.snapshot' && m?.data) {
    if (typeof m.stateVersion === 'number') {
        mirror.replaceSnapshot(m.stateVersion, m.data)
    }
    return
}

if (m?.type === 'state.patch') {
    const from = m.fromVersion ?? m.payload?.fromVersion
    const to = m.toVersion ?? m.payload?.toVersion
    const patch = m.patch ?? m.payload?.patch
    if (typeof from === 'number' && typeof to === 'number' && Array.isArray(patch)) {
        mirror.applyPatch(from, to, patch)
    }
    return
}
```

Any pane can now read `mirror.data` and treat it as `AppState`.

---

## 8. Frontend: Building a New Pane

A new pane is a Vue SFC that:

-   Accepts an optional `pane` prop (layout info)
-   Computes read‑only slices from `mirror.data`
-   Adds UI behavior around that slice

### 8.1 Basic Pane Skeleton (Generic “FooPane”)

```vue
<template>
    <div class="foo-pane" :style="{ '--pane-fg': paneFg, '--panel-fg': panelFg }">
        <div class="header">
            <h2 class="title">Foo Service</h2>
            <span class="status-badge" :data-phase="state.phase">
                <span class="dot"></span>
                <span class="label">{{ statusLabel }}</span>
            </span>
        </div>

        <div class="panel main-panel">
            <div class="panel-head">
                <span class="panel-title">Current data</span>
                <span class="panel-meta" v-if="latestTs">
                    {{ latestTs }}
                </span>
                <span class="panel-meta dim" v-else>No data yet…</span>
            </div>

            <!-- Your visualization (metrics, chart, etc.) -->
            <pre class="raw-json" v-if="latestData">{{ latestData }}</pre>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useMirror } from '@/stores/mirror'

type Direction = 'row' | 'col'
type Constraints = {
    widthPx?: number | null
    heightPx?: number | null
    widthPct?: number | null
    heightPct?: number | null
}
type Appearance = {
    bg?: string | null
    mTop?: number | null
    mRight?: number | null
    mBottom?: number | null
    mLeft?: number | null
}
type PaneInfo = {
    id: string
    isRoot: boolean
    parentDir: Direction | null
    constraints: Constraints
    appearance: Appearance
    container: { constraints: Constraints | null; direction: Direction | null }
}
const props = defineProps<{ pane?: PaneInfo }>()

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    if (!hex) return null
    const s = hex.trim().replace(/^#/, '')
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null
    const int = parseInt(s, 16)
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 }
}
function srgbToLinear(c: number): number {
    const x = c / 255
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
}
function relLuminance(hex: string): number {
    const rgb = hexToRgb(hex)
    if (!rgb) return 1
    const r = srgbToLinear(rgb.r)
    const g = srgbToLinear(rgb.g)
    const b = srgbToLinear(rgb.b)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrastRatio(l1: number, l2: number): number {
    const [L1, L2] = l1 >= l2 ? [l1, l2] : [l2, l1]
    return (L1 + 0.05) / (L2 + 0.05)
}

const paneFg = computed(() => {
    const bg = (props.pane?.appearance?.bg ?? '#ffffff') as string
    const Lbg = relLuminance(bg)
    const contrastWithWhite = contrastRatio(relLuminance('#ffffff'), Lbg)
    const contrastWithBlack = contrastRatio(relLuminance('#000000'), Lbg)
    return contrastWithWhite >= contrastWithBlack ? '#ffffff' : '#111111'
})
const panelFg = '#e6e6e6'

type FooPhase = 'disconnected' | 'connecting' | 'ready' | 'error'
type FooSnapshot = {
    phase: FooPhase
    message?: string
    stats: { totalEvents: number; lastEventAt: number | null; lastErrorAt: number | null }
    data: unknown | null
}

const mirror = useMirror()

const foo = computed<FooSnapshot>(() => {
    const root = mirror.data as any
    return (
        (root?.fooService as FooSnapshot) ?? {
            phase: 'connecting',
            message: 'Waiting for foo service…',
            stats: { totalEvents: 0, lastEventAt: null, lastErrorAt: null },
            data: null
        }
    )
})

const state = computed(() => ({
    phase: foo.value.phase,
    message: foo.value.message ?? null
}))

const statusLabel = computed(() => {
    switch (state.value.phase) {
        case 'ready':
            return 'Ready'
        case 'connecting':
            return 'Connecting…'
        case 'disconnected':
            return 'Disconnected'
        case 'error':
            return 'Error'
        default:
            return 'Unknown'
    }
})

const latestTs = computed(() => {
    const ts = foo.value.stats.lastEventAt
    if (!ts) return ''
    const d = new Date(ts)
    if (Number.isNaN(d.getTime())) return ''
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(
        2,
        '0'
    )}:${String(d.getSeconds()).padStart(2, '0')}`
})
const latestData = computed(() => foo.value.data)
</script>

<style scoped>
.foo-pane {
    --pane-fg: #111;
    --panel-fg: #e6e6e6;

    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: 100%;
    width: 100%;
    color: var(--pane-fg);
}

.header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
}

.title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
}

.status-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid #374151;
    background: #0b0d12;
    font-size: 0.75rem;
    color: var(--panel-fg);
}

.status-badge .dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: #9ca3af;
}

.main-panel {
    background: #0b0d12;
    border: 1px solid #1f2933;
    border-radius: 8px;
    padding: 8px;
    color: var(--panel-fg);
    display: flex;
    flex-direction: column;
    min-height: 0;
}

.panel-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 0.8rem;
}

.panel-title {
    font-weight: 600;
}

.panel-meta {
    font-size: 0.78rem;
    opacity: 0.9;
}
.panel-meta.dim {
    opacity: 0.6;
}

.raw-json {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.78rem;
    background: #020617;
    border-radius: 6px;
    padding: 8px;
    border: 1px solid #111827;
    overflow: auto;
}
</style>
```

This is your **generic template** for a pane that consumes a single slice (`fooService`) from `AppState`.

---

## 9. End‑to‑End Checklist for a New WebSocket‑Driven Pane

When building a completely new service + pane, follow this checklist:

1. **Define domain types & event sink**
    - `FooEvent`, `FooEventSink`, `FooPhase`, `FooSample`, etc.
2. **Implement the service**
    - `FooService` with `start`, `stop`, and any device/API wiring.
    - Emit events to `FooEventSink` — never mutate `AppState` directly.
3. **Extend AppState**
    - Add `FooSnapshot` type for your service.
    - Extend `AppState` with a `fooService` field.
    - Initialize it with a reasonable default (`phase: 'disconnected'`, etc.).
4. **Add state helpers**
    - `setFooSnapshot(next: FooSnapshot)`
    - `updateFooSnapshot(partial: Partial<FooSnapshot> & { stats?: Partial<FooSnapshot['stats']> })`
5. **Implement an adapter**
    - `FooStateAdapter.handle(evt: FooEvent)`
    - Translate each event kind into `updateFooSnapshot` calls.
6. **Wire a Fastify plugin**
    - Create logger sink + state adapter sink.
    - Fan them out with `FanoutFooEventSink`.
    - Instantiate `FooService` with `{ events: fooEvents }`.
    - Decorate `app.fooService`.
    - Start/stop in `onReady` / `onClose` hooks.
7. **No changes needed in `ws.ts`**
    - It will automatically pick up new patches because they’re part of `AppState`.
8. **Use the mirror store on the frontend**
    - `const mirror = useMirror()`
    - `const foo = computed(() => (mirror.data as any).fooService ?? fallback)`
9. **Build a pane**
    - Add a new pane component in `apps/web/src/components/panes/FooPane.vue`.
    - Use the template pattern from section 8.
    - Bind to computed slice `foo`.
    - Implement your UI, charts, or controls.
10. **Add pane registration (if needed)**

-   If your layout manager needs to know about the new pane, register it in whatever pane registry or router you use.

11. **Test end‑to‑end**

-   Start the orchestrator.
-   Confirm service logs in the logs pane.
-   Confirm WS `state.snapshot` and `state.patch` show your new slice.
-   Confirm the pane updates live from the mirror.

---

## 10. Notes for Future AI Assistants

If you are an AI model asked to “create a new pane backed by a service” in this repo, you should:

1. **Search for existing services and panes**

    - Look at patterns from existing `SerialPowerMeterService` and `PowerMeterPane.vue`.
    - Mirror the separation: service → adapter → AppState slice → pane.

2. **Never mutate global AppState directly from a service**

    - Always go through helper functions in `state.ts`.

3. **Treat WebSockets as a transport for generic state patches**

    - Don’t embed domain logic inside `ws.ts`.
    - Don’t add domain‑specific message types there unless absolutely necessary.

4. **Keep adapters stateless**

    - Any durable state should live in the service or in `AppState`.
    - Adapters should be pure(ish) functions of events → state updates.

5. **Preserve version consistency**

    - Use `from` / `to` versions correctly in patches.
    - If mismatched, drop the patch (as `mirror.applyPatch` does).

6. **Honor the pane contract**
    - Panes receive an optional `pane` prop with layout + appearance.
    - Use the contrast helpers to compute `--pane-fg` for text.
    - Keep styles scoped and consistent with existing panes.

This document should give you (or a future AI assistant) enough structure to safely build the _next_ WebSocket‑driven pane without re‑discovering the architecture every time.
