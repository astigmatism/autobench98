# AutoBench98 2.0 — Orchestrator State + State Adapters (Reference)

This document is meant to be a **fast, accurate mental model** of how state is represented and how “state adapters” relate to the orchestrator’s global state store. It uses **real shapes** taken from the current code you shared (`core/state.ts` and `adapters/frontPanel.adapter.ts`) so it can serve as a template for future work and reviews.

---

## 1) Single authoritative state container (global store)

**Source of truth:** `services/orchestrator/src/core/state.ts`

### What it owns
- The **singleton in-memory** state object: `let state: AppState`
- The **top-level state composition**: `export type AppState = { ... }`
- **Versioning:** `state.version` increments on every mutation
- **Change broadcast:** emits both
  - `snapshot` (full cloned state)
  - `patch` (RFC 6902 JSON Patch operations) via `fast-json-patch.compare(prev, next)`

### What it exports (high-level)
- Read:
  - `getSnapshot(): AppState` — returns a deep clone of the current state
- Write primitives:
  - `replaceState(next)` — replace whole `AppState` (version bumps)
  - `set(key, value)` — replace a **top-level slice** (version bumps)
- Per-slice helpers:
  - e.g. `updateFrontPanelSnapshot(partial)`, `updateCfImagerSnapshot(partial)`, etc.

### Broadcast behavior (important contract)
Every successful state mutation results in:
1. **Patch event** (if changes exist): `{ from, to, patch }`
2. **Snapshot event**: a cloned `AppState`

This makes the store suitable for:
- Full state sync on connect
- Patch streaming to keep clients up to date efficiently

---

## 2) Slice schema ownership

### Top-level schema
`core/state.ts` defines the **top-level structure** by composing slices:

- `meta`, `layout`, `message`, `serverConfig`
- `powerMeter`, `serialPrinter`, `atlonaController`
- `ps2Keyboard`, `frontPanel`, `cfImager`, `sidecar`

### Slice-internal schema
Some slices are imported types (examples you shared):
- `FrontPanelStateSlice` from `../devices/front-panel/types.js`
- `KeyboardStateSlice` from `../devices/ps2-keyboard/types.js`
- `CfImagerState` from `../devices/cf-imager/types.js`

So: **`core/state.ts` is the canonical composition point**, while some **full slice field schemas** live in the device domain.

---

## 3) What a “state adapter” is

A **state adapter** is a slice-local projection/reducer:

- **Input:** domain events (ex: `FrontPanelEvent`)
- **Output:** a slice snapshot (ex: `FrontPanelStateSlice`)
- **Responsibility:** enforce domain invariants and provide a stable, UI-friendly snapshot over time.

**Source example:** `services/orchestrator/src/adapters/frontPanel.adapter.ts`

### What the FrontPanel adapter does
It maintains an internal `FrontPanelStateSlice` and updates it in `handle(evt)`:

- Device lifecycle:
  - identified / connected / disconnected / lost
- Identification workflow:
  - identify-start / success / failed
- Telemetry:
  - power sense, HDD activity, power button held
- Queue + operations:
  - queued / started / completed / cancelled / failed
- Errors:
  - recoverable / fatal
- Timestamps:
  - updates `updatedAt` via `touch()`

### Invariant examples (real behavior)
On `frontpanel-device-disconnected` and `frontpanel-device-lost`, it “fail-closes”:
- `powerSense = 'unknown'`
- `hddActive = false`
- `powerButtonHeld = false`
- clears queue/op state (`busy=false`, `queueDepth=0`, `currentOp=null`)
- sets `phase` based on reason (`disconnected` vs `error`)

This is exactly what adapters are good for: **policy and invariants per device domain**.

---

## 4) Relationship between adapters and the global store

### Intended relationship (conceptual)
> **Events** → **Adapter computes slice snapshot** → **Global store publishes slice** → **WS/UI receives patch/snapshot**

- The adapter answers: “Given events so far, what does *frontPanel* state look like?”
- The store answers: “How do we version, diff, and distribute *the app’s* state?”

### Important note from current codebase
You observed there are **no usages** of some “replace snapshot” functions like:
- `setFrontPanelSnapshot`
- `setCfImagerSnapshot`
- `setSidecarSnapshot`

That means one (or more) of these is true today:
1. Slices are committed using the **`update*Snapshot` helpers** instead, or
2. Some features update top-level state using `set('frontPanel', ...)` directly, or
3. Those `set*Snapshot` functions exist as **scaffolding / intended API surface**, but are unused.

This doc does not assume which path is used elsewhere; it documents the *pattern* and the shared contracts.

---

## 5) Pattern template (so future reviews are fast)

This is the “shape” of the pattern you already have.

### A) Adapter template (event → slice snapshot)
Typical adapter structure:

```ts
export class DomainStateAdapter {
  private state: DomainSlice

  constructor() {
    this.state = this.initialState()
  }

  handle(evt: DomainEvent) {
    switch (evt.kind) {
      // update this.state fields
      // enforce invariants
      // touch timestamps
    }
  }

  getState(): DomainSlice {
    return { ...this.state } // NOTE: shallow copy (see Safety notes)
  }

  private initialState(): DomainSlice { /* ... */ }
  private touch(): void { this.state.updatedAt = Date.now() }
}
```

### B) Store template (publish slice updates)
`core/state.ts` publishes changes with:

- `set('<sliceKey>', nextSlice)` for full slice replacement, or
- `update<Domain>Snapshot(partial)` for partial merges (per-slice)

And **every store update** yields `patch` and `snapshot` events.

---

## 6) Safety and correctness notes (based on the examples)

### Adapter `getState()` is a shallow copy
Your front panel adapter uses:

```ts
public getState(): FrontPanelStateSlice {
  return { ...this.state }
}
```

This is only a top-level copy. Arrays/objects inside (like `errorHistory`, `operationHistory`) remain shared references.

If any caller mutates those arrays, it can mutate adapter-internal state.

**Mitigations (conceptual options):**
- Return a deep clone from `getState()`, or
- Ensure the only consumer is the store which deep-clones on write (your store does deep clone via `JSON.parse(JSON.stringify(...))`).

### Duplicate “initial state” sources can drift
You currently have **two initializers** for the same slice:
- `initialFrontPanel` in `core/state.ts`
- `FrontPanelStateAdapter.initialState()` in the adapter

If these diverge, behavior becomes inconsistent.

**Preferred direction (conceptual):**
- Choose **one canonical initializer** per slice (either domain module or core/state) and import it everywhere.

---

## 7) Quick glossary

- **Slice:** a top-level field of `AppState` (ex: `frontPanel`, `cfImager`)
- **Snapshot:** full state (or full slice) representation at a moment in time
- **Patch:** RFC 6902 operations describing how to get from version N to N+1
- **Adapter:** event→slice reducer that encodes domain invariants

---

## 8) “If you’re adding a new device” checklist

1. Define slice type (preferably in the device domain).
2. Add slice into `AppState` in `core/state.ts`.
3. Provide an initial slice snapshot.
4. Implement adapter:
   - event kinds
   - invariants on disconnect/lost/error
   - histories/bounds if needed
5. Decide how slice commits into the store:
   - full replacement (`set` / `set<Domain>Snapshot`) or
   - partial merges (`update<Domain>Snapshot`)
6. Ensure store emits patch + snapshot for every mutation.
