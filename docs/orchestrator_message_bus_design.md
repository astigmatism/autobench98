# AutoBench98 Orchestrator Message Bus — Design (v1)

**Status:** Draft (requirements locked from interview)  
**Scope:** Orchestrator-internal, in-process message bus for coordination/control between orchestrator components.

---

## 1. Problem statement

The orchestrator contains multiple internal components (e.g., `frontpanel`, `ps2keyboard`, `ps2mouse`) that must coordinate without direct coupling. A concrete driver is broadcasting **machine power status changes** detected by the front panel/Arduino path to other components that must gate their behavior on that status.

This document defines a **stateless** pub/sub message bus used strictly for **message passing** (coordination), not for maintaining authoritative state.

---

## 2. Confirmed requirements

### 2.1 Boundaries and scope
- **Same-process only:** All publishers/subscribers run inside the same orchestrator process (Node/Fastify). No cross-process transport in v1.
- **Stateless bus:** No durable storage, no replay/history, no retention of “last known value” as a bus feature.
- **Low-frequency control plane:** Intended for coordination/control messages, not high-frequency data planes.

### 2.2 Safety semantics
- Power gating is conservative: **`UNKNOWN` must be treated as `OFF`** by consumers.
- Safety-critical topics are controlled by an explicit **engineer-maintained allowlist**.
- Schema handling is **hybrid**:
  - **Strict** for allowlisted safety-critical topics (reject unknown versions / invalid payloads).
  - **Permissive** for non-critical topics (warn, allow handler to decide).

### 2.3 Delivery semantics
- **Async delivery**; publisher must not be blocked by subscriber handlers.
- **FIFO ordering per topic** (within this process).
- **Per-subscriber isolation:** one subscriber failing must not impact others.
- **Backpressure:** bounded per-subscriber queue; on overflow, **auto-disable/unsubscribe** the subscriber and emit an error signal.

### 2.4 Subscriptions and filtering
- Subscriptions support:
  - topic patterns with wildcards (`*`, `**`)
  - attribute filtering
- Attributes:
  - `Record<string, string | number | boolean>`
  - filter ops: **equals + exists** (v1)

### 2.5 Topic naming and validation
- Dot-separated segments, **lowercase**
- Allowed chars per segment: `a-z`, `0-9`, `-`
- No empty segments, no leading/trailing `.`
- Reserved namespace: `bus.*` (internal events emitted by the bus)

### 2.6 Helpers and metadata
- `subscribeOnce()` supported (auto-unsubscribe after first matching delivery).
- Event `id` is required; the bus generates one if absent.
- Per-topic monotonic `seq` is assigned by the bus (non-durable; resets on process restart).
- Publish API:
  - `publish()` enqueues and returns immediately.
  - Bus exposes `idle()/flush()` for tests and shutdown determinism.

### 2.7 Non-goals
- No request/response or RPC helper.
- No durability / replay / “replayLast” feature.
- No ACLs for publish/subscribe (any module can publish/subscribe any topic).

---

## 3. Architecture overview

### 3.1 Relationship to state
The bus is **not** an authoritative state store. State is maintained elsewhere:
- within the publishing service, and/or
- within a dedicated state controller / orchestrator state container.

**Rule:** For any stateful signal (e.g., power), the authoritative “current value” must be obtained from the state system, not from bus retention.

### 3.2 Bus responsibilities
- Fan-out delivery of events to matching subscribers.
- Enforce topic naming rules.
- Apply subscription filtering (topic pattern + attribute filters).
- Provide per-topic FIFO ordering.
- Enforce backpressure policy (disable slow subscribers).
- Emit observability signals (metrics + error logs).
- Enforce schema rules for safety-critical allowlisted topics.

---

## 4. Event envelope

All published messages MUST conform to this envelope:

```ts
type Primitive = string | number | boolean;

interface BusEvent<TPayload = unknown> {
  /** Topic name; must pass validation rules. */
  topic: string;

  /** Unique event id; bus generates if absent. */
  id?: string;

  /** Monotonic per-topic sequence assigned by bus. */
  seq?: number;

  /** Publish timestamp (ms since epoch). Bus may set if absent. */
  ts?: number;

  /** Publisher identity (module/service name). */
  source: string;

  /** Payload schema version. */
  schemaVersion: number;

  /** Optional attribute map for filtering/routing. */
  attributes?: Record<string, Primitive>;

  /** Typed payload. */
  payload: TPayload;
}
```

**Notes:**
- `seq` and `id` become present on delivery (bus-assigned).
- `seq` is **not durable** and resets after process restart.

---

## 5. Topic patterns and wildcard matching

Topics are dot-separated segments.

Wildcards:
- `*` matches **exactly one** segment
  - Example: `frontpanel.power.*` matches `frontpanel.power.changed`
- `**` matches **zero or more** segments
  - Example: `frontpanel.**` matches `frontpanel.power.changed` and `frontpanel.serial.connected`

Matching is applied to the topic string as segments, not as raw string prefix.

---

## 6. Attribute filtering (v1)

### 6.1 Subscription filter model

```ts
interface AttributeFilter {
  /** equals match on key -> value */
  equals?: Record<string, Primitive>;

  /** key must exist (any value) */
  exists?: string[];
}

interface SubscriptionFilter {
  /** Topic pattern, may include wildcards. */
  topic: string;

  /** Optional attribute filter. */
  attributes?: AttributeFilter;
}
```

### 6.2 Matching rules (deterministic)
A message is delivered to a subscription if:
1. `topic` matches the subscription topic pattern, and
2. if `attributes.exists` is present, each named key is present in the event attributes, and
3. if `attributes.equals` is present, each key matches exactly (`===`) to the event attribute value.

No prefix/range/regex operators in v1.

---

## 7. Delivery model

### 7.1 Ordering and concurrency
- Per-topic FIFO ordering is preserved as observed by each subscriber.
- Delivery is asynchronous relative to `publish()`.
- Subscribers may still execute concurrently across topics, unless an implementation chooses to serialize more strictly.

### 7.2 Handler isolation
- Each subscriber handler invocation is wrapped so that exceptions are caught.
- A handler exception:
  - increments metrics (`handler_threw`)
  - emits a bus error signal
  - does **not** prevent delivery to other subscribers

### 7.3 subscribeOnce()
- A `subscribeOnce()` subscription auto-unsubscribes after first successful delivery.

---

## 8. Backpressure and failure policy

### 8.1 Bounded queues
- Each subscriber has a bounded inbound queue capacity `N` (configurable; small is expected due to low-frequency scope).

### 8.2 Overflow policy (required)
If a subscriber’s queue exceeds the bound:
- The bus **auto-disables/unsubscribes** that subscriber.
- The bus emits an error signal (see §10).
- The bus increments metrics (`subscriber_disabled_backpressure`).

This policy prevents slow consumers from accumulating unbounded memory and ensures coordination signals don’t stall publishers.

---

## 9. Schema handling and safety-critical allowlist

### 9.1 Safety-critical allowlist
An explicit configuration list identifies safety-critical topic patterns, e.g.:

```ts
const safetyCriticalTopics = [
  "frontpanel.power.*",
  // ... engineer-maintained ...
];
```

### 9.2 Validation and behavior
- For messages whose topic matches the allowlist:
  - schemaVersion MUST be recognized by the subscriber’s schema set
  - payload MUST validate
  - otherwise: the bus rejects delivery to handlers and emits an error signal
- For non-allowlisted topics:
  - unknown versions or payload validation issues produce warnings, and delivery is allowed (handler decides)

**Note:** This document defines the bus behavior; schema definition/validation mechanism (e.g., Zod, JSON Schema) is implementation detail and must be specified alongside the consuming module’s contract.

---

## 10. Observability requirements

### 10.1 Metrics (per topic; counters)
- `published_total{topic}`
- `delivered_total{topic}`
- `schema_rejected_total{topic}` (safety-critical rejections)
- `handler_threw_total{topic}`
- `subscriber_disabled_backpressure_total{topic}`
- `subscriber_disabled_manual_total{topic}` (if supported)

### 10.2 Logging (errors only by default)
Error logs MUST be emitted for:
- subscriber disabled due to backpressure
- handler exception
- safety-critical schema rejection
- invalid topic name on publish/subscribe

Debug logs may be enabled optionally, but per-message logging is not required.

### 10.3 Bus error signals
The bus must provide both:
1. **Local hooks** on subscriptions (e.g., `onError`, `onDisabled`)
2. **Global bus.* topics** for observability

Reserved internal topics:
- `bus.subscriber.disabled`
- `bus.message.rejected`
- `bus.handler.error`

---

## 11. API surface (conceptual)

```ts
type Handler<TPayload = unknown> = (event: BusEvent<TPayload>) => void | Promise<void>;

interface SubscriptionOptions {
  /** Optional subscriber identifier for logs/metrics. */
  name?: string;

  /** Backpressure capacity (defaults to bus config). */
  queueCapacity?: number;

  /** Error hook for this subscriber. */
  onError?: (err: unknown, event?: BusEvent) => void;

  /** Called when subscriber is disabled by bus. */
  onDisabled?: (reason: "backpressure" | "manual") => void;
}

interface Subscription {
  unsubscribe(): void;
  isActive(): boolean;
}

interface Bus {
  subscribe<TPayload = unknown>(
    filter: SubscriptionFilter,
    handler: Handler<TPayload>,
    options?: SubscriptionOptions
  ): Subscription;

  subscribeOnce<TPayload = unknown>(
    filter: SubscriptionFilter,
    handler: Handler<TPayload>,
    options?: SubscriptionOptions
  ): Subscription;

  publish<TPayload = unknown>(event: BusEvent<TPayload>): void;

  /** Resolves when all currently enqueued deliveries are complete. */
  idle(): Promise<void>;
}
```

---

## 12. Integration guidance (non-normative examples)

### 12.1 Power change flow (recommended)
- FrontPanel component determines new power status (from Arduino messages).
- FrontPanel updates authoritative state elsewhere (service state / state controller).
- FrontPanel publishes a coordination event:

Topic: `frontpanel.power.changed`  
Attributes (example): `{ machine: "win98", source: "arduino" }`  
Payload (example; schemaVersioned by that module): `{ state: "on" | "off" | "unknown", reason?: string }`

Consumers:
- PS/2 keyboard/mouse subscribe and gate behavior:
  - if `state !== "on"`: stop/drop immediately
  - if `state === "on"`: begin/init sequence

**Note:** Because the bus is stateless, consumers obtain “current power state” from authoritative state at service startup, not from the bus.

---


---

# User Guide

This section is a practical guide for engineers implementing and using the orchestrator message bus described in this document.

## 1. Core concepts

### 1.1 Bus is message-passing only (stateless)
- The bus **does not** store or replay events.
- Any “current value” (e.g., current power state) must come from **service-owned state** or a **separate state controller**.
- The bus is used to broadcast **changes**, **commands**, and **coordination signals**.

### 1.2 Topics are hierarchical and validated
Topics are dot-separated segments and must match:

- lowercase only
- segments contain `a-z`, `0-9`, `-`
- no empty segments, no leading/trailing `.`

Examples:
- ✅ `frontpanel.power.changed`
- ✅ `ps2.keyboard.ready`
- ✅ `bus.subscriber.disabled`
- ❌ `FrontPanel.Power` (uppercase)
- ❌ `frontpanel..power` (empty segment)
- ❌ `frontpanel_power.changed` (underscore not allowed)

### 1.3 Ordering and async delivery
- `publish()` **does not block** subscriber handlers.
- Delivery is **FIFO per topic**.
- One subscriber failing does not prevent delivery to others.

---

## 2. Publishing events

### 2.1 Minimal publish
Publishers must set at minimum:
- `topic`
- `source`
- `schemaVersion`
- `payload`

The bus will populate:
- `id` (if absent)
- `seq` (per-topic monotonic)
- `ts` (if absent)

```ts
bus.publish({
  topic: "frontpanel.power.changed",
  source: "frontpanel",
  schemaVersion: 1,
  attributes: { machine: "win98", source: "arduino" },
  payload: { state: "on", reason: "rail_present" },
});
```

### 2.2 Publishing safety-critical topics
If the topic matches the **safety-critical allowlist**, the bus applies strict schema behavior (see §9):
- invalid payload / unknown schema version → **rejected**
- rejection produces error telemetry (`schema_rejected_total{topic}`) and a bus error signal (see §6)

**Important:** the bus can only enforce “strict” behavior if you actually wire schema validation into the bus implementation for those topics. This design document requires strict behavior; the implementation must provide it.

---

## 3. Subscribing to events

### 3.1 Subscribe (persistent)
```ts
const sub = bus.subscribe(
  { topic: "frontpanel.power.changed" },
  (evt) => {
    // evt.id, evt.seq, evt.ts are available on delivery
    // handle evt.payload
  },
  { name: "ps2keyboard-power-gate" }
);

// Later:
sub.unsubscribe();
```

### 3.2 SubscribeOnce (auto-unsubscribe after first match)
Use this for one-shot coordination (device ready, specific transition, etc.).

```ts
bus.subscribeOnce(
  { topic: "device.serial.connected", attributes: { equals: { device: "frontpanel" } } },
  (evt) => {
    // runs once, then unsubscribes automatically
  },
  { name: "wait-for-frontpanel-connect" }
);
```

---

## 4. Topic patterns (wildcards)

Wildcards are segment-based:

- `*` matches **exactly one** segment
- `**` matches **zero or more** segments

Examples:
- `frontpanel.power.*` matches:
  - `frontpanel.power.changed`
  - `frontpanel.power.status`
- `frontpanel.**` matches:
  - `frontpanel.power.changed`
  - `frontpanel.serial.connected`
  - `frontpanel.power` (if it exists as a full topic)

Example subscription:
```ts
bus.subscribe({ topic: "frontpanel.power.*" }, onPowerEvent);
```

**Verification note:** the bus implementation must do segment-based matching, not raw-string prefix matching.

---

## 5. Attribute filtering

### 5.1 Attribute types
Attributes are restricted to:
- `string | number | boolean`

Example publish:
```ts
bus.publish({
  topic: "device.serial.connected",
  source: "serial",
  schemaVersion: 1,
  attributes: { device: "frontpanel", port: "COM6", baud: 9600, simulated: false },
  payload: { /* ... */ }
});
```

### 5.2 Filter operators (v1)
Supported operators:
- `equals`: exact match
- `exists`: key presence

Example subscribe:
```ts
bus.subscribe(
  {
    topic: "device.serial.*",
    attributes: {
      equals: { device: "frontpanel" },
      exists: ["port"],
    },
  },
  (evt) => { /* ... */ }
);
```

No prefix/range/regex attribute operators in v1.

---

## 6. Failure handling and bus error signals

### 6.1 Per-subscription hooks
Use hooks for local handling (enter safe mode, stop devices, etc.).

```ts
bus.subscribe(
  { topic: "frontpanel.power.changed" },
  handlePower,
  {
    name: "ps2mouse-power-gate",
    onError: (err, evt) => {
      // local reaction: log, safe-mode, etc.
    },
    onDisabled: (reason) => {
      // bus disabled this subscriber (e.g., backpressure)
      // local reaction must be safe (e.g., stop emitting PS/2)
    },
  }
);
```

### 6.2 Global `bus.*` topics
The bus also emits internal events for observability and centralized handling:

- `bus.subscriber.disabled`
- `bus.message.rejected`
- `bus.handler.error`

Example:
```ts
bus.subscribe({ topic: "bus.**" }, (evt) => {
  // central logging/metrics pipeline can listen here
});
```

**Topic reservation:** Only the bus should publish to `bus.*`.

---

## 7. Backpressure behavior (bounded subscriber queues)

### 7.1 What happens on overflow
When a subscriber cannot keep up and exceeds its bounded queue:
- the bus **disables/unsubscribes** that subscriber
- emits `bus.subscriber.disabled`
- increments `subscriber_disabled_backpressure_total{topic}`

### 7.2 How to avoid overflow
Given the bus is intended for low-frequency control messages, overflows should be rare. To reduce risk:
- keep handlers fast; offload heavy work to a separate queue/task
- use attribute filters and topic scoping to reduce fanout
- consider per-subscription `queueCapacity` tuning only if necessary

**Safety requirement:** If a subscriber is disabled and it gates hardware behavior, the owning service must enter a safe mode (e.g., treat as OFF/UNKNOWN).

---

## 8. Testing and shutdown determinism (`idle()` / `flush()`)

Because `publish()` is async, tests and clean shutdown may need to wait until the bus drains.

```ts
bus.publish({ /* ... */ });

// In tests / shutdown:
await bus.idle();
```

Recommended usage:
- Unit tests: publish → `await idle()` → assert side effects
- Graceful shutdown: stop accepting new work → `await idle()` → close process resources

---

## 9. Safety-critical allowlist usage

### 9.1 Configuration
Maintain a list of safety-critical topic patterns (engine-owned).

Example:
```ts
const safetyCriticalTopics = [
  "frontpanel.power.*",
  "device.relay.*",
  // ... add as needed ...
];
```

### 9.2 Strict schema expectations
For allowlisted topics, the implementation must:
- validate the payload (and schemaVersion) before delivery
- reject non-conforming messages
- emit telemetry + `bus.message.rejected`

**Important:** This strictness is a requirement. If schema validation is not implemented, the system is not meeting the safety-critical contract described here.

---

## 10. Recommended patterns for your current use case

### 10.1 Power gating for PS/2 services
- Consumers should subscribe to `frontpanel.power.changed` (or `frontpanel.power.*`).
- On payload state:
  - `on` → start/init sequences
  - `off`/`unknown` → **drop everything immediately** and stop sending

Because the bus is stateless, on service start/restart:
- consumers MUST read current power state from the authoritative state system (service/state controller), not the bus.

### 10.2 Coordination vs data plane
Use the bus for:
- mode changes, readiness signals, connect/disconnect, high-level commands

Do not use the bus for:
- continuous mouse deltas
- raw PS/2 byte streams
- frame-by-frame streaming telemetry

---

## 11. Troubleshooting checklist

- Topic validation errors?
  - Check for uppercase, underscores, empty segments, or invalid characters.
- Messages not received?
  - Confirm topic pattern match (`*` vs `**`)
  - Confirm attribute filters (exact match)
- Subscriber disabled?
  - Look for `bus.subscriber.disabled` events and backpressure metrics.
  - Ensure handler is not blocking / doing heavy work inline.
- Safety-critical message rejected?
  - Check `schemaVersion` and payload schema; see `bus.message.rejected` and `schema_rejected_total{topic}`.


## 13. Open items (explicitly not decided here)
These are out of scope for the bus, but must exist elsewhere for system correctness:
- Authoritative state location and access pattern (service-owned vs state controller)
- Arduino/serial handshake specifics (frontpanel contract)
- Exact power-state model and schema for `frontpanel.power.*` payloads
- Subscriber restart behavior beyond “read authoritative state on start”
- Schema validation library choice and versioning policy per module

---

## 14. Appendix: Rationale for key choices (summary)
- **Async + per-topic FIFO:** isolates publishers from subscriber latency while keeping determinism.
- **Fail-fast backpressure:** prevents silent degradation and memory growth; forces safe handling.
- **Safety-critical allowlist:** avoids over-constraining non-critical evolution while keeping critical paths strict.
- **Wildcards + attributes:** SNS-like ergonomics without introducing complex filter operators.
