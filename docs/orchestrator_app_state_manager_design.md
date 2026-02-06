# AutoBench98 Orchestrator — Application State Manager Design
**Mode:** Verification-First / Safety-Critical  
**Status:** Draft (design; includes pseudocode; not an implementation)  
**Date:** 2026-02-05

---

## 1) Purpose

Define a robust, maintainable **in-process application state manager** for the Orchestrator (Fastify) that:

- Makes **shared state reads** the default collaboration mechanism for services.
- Restricts state **writes** via an ownership model (“single writer per slice”).
- Provides **internal pub/sub on state change** so services can react immediately without polling.
- Preserves existing architecture direction: **service → adapter → AppState → WS → mirror → pane**.

---

## 2) Verified constraints and source references

### 2.1 Single-process constraint (project requirement)
- **Requirement (from user):** Orchestrator will always run as a **single OS process** (Node main thread; optional worker threads; **no multi-process**).

**Implication:** in-memory AppState is valid as the canonical server store, but worker threads must use message passing to interact with state.

### 2.2 Project docs (verbatim excerpts)
These lines are relied upon for this design:

- Refactor plan (core layout):
  - “`core/events/                # Typed event bus + pub/sub`”
  - “`core/state/                 # In-memory state, projections, cache`”
  (win_98_bench_orchestrator_fastify_refactor_plan.md)

- State plan (authoritative in-memory state + versioning + transport):
  - “**Single authoritative state container** in the orchestrator (in-memory). All mutations flow through exported APIs; no direct external mutation.”
  - “**Version counter** increments on every state change.”
  - “Live updates: `state.patch` (RFC 6902 ops) … Client control: `state.resync` …”
  - “Avoid raw high-frequency metrics in state; compute projections before broadcast.”
  (orchestrator_state_plan_final.md)

- WebSocket pane guide (responsibility boundaries + helper-based mutation):
  - “Each new live pane … wiring a **service → adapter → AppState → WS → mirror → pane** chain.”
  - “**Key pattern**: *service adapters never manipulate `AppState` directly*. They call helper functions like `updateFooSnapshot`.”
  - State responsibility:
    - “Owns the canonical `AppState` object.”
    - “Increments `version` for each change.”
    - “Computes **JSON Patch** diffs …”
    - “Emits state changes through an `EventEmitter` (`stateEvents`).”
  (autobench98-websocket-pane-guide.md)

- Frontend integration plan (server truth + snapshot then patches):
  - “Keep the **server as the source of truth** for application state; deliver **full snapshot on connect**, then **incremental patches** thereafter.”
  (frontend_integration_plan.md)

- Logging constraints (shared client buffer):
  - “When exposing logs to a client UI … **all plugins and subsystems must use the same `ClientLogBuffer` instance**.”
  (logging-readme.md)

---

## 3) Problem statement

The current message bus/pub-sub model enables inter-service signaling, but it is not an ideal default for sharing *current truth*.

**Goal:** Services should normally read “what is true right now” from a centralized AppState, and optionally subscribe to state changes for immediate reaction.

Example: FrontPanel determines PC power status. Keyboard needs this value to decide how to behave. Keyboard should not need to “ask” FrontPanel via bus, and FrontPanel should not need to “broadcast to everyone who might care” manually.

---

## 4) Terminology and design principles

### 4.1 Truth vs change (state vs events)
- **State** represents *level-triggered truth* (“PC power is on/off/unknown now”).
- **Events** represent *edge-triggered occurrences* (“PC power changed at time T”).

**Rule:** use AppState for shared truth; use domain events for changes entering the system and for audit/debug streams where appropriate.

### 4.2 Architectural boundaries (existing direction)
- **Service:** owns device/subsystem logic; emits structured domain events; no UI/WS knowledge.
- **Adapter:** listens to service events; translates into state mutations; no device logic.
- **State manager:** owns canonical AppState; versions; computes patches; emits state change notifications.
- **WS plugin:** bridges state change stream to clients.
- **Frontend mirror:** mirrors server state; renders panes.

---

## 5) AppState fundamentals

### 5.1 Canonical container and version
- Single in-memory `AppState`.
- `version` is monotonic; increments once per committed mutation batch.
- All state writes must go through exported APIs; no direct mutation.

### 5.2 Explicit unknown for safety-critical signals
For safety-relevant facts (e.g., PC power), represent **unknown explicitly** (tri-state), not as false.

Recommended representation:
- `value: 'unknown' | 'on' | 'off'`
- `changedAt: number` (epoch ms) or ISO timestamp
- `source: string` (adapter/service provenance)
- Optional `stale: boolean` if you implement freshness rules (not required initially)

---

## 6) Ownership and write restriction

### 6.1 Ownership model (single writer per slice)
Each slice has one “owner” module (usually an adapter). Examples:
- `power.pc` → owned by FrontPanel adapter
- `input.keyboard` → owned by PS/2 keyboard adapter
- `devices.serial` → owned by serial/device registry adapter

### 6.2 Enforcement mechanism (compile-time/project structure)
Primary enforcement is via **module boundaries**:

- `core/state` exports:
  - Read-only selectors and subscription APIs for everyone.
  - Slice-specific mutator functions in modules intended to be imported only by the owning adapter.

This matches the existing guide pattern that adapters mutate state through helpers (e.g., `updateFooSnapshot`) rather than direct manipulation.

**Non-goal:** runtime “security.” This is about maintainability and correctness within one trusted process.

---

## 7) Internal State Change Pub/Sub (chosen design)

### 7.1 Core idea (selected)
When an owner mutates state, the state manager:

1) Commits mutation atomically  
2) Increments version  
3) Computes a patch (or identifies changed paths)  
4) Notifies subscribers whose interest matches the change

### 7.2 Subscription granularity (selected: both, with different audiences)
- **Internal services:** **Slice-level subscriptions** (preferred for maintainability)
- **WS/debug:** **Patch-stream subscriptions** (already implied by snapshot/patch protocol)

Rationale:
- Slice subscriptions reduce filtering complexity and avoid tight coupling to patch format.
- Patch stream is a natural bridge for WebSocket clients and diagnostic tooling.

### 7.3 Dispatch semantics (selected)
To keep the system safe and maintainable:

- State commits are **atomic and synchronous**.
- Subscriber notifications are **asynchronous** (next tick / microtask) and **coalesced** by slice and version.
- Subscriber errors are **isolated** (one subscriber cannot break the state manager or others).
- Subscribers are not permitted to synchronously mutate the same slice without guardrails (loop prevention).

---

## 8) Composition-root registration (selected)

Subscriptions must be registered in the **composition root** (plugin wiring), not hidden inside service modules.

Benefits:
- Makes dependencies explicit and reviewable.
- Avoids implicit coupling and “spooky action at a distance.”
- Aligns with the project’s plugin-based composition approach.

---

## 9) Concurrency and worker threads

### 9.1 Main-thread authority
The canonical AppState lives on the **main thread**.

### 9.2 Worker interaction (if used)
Workers cannot safely access the in-memory object directly. They must use message passing:

- Worker → main: send domain events / commands
- Main → worker: send snapshots or selector results (as needed)

**Invariant:** all mutations occur on main thread.

---

## 10) API surface (conceptual)

### 10.1 Read APIs (selectors)
Selectors are stable and safe for all modules:

- `selectPcPower(state): PcPowerState`
- `selectDeviceStatus(state, id): DeviceStatus`
- etc.

### 10.2 Write APIs (slice mutators)
Mutators are slice-owned helpers (imported only by the owner adapter):

- `updatePcPower(partial: PcPowerUpdate): void`
- `updateKeyboardStatus(partial: KeyboardUpdate): void`

Mutators must:
- validate/normalize inputs
- avoid high-frequency raw data where possible (prefer projections)
- commit via the state manager’s atomic update mechanism

### 10.3 Subscription APIs
Two subscription types:

1) Slice-level subscription (preferred for services)
- Subscribe by **selector** or **slice key**
- Callback receives `(newValue, oldValue, meta)`

2) Patch-stream subscription (preferred for WS/debug)
- Subscribe to commit meta and patch list: `(fromVersion, toVersion, patchOps)`

---

## 11) Pseudocode (illustrative; not implementation)

### 11.1 Types (conceptual)
```ts
type Version = number

type AppState = {
  version: Version
  power: {
    pc: {
      value: 'unknown' | 'on' | 'off'
      changedAt?: number
      source?: string
    }
  }
  // ...other domains
}
```

### 11.2 Atomic commit + patch computation + event emission
```ts
class StateManager {
  private state: AppState
  private stateEvents: EventEmitter // per websocket guide
  private pendingSliceNotifications: Map<string, PendingNotice>

  commit(mutator: (draft: AppState) => void, changedPathsHint?: string[]) {
    const before = deepFreezeClone(this.state)

    // 1) apply mutation to a draft
    const draft = deepClone(this.state)
    mutator(draft)

    // 2) bump version once per commit
    draft.version = before.version + 1

    // 3) compute patch (RFC 6902)
    const patchOps = computeJsonPatch(before, draft) // conceptual

    // 4) swap state atomically
    this.state = deepFreeze(draft)

    // 5) emit patch stream immediately (WS/debug listeners)
    this.stateEvents.emit('patch', {
      fromVersion: before.version,
      toVersion: draft.version,
      patchOps
    })

    // 6) schedule async, coalesced slice notifications (services)
    const changedSlices = deriveChangedSlices(patchOps, changedPathsHint)
    this.enqueueSliceNotifications(changedSlices, before, this.state)
  }
}
```

### 11.3 Slice subscriptions (async + coalesced)
```ts
type SliceSubscriber<T> = (next: T, prev: T, meta: { toVersion: Version }) => void

class StateManager {
  private sliceSubs: Map<string, Set<SliceSubscriber<any>>>

  subscribeSlice<T>(sliceKey: string, selector: (s: AppState) => T, fn: SliceSubscriber<T>) {
    // store (sliceKey, selector, fn) in registry
    // return unsubscribe()
  }

  private enqueueSliceNotifications(changedSliceKeys: string[], prev: AppState, next: AppState) {
    for (const key of changedSliceKeys) {
      // coalesce by key: keep only the latest next-state for this tick
      this.pendingSliceNotifications.set(key, { prev, next, toVersion: next.version })
    }

    scheduleMicrotaskOnce(() => this.flushSliceNotifications())
  }

  private flushSliceNotifications() {
    for (const [key, notice] of this.pendingSliceNotifications) {
      const subs = this.sliceSubs.get(key) ?? new Set()
      for (const sub of subs) {
        try {
          const prevVal = sub.selector(notice.prev)
          const nextVal = sub.selector(notice.next)
          if (!deepEqual(prevVal, nextVal)) {
            sub.fn(nextVal, prevVal, { toVersion: notice.toVersion })
          }
        } catch (err) {
          // error isolation: log; do not break other subs
          logWarn('state.sliceSubscriber.error', { key, err })
        }
      }
    }
    this.pendingSliceNotifications.clear()
  }
}
```

### 11.4 Loop-prevention rule (policy + helper)
```ts
// Policy: subscriber callbacks MUST NOT synchronously call commit() for the same slice.
// If they need to cause changes, they schedule a command back through composition root.
function safeReact(fn: () => void) {
  scheduleMicrotask(fn) // prevents immediate recursion on same call stack
}
```

### 11.5 Composition-root wiring (explicit dependencies)
```ts
// Composition root / plugin wiring:
const state = new StateManager(/* initial AppState */)

// FrontPanel owner adapter mutator
const updatePcPower = makePcPowerMutators(state)

// Wire: FrontPanel events -> updatePcPower(...)
frontPanelAdapter.onPowerSenseChanged(evt => {
  updatePcPower.set({
    value: evt.isOn ? 'on' : 'off',
    changedAt: now(),
    source: 'frontPanel'
  })
})

// Wire: Keyboard reacts to power state without asking FrontPanel
state.subscribeSlice(
  'power.pc',
  s => s.power.pc,
  (next, prev) => {
    // keyboard chooses policy; state only provides truth
    keyboardService.setPowerTruth(next.value)
  }
)

// WS plugin bridges patch stream to clients
state.onPatch(({ fromVersion, toVersion, patchOps }) => {
  wsBroadcast({ type: 'state.patch', fromVersion, toVersion, patch: patchOps })
})
```

---

## 12) Safety-critical invariants and checks

### Invariants (must hold)
- **Atomicity:** observers never see partial state changes.
- **Monotonic version:** `version` increments exactly once per commit.
- **Deterministic ordering:** commits serialize on the main thread.
- **Unknown is explicit:** no implicit coercion from unknown → off/false for safety signals.
- **Subscriber isolation:** one subscriber failure cannot break others or corrupt state.
- **Loop resistance:** feedback loops are prevented by design rules and async dispatch.

### Checklist for adding a new slice
- [ ] Define slice schema including unknown/stale semantics if relevant.
- [ ] Assign a single owner module (adapter).
- [ ] Provide mutators (owner-only imports).
- [ ] Provide selectors (public).
- [ ] Decide whether consumers need subscription wiring (composition root).
- [ ] Ensure mutations do not carry high-frequency raw telemetry (use projections).

---

## 13) Interactions with existing WS + logging plans

### WS state sync
This design preserves the “snapshot then patch” protocol:
- `state.snapshot` on connect
- `state.patch` with RFC 6902 ops
- `state.resync` as client control for mismatch

### Logging
Any new adapter/service introduced to support state or subscriptions must reuse the shared `ClientLogBuffer` instance (per logging-readme.md) so UI log streaming remains correct.

---

## 14) Open decisions (optional; not required to proceed)

These are optional refinements; this design does not require them immediately:

1) **Staleness policy** for certain slices (e.g., power becomes `unknown` if no signal in N seconds).
2) **Subscription backpressure** behavior (drop/coalesce/warn) if subscribers are slow.
3) **Formal lint rules** to enforce that only owner modules import mutators.

---

## 15) Summary of selected decisions (for implementers)

- **State is the default collaboration surface** for shared truth.
- **Writes are restricted by ownership** (single writer per slice), implemented via module boundaries.
- **Internal pub/sub exists** via slice-level subscriptions; notifications are **async** and **coalesced**.
- **Patch stream exists** for WS/debug bridging.
- **Composition root** registers subscriptions (explicit wiring).
- **Main thread owns AppState**; workers interact via message passing.

---

## 16) File placement suggestion (non-binding)

- `services/orchestrator/src/core/state/`
  - `StateManager.ts` (canonical container, commit/version/patch/subscriptions)
  - `selectors.ts` (public selectors)
  - `slices/` (owner mutators, grouped by domain)
- `services/orchestrator/src/core/events/` (existing typed bus / EventSink patterns)
- `services/orchestrator/src/plugins/` (composition root wiring: adapters/services/state/ws)

This matches the existing refactor plan’s core module boundaries.
