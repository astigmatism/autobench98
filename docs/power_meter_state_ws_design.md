
# AutoBench98 Orchestrator  
## WebSocket State Model & Power Meter Integration — Architectural Guide

This document captures the design patterns that govern **backend → frontend state flow** in the AutoBench98 Orchestrator, including the newly added **power meter state slice**. It is written for humans *and* future AI models so they can quickly understand how to integrate new real‑time device domains.

---

# 1. Core Principles

## 1.1 The Orchestrator Is Server‑State Driven  
The backend owns a single authoritative **application state object** (`AppState`).  
The frontend does not compute or infer global state — it **mirrors** the backend through:

- **`state.snapshot`** (full state)  
- **`state.patch`** (RFC‑6902 JSON Patches)

This flow is identical for:
- Layout state  
- Server configuration  
- Benchmarks  
- Power meter readings  
- Any future device/service

The source of truth lives only on the backend.

---

# 2. State Architecture (Backend)

## 2.1 AppState Structure

Located in:  
`apps/orchestrator/src/core/state.ts`

```ts
export type AppState = {
    version: number
    meta: { startedAt: string; status: 'booting' | 'ready' | 'error' }
    layout: { rows: number; cols: number }
    message: string
    serverConfig: ServerConfig
    powerMeter: PowerMeterSnapshot   // <-- new device slice
}
```

### Each mutation results in:
- A new `version` number  
- A **JSON Patch** describing the change  
- A broadcast of both patch and full snapshot

This is handled by:

```ts
emitChanges(prev, next)
```

Which in turn triggers:

- `stateEvents.emit('patch', ...)`
- `stateEvents.emit('snapshot', ...)`

---

# 3. WebSocket Layer

Located in:  
`apps/orchestrator/src/plugins/ws.ts`

## 3.1 Responsibilities

1. Maintain client connections  
2. Send **welcome**  
3. Send **initial full state snapshot**  
4. Send **initial filtered log history**  
5. Broadcast:
   - `state.snapshot`
   - `state.patch`
   - `logs.history`
   - `logs.append`

## 3.2 Message Types (Backend → Frontend)

| Type              | Meaning                                  |
|------------------|------------------------------------------|
| `welcome`        | Initial connection handshake              |
| `state.snapshot` | Entire backend state                      |
| `state.patch`    | RFC‑6902 patch list                       |
| `logs.history`   | Initial log window                        |
| `logs.append`    | Continuous log entries                    |

Frontend receives all state, including the power meter, via `mirror.replaceSnapshot` and `mirror.applyPatch`.

---

# 4. Power Meter State Slice

## 4.1 PowerMeterSnapshot

```ts
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
```

## 4.2 How the slice is updated

### Backend logic converts device events → state updates:

```ts
updatePowerMeterSnapshot({
    phase: 'streaming',
    lastSample: { ts, watts, volts, amps },
    stats: { ... }
})
```

The state layer automatically patches & broadcasts.

---

# 5. Power Meter Service → State Glue

The power meter service publishes internal events:

- `meter-device-identified`
- `meter-device-connected`
- `meter-streaming-started`
- `meter-sample`
- `meter-device-lost`
- `recoverable-error`

A thin glue module listens to these and calls:

```ts
updatePowerMeterSnapshot(...)
```

This keeps business logic separate from the global state model.

---

# 6. Frontend Architecture

## 6.1 WebSocket Client

Located in  
`apps/web/src/lib/wsClient.ts`

- Handles `open`, `close`, `message`, `error`
- Sends `hello` and `subscribe` on connect
- Emits:
  - `message`
  - `status`
  - `open` / `close` / `error`

## 6.2 Bootstrap

Located in:  
`apps/web/src/bootstrap.ts`

Key responsibilities:

```ts
ws.on('message', (m) => {
    if (m.type === 'state.snapshot') mirror.replaceSnapshot(...)
    if (m.type === 'state.patch') mirror.applyPatch(...)
    if (m.type === 'logs.*') logs.append(...)
})
```

This is where power meter state arrives on the frontend.

---

# 7. Mirror Store (Frontend State)

Located in:  
`apps/web/src/stores/mirror.ts`

Acts as a local replica of the entire backend state:

```ts
state: () => ({
    version: 0,
    data: {}   // the full AppState
})
```

Any pane can read power meter data with:

```ts
const mirror = useMirror()
mirror.data.powerMeter   // always up‑to‑date
```

---

# 8. Power Meter Pane (Frontend)

The pane consumes `mirror.data.powerMeter` and displays:

- Connection/streaming status
- Latest watts / volts / amps
- UI recorder
- Live averages while recording

No HTTP polling.  
No secondary WebSocket.  
Just global state pushed by the backend.

---

# 9. Patterns & Best Practices

1. **Backend owns the truth**  
   Device services → glue → global state → WS → client

2. **Never poll**  
   WS patches make all device data real‑time by default.

3. **Frontend stores mirror the backend**  
   The mirror is a projection of backend state, not a source of logic.

4. **Panes consume slices**  
   Panes are dumb displays + UI controls, powered by state slices.

5. **Device services stay isolated**  
   Only the glue layer touches `updatePowerMeterSnapshot`.

---

# 10. Future Extensions

- Add more device slices (keyboard/mouse input metrics, printer, ATX controller…)
- Add runtime serverConfig updates for panes
- Separate WS channels for extremely high-frequency data (if ever needed)
- Add snapshot compression for very large state objects

---

# Version

This document reflects system architecture as of: **2025‑11‑21**

