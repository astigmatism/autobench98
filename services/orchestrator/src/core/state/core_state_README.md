# core/state — User Guide (How to add and use AppState)
**Audience:** Humans (and future AI assistants) working in the AutoBench98 Orchestrator  
**Scope:** Practical “how-to” for `services/orchestrator/src/core/state/`  
**Mode:** Verification-First / Safety-Critical

---

## What `core/state` is
`core/state` is the orchestrator’s **in-process, server-owned** application state:

- There is one canonical `AppState` object (in memory).
- Every mutation **bumps `version`** exactly once per commit.
- Changes are observable as:
  - **patch stream** (`stateEvents: 'patch'`) for WebSocket/UI and debugging
  - **slice subscriptions** (`subscribeSlice`) for internal service reactions

**Mental model:** “Shared truth lives in AppState. Services read it. A small number of owners write it.”

---

## The three roles
### 1) State owner (writer)
A single adapter/module “owns” a slice and is responsible for writing it via **mutators**.

Example: FrontPanel adapter owns `power.pc`.

### 2) Consumer (reader / reactor)
Consumers:
- read state via **selectors** (preferred), and/or
- react to changes via **`subscribeSlice`** (registered in composition root)

### 3) Composition root (wiring)
The orchestrator plugin/wiring layer:
- initializes state once (`initState`)
- wires service events → slice mutators
- registers subscriptions (service reactions) explicitly

---

## Where things live (file map)
You’ll touch these files most often:

- `types.ts`  
  Defines `AppState` schema (the shape of the world).

- `initialState.ts`  
  Defines default values for `AppState` (including safety-safe “unknown” defaults).

- `state.ts`  
  State engine: `getSnapshot`, `commit`, `set`, `merge`, `subscribeSlice`, `stateEvents`.

- `slices/<name>.ts`  
  The recommended home for:
  - selectors (read APIs)
  - owner mutators (write APIs)
  - slice key constants (`SLICE_*`)

- `slices/index.ts` (+ optionally `../index.ts`)  
  Re-export slice modules for clean imports.

---

## Adding new application state (checklist)

### Step 1 — Add it to the schema (`types.ts`)
Add a new field to `AppState`. Keep it JSON-serializable.

**Safety-critical rule:** if the value represents a real-world truth you might not know yet, use an explicit `unknown` state instead of assuming `false` or `off`.

Example (conceptual):
```ts
export type FooStatus = 'unknown' | 'ready' | 'error'

export type AppState = {
  // ...
  foo: { status: FooStatus; changedAt?: number; source?: string }
}
```

### Step 2 — Add defaults (`initialState.ts`)
Initialize your new slice in `createInitialState()`.

Example:
```ts
foo: { status: 'unknown' }
```

### Step 3 — Create a slice module (`slices/foo.ts`)
A slice module should generally expose:

1) **Selectors** (public; safe for any consumer)
2) **Mutators** (owner-only; used by the owning adapter)
3) **Slice keys** (strings used for subscription routing)

Example pattern:
```ts
export const SLICE_FOO = 'foo'
export const SLICE_FOO_STATUS = 'foo.status'

export function selectFoo(state: AppState) {
  return state.foo
}

export function setFooStatus(args: { status: FooStatus; source?: string }) {
  commit(draft => {
    draft.foo.status = args.status
    draft.foo.changedAt = Date.now()
    draft.foo.source = args.source
  }, { changedSliceKeys: [SLICE_FOO_STATUS] })
}
```

**Important:** always pass `changedSliceKeys` from mutators when you can. This makes subscriptions precise and future-proof.

### Step 4 — Export it (`slices/index.ts`)
Add:
```ts
export * from './foo'
```

(Optionally re-export from `core/state/index.ts` if you want a single import path.)

### Step 5 — Wire the owner in composition root
In your plugin/wiring layer:

- listen to service events
- call the slice mutator (owner-only) to update AppState

Conceptual:
```ts
frontPanel.onPowerSenseChanged(evt => {
  setPcPowerTruth({ value: evt.isOn ? 'on' : 'off', source: 'frontpanel' })
})
```

### Step 6 — Wire consumers (optional but common)
If another service needs immediate updates:

Register a subscription in composition root:
```ts
subscribeSlice(
  'power.pc',
  s => s.power.pc,
  (next) => keyboardService.setPowerTruth(next.value),
  { name: 'keyboard-power-truth' }
)
```

**Rule:** Prefer composition-root subscription registration over “services self-register subscriptions,” so dependencies stay visible.

---

## Reading state (consumer guidance)

### Use selectors, not raw property access
Prefer:
```ts
selectPcPower(getSnapshot())
```
over:
```ts
getSnapshot().power.pc
```

Selectors keep consumers stable even if the underlying state structure changes.

### Conservative gating (common safety pattern)
For safety, convert `unknown` to a conservative boolean where needed:

- `unknown` → treat as “not safe to proceed” (often equivalent to “off”)

That should live in a selector (example already exists in `slices/power.ts`):
- `selectPcIsPoweredOnConservative()`

---

## Reacting to changes (subscriptions)

### Subscription semantics
- Notifications are **async** and **coalesced** (many rapid commits → subscribers see the latest state per tick).
- Subscribers receive: `(next, prev, meta)` where `meta` includes:
  - `toVersion`
  - `changedSliceKeys`

### Design rule (loop prevention)
Subscriber callbacks should **not** synchronously mutate the same slice they’re reacting to.
If you need to trigger follow-up changes, do it through normal mutators and schedule work (next tick), to avoid feedback loops.

---

## Patch stream + WebSocket integration
The state engine emits:

- `stateEvents.emit('patch', { from, to, patch })`
- `stateEvents.emit('snapshot', snapshot)`

The WS layer typically:
- sends a full snapshot on connect
- streams patches thereafter

This keeps the server authoritative and the UI as a mirror.

---

## Environment variables for state (optional)
The state system supports a small “application state” env section:

- `STATE_BUILD_ID` → `AppState.meta.build` (preferred over `BUILD_ID`)
- `STATE_BOOT_STATUS` → `AppState.meta.status` (`booting|ready|error`)
- `STATE_FEATURES_JSON` → `AppState.config.features` (JSON booleans)
- `REQUEST_SAMPLE` → `AppState.config.requestSample`

(See `.env.example` for the section header and comments.)

---

## Common pitfalls (avoid these)
- **Forgetting initial state defaults** → consumers see `undefined`.
- **Letting many modules write the same slice** → hidden coupling and hard-to-debug behavior.
- **Not passing `changedSliceKeys`** → subscriptions become coarse and noisy.
- **Using state to store high-frequency raw telemetry** → bloated patches and UI churn. Prefer projections/rolling buffers elsewhere.
- **Treating `unknown` as `off` inside AppState** → you lose the ability to distinguish “we don’t know” from “we know it’s off.”
  - Keep `unknown` in state; do conservative conversion in selectors.

---

## TL;DR (one screen)
To add new state:
1) add schema to `types.ts`
2) add defaults in `initialState.ts`
3) create `slices/<name>.ts` with selectors + owner mutators + slice keys
4) export it in `slices/index.ts`
5) wire owner writes and consumer subscriptions in composition root
