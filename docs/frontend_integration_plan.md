
# Front‑End Integration & Design Plan (AutoBench98 2.0)

**Date:** 2025-11-09  
**Scope:** Introduce a single‑page, component‑driven front‑end that pairs tightly with the Orchestrator (Fastify) over WebSockets.  
**Goal:** Keep the **server as the source of truth** for application state; deliver **full snapshot on connect**, then **incremental patches** thereafter. Persist a **user‑customizable grid/split layout** and a **component registry** for pluggable views.

---

## 1) Summary of Recommendations

- **Framework:** **Vue 3 + Vite + TypeScript**, with **Pinia** for local reactive stores (as a *mirror* of server state).
  - Alt options: **Svelte + Vite** (ultra‑light, compiled), **SolidJS** (fast signals), **Lit** (Web Components).
  - **Recommendation:** Vue 3 strikes the best balance of ecosystem, reactivity, dev‑velocity, and non‑corporate capture.
- **Layout Model:** **Split‑pane BSP (Binary Space Partition)** tree (like VS Code/i3 tiling).
  - Supports split/merge/resize operations; each leaf hosts **one component** (from the registry).
  - Persisted as JSON per client/profile; replayable to rebuild layout.
- **Transport:** **WebSocket** as primary path. Initial **state snapshot** followed by **RFC 6902 JSON Patch** diffs.
  - Server maintains **monotonic `stateVersion`**; clients ACK to support gap recovery.
  - Optional **Redis** channel (pub/sub) inside the Orchestrator for scalable fan‑out (future‑proofing).
- **State Ownership:** **Authoritative back‑end state** kept in Orchestrator memory first; optional **Redis** as shared middleware if we need HA/scale.
- **Persistence:** Layouts stored server‑side keyed by client/user profile; additionally cached in `localStorage` for fast warm start.
- **Security:** HMAC or JWT for WS authentication; origin checks; per‑message `stateVersion` & replay controls.
- **Observability:** Front‑end logs streamed to the **custom logger** channel via WS; request sampling gates noisy telemetry.

---

## 2) Architecture at a Glance

```
[ Browser (Vue SPA) ]
   ├─ Component Registry (dynamic import)
   ├─ Layout Tree (BSP splits) ──┐
   ├─ Pinia Store (mirror)       │
   └─ WS Client (auth, backoff) ─┴───────────► [ Orchestrator (Fastify) ]
                                          ├─ Global App State (authoritative)
                                          ├─ JSON Patch Generator (diff/seq)
                                          ├─ Client Session Manager (versions, acks)
                                          ├─ Layout Persistence (per user/client)
                                          ├─ Custom Logger (front‑end log sink)
                                          └─ (Optional) Redis (state bus + persistence)
```

---

## 3) State Sync Protocol

### 3.1 Message Types

- **Client → Server**
  - `hello`: `{ clientId, authToken, capabilities: ["json-patch"], lastSeenVersion? }`
  - `subscribe`: `{
      topics: ["appState", "events"],
      includeSnapshot: true
    }`
  - `ack`: `{ uptoVersion }`
  - `layout.save`: `{ clientId, layoutVersion, layoutTree }`
  - `log`: `{ level, channel, message, meta? }`

- **Server → Client**
  - `welcome`: `{ serverTime, stateVersion, snapshot?, heartbeatMs }`
  - `state.snapshot`: `{ stateVersion, data }`
  - `state.patch`: `{ fromVersion, toVersion, patch: [ ...rfc6902 ops ] }`
  - `event`: domain events (optional stream separate from state)
  - `error`: protocol or auth errors
  - `pong`: heartbeat response (if using ping/pong at app layer)

### 3.2 Versioning & Recovery

- Server maintains **`stateVersion`** (uint64).
- Each `state.patch` carries `fromVersion`/`toVersion`.
- Client:
  1. Applies patch only if `fromVersion === localVersion`.
  2. On mismatch, requests `state.snapshot`.
  3. Sends periodic `ack(uptoVersion)`.
- Server may keep a **rolling patch buffer** (e.g., last N versions) to satisfy late clients without forcing full snapshot.

### 3.3 Patch Format

- **RFC 6902 (JSON Patch)** operations: `add`, `remove`, `replace`, `move`, `copy`, `test`.
- Advantages: small, ordered, explicit; easy to compose; great for nested object graphs.

---

## 4) Global Application State

### 4.1 Ownership

- **Authoritative state** lives in the Orchestrator process memory for lowest latency.
- **Scale‑out path:** Optionally mirror to **Redis** (pub/sub + persistence) when we introduce multiple orchestrator replicas:
  - Orchestrators subscribe to a `state:patches` channel.
  - One writer instance (leader) emits patches; others replay to keep in sync.
  - Persist **checkpoint** `{{stateVersion, stateHash}}` for consistency checks.

### 4.2 Shape (example)

```json
{
  "stateVersion": 42,
  "meta": {
    "orchestratorId": "orch-1",
    "uptimeMs": 1234567
  },
  "sessions": {
    "active": 7
  },
  "components": {
    "available": ["LogStream", "StatsCard", "OCCRStream", "FFmpegMonitor"]
  },
  "streams": {
    "ffmpeg": { "status": "running", "bitrate": 3500 },
    "occr":   { "status": "idle" }
  },
  "log": {
    "levels": ["debug","info","warn","error"]
  }
}
```

> **Note:** Client never “owns” truth; it **projects** server truth into a reactive store.

---

## 5) Layout System (BSP Split Tree)

### 5.1 Data Model

```ts
type Orientation = "row" | "column"; // row = horizontal split (stacked); column = vertical split (side-by-side)

interface SplitNode {
  id: string;
  kind: "split";
  orientation: Orientation;
  ratio: number; // 0..1, size of first child
  a: LayoutNode;
  b: LayoutNode;
}

interface LeafNode {
  id: string;
  kind: "leaf";
  locked?: boolean; // optional strict width/height lock
  widthPx?: number; // optional hard size when locked
  heightPx?: number;
  component?: string; // ComponentRegistry key
  props?: Record<string, unknown>;
}

type LayoutNode = SplitNode | LeafNode;

interface LayoutDocument {
  layoutVersion: number;
  root: LayoutNode;
}
```

### 5.2 Interactions

- **Hover Controls:** a soft “✣” icon centered in cell opens a **Control Panel**:
  - Assign/Change **Component** (from Registry)
  - **Split** (Row/Column) with default 50/50
  - **Resize** (drag splitter) → updates `ratio`
  - **Lock size** (strict width/height) or free
  - **Merge** (if neighbor shares a split)
  - **Save as Default / Named Layout**
- **Keyboard (optional):** quick split/merge/resizing for power users.

### 5.3 Persistence

- On change, emit `layout.save` to server.
- Server stores per **clientId**/**profileId** (`layouts/{clientId}.json` or Redis hash).
- On connect, server sends last saved layout; client falls back to `localStorage` cache if server is empty.

---

## 6) Component Registry

- **Goal:** Hot‑pluggable visual modules.
- **Registry Entry:**
  ```ts
  interface RegistryItem {
    key: string;                 // e.g., "LogStream"
    title: string;               // UI label
    load: () => Promise<any>;    // dynamic import() for code splitting
    defaultProps?: object;
    requiredTopics?: string[];   // WS topics needed
  }
  ```
- **Usage:** A leaf with `component: "LogStream"` mounts that component and passes `{ props, storeSelectors }`.
- **Data Flow:** Components **subscribe to slices** of Pinia store; they **never** fetch server state directly (only through the store fed by WS).

---

## 7) Front‑End Stack Details

- **Vue 3 + Vite + TypeScript**
  - **Pinia** (state mirror)
  - **VueUse** (utilities), **Zod** (runtime input validation), **ESLint/Prettier/Vitest**
  - **CSS:** Tailwind or CSS Grid/Flex (choice: start with plain CSS Grid + small utility classes)
- **Why Vue?**
  - Reactive core, composition API, light mental model, mature ecosystem, approachable for newcomers.

**Alternative: Svelte (+ Vite)**
- Faster compiled output, minimal boilerplate, great for SPA dashboards.
- Smaller ecosystem than Vue; still a strong contender if we want max lightness.

**Decision:** Start **Vue 3**, keep Svelte as viable later migration for tiny bundle goals.

---

## 8) WebSocket Client Design

```ts
class WSClient {
  connect(url, token): Promise<void>;
  send(msg): void;
  onMessage(fn): () => void;
  onStatePatch(fn): () => void;
  onSnapshot(fn): () => void;
  onEvent(fn): () => void;
  close(): void;
}
```

- **Features**
  - Auth header or `?token=` query param (HMAC/JWT).
  - Exponential backoff reconnect with jitter.
  - Heartbeats (`ping`/`pong` or app `heartbeatMs` timer).
  - **Backpressure:** buffer outbound messages; drop non‑critical telemetry if queue > N.
  - **Integrity:** after reconnect, advertise `lastSeenVersion`; server decides **patch replay vs full snapshot**.

---

## 9) Server (Orchestrator) Additions

1. **State Manager**
   - Owned in memory; exposes `getSnapshot()`, `apply(domainEvent)`, and emits RFC6902 patches.
   - Tracks `stateVersion` and **ring buffer** of recent patches.
2. **Session Manager**
   - Tracks client `clientId`, last acked version, subscriptions.
   - On connect: send `welcome` → `state.snapshot`.
3. **Patch Engine**
   - Uses a diff lib to build patches from prev snapshot or from event application.
4. **Layout Store**
   - REST or WS RPC `layout.save` / `layout.get`.
   - Keyed by `clientId` or authenticated user principal.
5. **Security**
   - Verify token on `hello`; optional origin checking & rate limits.
6. **Observability**
   - Attach to **custom logger** (`@autobench98/logging`) with channels: `WS`, `STATE`, `LAYOUT`, `CLIENT`.
   - Sample with `REQUEST_SAMPLE` to control verbosity.

---

## 10) Persistence Options

| Concern     | Default (MVP)               | Scale‑Out Option             |
|-------------|------------------------------|------------------------------|
| State       | In‑process memory            | Redis (shared state bus)     |
| Layouts     | JSON file / KV store         | Redis hash / Postgres        |
| Sessions    | In‑memory map                | Redis session store          |
| Events/logs | Disk + console via logger    | Loki/ELK/OpenSearch via sink |

---

## 11) Data Contracts

### 11.1 `welcome`
```json
{ "serverTime": "2025-11-08T00:00:00Z", "stateVersion": 123, "heartbeatMs": 15000 }
```

### 11.2 `state.snapshot`
```json
{ "stateVersion": 123, "data": { /* entire state */ } }
```

### 11.3 `state.patch`
```json
{
  "fromVersion": 123,
  "toVersion": 124,
  "patch": [
    { "op": "replace", "path": "/streams/ffmpeg/status", "value": "running" }
  ]
}
```

### 11.4 `layout.save`
```json
{
  "clientId": "browser-uuid",
  "layoutVersion": 7,
  "layoutTree": { /* BSP tree */ }
}
```

---

## 12) Security

- **Auth:** Signed JWT (short TTL) or HMAC token on WS URL; rotate on reconnect.
- **Least privilege:** Topic subscriptions enforced server‑side.
- **Replay safety:** Version checks; refuse patches out of order.
- **Input validation:** Zod schemas on both ends for layout/state messages.
- **CORS/WS Origin:** Restrict to known origins in non‑dev.

---

## 13) Migration & Extensibility

- **Add components** by adding a new Registry entry and a dynamic import.
- **Add services** by extending server state and emitting domain events → patches.
- **Swap transport** (e.g., SSE) with a thin client adapter if needed.
- **Optional HLS/MJPEG panes** can be embedded components fed by state.

---

## 14) Milestones & Deliverables

1. **M0 – Protocol Spike (1–2 days)**
   - WS handshake, `welcome`, snapshot, incremental patches, simple counter state.
2. **M1 – Layout BSP**
   - Split/merge/resize, hover controls, component mount; persist local.
3. **M2 – Registry + Two Components**
   - `LogStream` and `StatsCard`; runtime assignment in cells.
4. **M3 – Server Layout API**
   - `layout.save/get` bound to clientId; JSON storage.
5. **M4 – Reliability**
   - Reconnect flow, version recovery, patch ring buffer, backpressure.
6. **M5 – Security + Telemetry**
   - JWT/HMAC on WS; front‑end logs → orchestrator logger.

---

## 15) Open Decisions (with Guidance)

- **Vue vs Svelte:** Start Vue for ecosystem depth; reevaluate after M3 if bundle size/ergonomics push us to Svelte.
- **Redis:** Defer until we need multi‑process or HA; keep design compatible from day one.
- **State Diffing:** Prefer **JSON Patch**; fall back to **JSON Merge Patch** for coarse updates if desired.
- **Layout Locking:** Implement strict px lock minimally; evolve toward % and min/max bounds after usability feedback.

---

## 16) Appendix — Minimal Type Hints

```ts
// Pinia store mirrors server state + version
export interface MirrorStore {
  version: number;
  data: Record<string, any>;
  applyPatch(patch: any[]): void;
  replaceSnapshot(version: number, data: any): void;
}

// WS envelope
export interface Envelope<T = any> {
  type: string;
  id?: string;
  ts?: number;
  payload: T;
}
```

---

## 17) Next Steps (What I’ll implement first)

- Skeleton Vue SPA with Pinia, Registry, and a dummy BSP layout.
- WS client with `hello` → `welcome` → `state.snapshot` path and JSON Patch application.
- Two sample components to validate data flow: `StatsCard`, `LogStream`.
- Layout persistence round‑trip (client ↔ server).

---

**End of Plan**
