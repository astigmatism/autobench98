# PS/2 Mouse Simulator — Design Document (v0.3)

**Project:** AutoBench98 / AutoBench98 2.0  
**Document:** PS/2 Mouse Simulator Design Spec  
**Version:** v0.3 (implementation-ready requirements + integration notes)  
**Generated:** 2026-02-10 18:04:04 America/Los_Angeles (2026-02-10 18:04:04 UTC)  
**Mode:** Verification-First / Safety-Critical  

---

## 0. What this document is for

This is a **single-source design specification** for building a PS/2 mouse simulator that matches the architecture and conventions of the **existing working PS/2 keyboard simulator** in this repo.

It is written so that another engineer (or another AI agent) can:

- understand the full end-to-end system (Vue → WS → orchestrator → serial → Arduino → PS/2 → Win98)
- implement the mouse feature with minimal ambiguity
- validate behavior via AppState and logging (verification-first)

---

## 1. System context (how AutoBench98 is structured)

This section summarizes the project conventions that the PS/2 mouse simulator must conform to. These come from the repo’s design guides and refactor plans you shared (state + WS + pane integration), and from the existing PS/2 keyboard feature (service/plugin/adapter pattern).

### 1.1 Orchestrator patterns (backend)

**Orchestrator is a Fastify-based server** with a global AppState and a WebSocket contract that ships:

1) a **snapshot** of AppState to new clients  
2) subsequent **JSON patch diffs** (versioned) to keep clients in sync

Key implications for the mouse feature:

- Mouse service must **not** mutate AppState directly.
- Mouse plugin uses an adapter that maps domain events to a bounded **mouse AppState slice**.
- The adapter updates the global state via an `updatePS2MouseSnapshot(...)` helper, mirroring the keyboard pattern (`updatePS2KeyboardSnapshot`).

### 1.2 Client + pane patterns (frontend)

The web client renders panes and keeps state synchronized through WS snapshot/diff.

Key implications for mouse control:

- The stream pane provides a **bounded div** that visually represents the Win98 desktop, possibly scaled.
- Mouse input is collected relative to that div and transmitted to the orchestrator as **high-level intents** (absolute normalized position, relative delta, button actions, wheel).

### 1.3 Logging patterns

Logging is “channelized” via `@autobench98/logging`:

- every subsystem logs to a specific `LogChannel`
- logs can be streamed to a UI via a shared `ClientLogBuffer`

Key implication for mouse:

- Mouse must have its own `LogChannel.mouse` (added as a prerequisite change).

---

## 2. Reference implementation: PS/2 keyboard simulator pattern

You provided complete orchestrator code for the keyboard feature. The mouse feature MUST mirror its structure and operational semantics.

### 2.1 Keyboard feature files (reference)

- `services/orchestrator/src/devices/ps2-keyboard/PS2KeyboardService.ts`
- `services/orchestrator/src/devices/ps2-keyboard/types.ts`
- `services/orchestrator/src/devices/ps2-keyboard/utils.ts`
- `services/orchestrator/src/devices/ps2-keyboard/scancodes.ts`
- `services/orchestrator/src/plugins/ps2Keyboard.ts`
- `services/orchestrator/src/adapters/ps2Keyboard.adapter.ts`

### 2.2 Keyboard semantics to copy (key points)

**Service owns:**
- SerialPort open/close
- discovery-driven lifecycle (`onDeviceIdentified`, `onDeviceLost`)
- identify handshake (`identify` → token → `identify_complete`)
- reconnect policy
- operation queue + cancellation
- domain events to sinks

**Plugin owns:**
- config building from env
- logger sink + state adapter sink (fanout)
- `subscribeSlice('frontPanel', …, emitInitial: true)` and sets host power on service

**Adapter owns:**
- mapping events → AppState slice
- bounded histories + derived busy/queueDepth/currentOp

### 2.3 Host power policy (must be identical for mouse)

Keyboard implements:

- `hostPower='unknown'` ⇒ **fail-open** (do not block ops)
- `hostPower='off'` ⇒ cancel queued key ops + best-effort cancel active key op

Mouse must follow the same policy, with the same “exact literal” mapping rule for safety:

- only exact `'on'` and `'off'` are treated as known values
- everything else maps to `'unknown'`

---

## 3. Mouse feature goals and non-goals

### 3.1 Goals (MUST)

1) Provide **full mouse control** equivalent to a physical PS/2 mouse in Win98:
   - movement
   - button down/held
   - button release
   - click (as a convenience op)
   - wheel vertical scrolling (when negotiated)
2) Provide **multiple movement modes** (adaptive control):
   - absolute mapping (div → desktop)
   - relative gain (2× / 5× / 10× / 20×, plus arbitrary values)
   - relative acceleration (speed-sensitive gain)
3) Maintain verification-first observability:
   - protocol mode (standard vs IntelliMouse)
   - reporting enabled/disabled
   - last host command
   - last device ID response
4) Drop/cancel behavior on host power off (same semantics as keyboard).

### 3.2 Non-goals (v1) (MUST NOT / NOT REQUIRED)

- MUST NOT use Pointer Lock API in v1.
- MUST NOT auto-home or auto-resync cursor position on host power transitions.
- NOT REQUIRED to surface “wheel unavailable” as an error if Win98 never negotiates IntelliMouse mode.
- NOT REQUIRED to support horizontal wheel (wheel is vertical-only in this design).

---

## 4. End-to-end data flow

### 4.1 Flow overview

1) Browser user interacts inside the stream pane’s **desktop div**  
2) Vue emits WS events:
   - movement (absolute normalized or relative delta)
   - button down/up/click
   - wheel (vertical)
   - runtime mode/config changes
3) Orchestrator WS plugin forwards these to PS2MouseService API
4) Service aggregates movement into a ticked flush and queues discrete ops
5) Service writes serial commands to Arduino
6) Arduino emits PS/2 packets to the Win98 host
7) Host sends PS/2 commands back (enable reporting, sample rate, get ID, etc.)
8) Arduino prints telemetry back over serial
9) Service parses telemetry and emits domain events
10) Plugin fanout:
    - logs to LogChannel.mouse
    - adapter updates AppState mouse slice (snapshot + diffs to clients)

---

## 5. Component layout for PS/2 mouse (backend)

### 5.1 Files (MUST)

Create a device module that mirrors the keyboard structure:

- `services/orchestrator/src/devices/ps2-mouse/PS2MouseService.ts`
- `services/orchestrator/src/devices/ps2-mouse/types.ts`
- `services/orchestrator/src/devices/ps2-mouse/utils.ts`
- `services/orchestrator/src/plugins/ps2Mouse.ts`
- `services/orchestrator/src/adapters/ps2Mouse.adapter.ts`

Optional:
- `services/orchestrator/src/devices/ps2-mouse/protocol.ts` (host-command decode table)

### 5.2 Responsibilities

**PS2MouseService (MUST):**
- Own SerialPort and identify handshake
- Implement movement aggregation + tick flush
- Implement discrete operation queue (buttons, config changes)
- Implement cancellation and host-power gating
- Parse firmware telemetry lines → domain events
- Provide public API for movement/buttons/wheel/config

**ps2Mouse plugin (MUST):**
- Build config from env
- Create and wire event sinks (logger + state adapter)
- Expose `app.ps2Mouse` via `decorate`
- Subscribe to `frontPanel` slice for hostPower and call `ps2Mouse.setHostPower(...)` (emitInitial: true)
- Start/stop lifecycle hooks

**PS2Mouse adapter (MUST):**
- Keep bounded histories
- Maintain derived state (`busy`, `queueDepth`, `currentOp`)
- Store protocol state fields and last activity timestamps

---

## 6. Host power integration (critical, safety)

### 6.1 Source of host power

Host power comes from AppState `frontPanel.powerSense` (same as keyboard).

Mapping rules (MUST):
- if `powerSense === 'on'` → hostPower = 'on'
- if `powerSense === 'off'` → hostPower = 'off'
- else → hostPower = 'unknown'

### 6.2 Policy (MUST match keyboard semantics)

- hostPower='unknown' → fail-open; service does not block movement/ops
- hostPower='off' → service must:
  - cancel queued discrete ops
  - best-effort cancel an active discrete op
  - clear movement accumulators and absolute targets
  - stop sending any movement/wheel serial commands while power is off

Rationale (captured requirement): sending input to a powered-off machine is useless and adds noise.

---

## 7. Frontend → backend control contract (WebSocket payload spec)

These are payload “shapes” the backend must accept. Names can be adapted to your existing WS routing conventions,
but the semantic fields must be present.

### 7.1 Movement

#### Absolute mapped
Absolute uses normalized coordinates in [0..1] in the **stream div** coordinate space:

```ts
type ClientMouseMoveAbsolute = {
  kind: 'mouse.move.absolute'
  xNorm: number  // 0..1 within div (clamped)
  yNorm: number  // 0..1 within div (clamped)
  requestedBy?: string
}
```

#### Relative (raw deltas)
Relative uses deltas (UI event units, typically CSS pixels):

```ts
type ClientMouseMoveRelative = {
  kind: 'mouse.move.relative'
  dx: number
  dy: number
  requestedBy?: string
}
```

### 7.2 Buttons

```ts
type MouseButton = 'left' | 'right' | 'middle'

type ClientMouseButton =
  | { kind: 'mouse.button.down';  button: MouseButton; requestedBy?: string }
  | { kind: 'mouse.button.up';    button: MouseButton; requestedBy?: string }
  | { kind: 'mouse.button.click'; button: MouseButton; requestedBy?: string; holdMs?: number }
```

**Idempotency requirement (explicit):**
- duplicate DOWN while already down → no-op + log
- duplicate UP while already up → no-op + log

### 7.3 Wheel (vertical only)

```ts
type ClientMouseWheel = {
  kind: 'mouse.wheel'
  dy: number
  requestedBy?: string
}
```

### 7.4 Mode and configuration updates

```ts
type MouseMoveMode = 'absolute' | 'relative-gain' | 'relative-accel'

type ClientMouseConfig = {
  kind: 'mouse.config'
  mode?: MouseMoveMode
  gain?: number // used in relative-gain
  accel?: {
    enabled: boolean
    baseGain?: number
    maxGain?: number
    velocityPxPerSecForMax?: number
  }
  absoluteGrid?: {
    mode: 'auto' | 'fixed'
    fixed?: { w: 640|1024; h: 480|768 }
  }
}
```

Config updates are **discrete** operations (queued) and must be cancellable by host power off.

---

## 8. Mouse movement design (multiple modes)

### 8.1 Core insight: do not queue per mousemove

Mousemove frequency can be extremely high. The service MUST NOT enqueue one op per event.

Movement must be implemented as:

- input updates a “desired movement state”
- a fixed tick flush (default 60 Hz) emits serial commands at a bounded rate
- movement is coalesced and stepped to respect firmware / protocol caps

### 8.2 Virtual cursor model (fits the current firmware)

Your current firmware consumes `MOVE x,y` absolute positions and computes deltas internally.

To support relative modes without changing wire grammar, the service maintains a **virtual cursor position**:

- internal position: `(x,y)` in an orchestrator-defined virtual grid
- for absolute mode: `(x,y)` approaches a target computed from xNorm/yNorm
- for relative modes: `(x,y)` increments by processed deltas

Service sends `MOVE x,y` over serial.

### 8.3 Tick rate (default)

- Default movement flush tick: **60 Hz**
- Must be configurable via env for tuning.

### 8.4 Per-tick cap and stepping

Firmware clamps deltas to ±255. The service must behave correctly under large moves by stepping:

- each tick, compute `dx = clamp(targetX - x, -255, 255)` and same for y
- update `(x,y)` by that step
- send `MOVE x,y`
- repeat on next tick until target reached

For relative modes, carry remainder across ticks.

### 8.5 Mode: Absolute mapped

- Input is `xNorm,yNorm ∈ [0..1]`
- Service clamps to [0..1]
- Service resolves virtual grid (section 9)
- Target:
  - `targetX = round(xNorm * (W-1))`
  - `targetY = round(yNorm * (H-1))`
- Tick steps `(x,y)` toward `(targetX,targetY)`

### 8.6 Mode: Relative gain

- Input is `dx,dy`
- Apply gain multiplier `g`
- Supported presets MUST include: **2, 5, 10, 20**
- Accumulate:
  - `accDx += dx * g`
  - `accDy += dy * g`
- Each tick consumes up to ±255 per axis from accumulators, carries remainder

### 8.7 Mode: Relative acceleration

- Input is `dx,dy`
- Compute speed from event timing (service timestamps)
- Gain increases with speed, bounded by config:
  - baseGain
  - maxGain
  - velocityPxPerSecForMax

Implementation detail is intentionally not fixed yet; it must be configurable and bounded.

---

## 9. Coordinate grid and resolution support (640×480 and 1024×768)

### 9.1 Requirements

- Win98 can be 640×480 before video drivers, 1024×768 typically.
- Host does not report resolution directly through PS/2 mouse protocol.
- System must support both.

### 9.2 Grid resolution strategy

Two supported strategies (MUST):

1) **Fixed grid**: user selects 640×480 or 1024×768.
2) **Auto grid**: derive from stream/capture “native resolution” if available in AppState.

If auto grid cannot determine a resolution and fixed grid is not set:
- service should still run, but absolute mapping is degraded.
- state must expose `mappingStatus='unknown-resolution'` and log a single high-signal warning.

### 9.3 AppState fields for mapping

Mouse slice must include:

- `absoluteGrid.mode: 'auto'|'fixed'`
- `absoluteGrid.fixed?: {w,h}`
- `absoluteGrid.resolved?: {w,h}`
- `mappingStatus: 'ok'|'unknown-resolution'`

---

## 10. Bounds and clamping behavior

While stream input lock is active:

- Absolute mode: clamp xNorm,yNorm to [0..1]
- Relative modes: clamp `(x,y)` within `[0..W-1]×[0..H-1]`
- No pointer lock in v1.

---

## 11. Buttons and dragging (down / up / click)

### 11.1 Supported buttons

- left
- right
- middle

### 11.2 Semantics (MUST)

- down/held: represent “button is pressed” (dragging must work)
- up/release: represent “button released”
- click: convenience (down then up), optionally with holdMs delay

### 11.3 Idempotency (MUST)

- DOWN on an already-down button → no-op + log
- UP on an already-up button → no-op + log

The service must maintain `buttonsDown` state, and also reset it on reconnect (section 13).

---

## 12. Wheel (vertical only) and IntelliMouse support

### 12.1 Wheel scope

- vertical wheel only (no horizontal wheel)

### 12.2 IntelliMouse requirement

Your stated expectation: Win98 should support IntelliMouse “out of the box.”

Therefore the firmware MUST implement IntelliMouse negotiation so wheel packets can be used when the host negotiates it.

If the host never negotiates IntelliMouse mode:
- no special surfacing is required (as you decided)
- wheel events may have no effect; that is acceptable for v1.

---

## 13. Lifecycle, reconnect, and reset behavior

### 13.1 Reconnect behavior

On serial disconnect/reconnect:
- identify handshake runs again
- treat as a fresh session
- reset:
  - buttonsDown → all false
  - movement accumulators/targets → cleared
  - reporting/mode → unknown until host re-inits
  - lastHostCommand cleared (optional) or retained with a “session reset” marker event

### 13.2 Queue retention

Movement is not queued (tick flush), so it never “retains.”

Discrete ops (buttons/config) should default to **not retaining** across reconnect for safety, unless you explicitly need otherwise.

---

## 14. Multi-client policy (arbitration)

v1 policy: **last-writer-wins**.

- multiple clients can send commands
- service applies commands in arrival order
- no explicit ownership lock is required for v1

---

## 15. Observability: events, AppState, and logs

### 15.1 Mouse domain events (service → sinks)

Mouse service must emit events similar in richness to keyboard, including:

- device identified/connected/disconnected/lost
- identify start/success/failure
- hostPower changed (applied)
- movement tick flush (rate-limited log)
- button actions (high-signal log)
- wheel actions (rate-limited log)
- protocol transitions:
  - reporting enabled/disabled
  - standard vs intellimouse mode
  - device ID value (0x00 vs 0x03)
- firmware debug line received (for logs)
- recoverable-error / fatal-error
- discrete op lifecycle: queued/started/completed/cancelled/failed

### 15.2 Mouse AppState slice (spec)

The adapter must maintain a mouse slice with at least:

- lifecycle: phase, identified, deviceId/devicePath/baudRate
- host power: hostPower
- queue: busy, queueDepth, currentOp, operationHistory (bounded)
- errors: lastError, errorHistory (bounded)
- movement config + mapping status:
  - mode, gain, accel
  - absoluteGrid.mode/fixed/resolved
  - mappingStatus
- buttons:
  - buttonsDown: {left,right,middle}
- protocol state (verification-first):
  - reporting: unknown|enabled|disabled
  - protocolMode: unknown|standard|intellimouse
  - lastHostCommand: {at, byte, name?}
  - lastDeviceId: {at, id}
- timestamps:
  - updatedAt
  - lastMoveAt, lastWheelAt, lastButtonAt

### 15.3 Logging channel

Mouse feature must log through a dedicated `LogChannel.mouse`.
Movement logs must be rate-limited or suppressed by default to prevent flooding.

---

## 16. Firmware requirements (based on your current sketch + v1 goals)

### 16.1 Current sketch capabilities (baseline recap)

Your current sketch:

- identifies as `MS`
- gates behavior on power sense pin
- supports `MOVE x,y` and computes deltas vs last pos
- clamps deltas to ±255
- supports buttons 0..2 via CLICK/RELEASE
- tracks `isReporting` via host commands (0xF4/0xF5)
- returns standard mouse ID (0x00)

### 16.2 Required firmware enhancements for wheel (IntelliMouse)

To meet the IntelliMouse expectation, firmware MUST:

- handle Set Sample Rate (0xF3) and detect the magic sequence **200, 100, 80**
- after that sequence, respond to Get Device ID (0xF2) with **0x03**
- switch to 4-byte packet format and include wheel delta byte
- continue to support standard 3-byte format when not in IntelliMouse mode

### 16.3 Parseable telemetry requirement (verification-first)

Firmware must emit **machine-parseable** telemetry lines for:

- host command received (byte + decoded name)
- reporting enabled/disabled state transitions
- sample rate values
- mode transitions (standard/intellimouse)
- device ID reported

Exact string format is flexible, but it must be stable and structured enough for parsing.

---

## 17. Acceptance criteria (end-to-end test plan)

### 17.1 Movement

- Absolute mode: moving within stream div reaches all corners of the desktop.
- Relative gain: gain presets 2/5/10/20 produce visible sensitivity differences.
- Relative acceleration: slow movement is precise; fast movement traverses distance quickly, bounded by maxGain.
- No serial spam when host power is off.

### 17.2 Buttons

- Down/move/up performs drag operations correctly.
- Duplicate down/up events do not break state (no-op + log).

### 17.3 Wheel

- If host negotiates IntelliMouse: wheel scroll works in Win98 UI.
- If host does not: no error; wheel may be inert.

### 17.4 Reconnect

- After reconnect: no stuck buttons, movement accumulators cleared, protocol states reset to unknown until host init.

---

## 18. Deferred items

- Pointer lock API integration (explicitly deferred)
- Fine-tuning default acceleration curve (requires empirical tuning)
- Manual “resync” UX (not automatic homing)

---

## 19. Implementation checklist (for the implementing agent)

**Backend**
- [ ] Create ps2-mouse device module mirroring ps2-keyboard structure
- [ ] Build config-from-env helpers like keyboard
- [ ] Implement identify handshake (identify → MS → identify_complete)
- [ ] Implement discrete op queue with cancellation
- [ ] Implement movement aggregator + 60 Hz tick with stepping and caps
- [ ] Implement host power integration via frontPanel subscribeSlice (emitInitial)
- [ ] Implement adapter updating AppState slice and bounded histories
- [ ] Create logger sink using new LogChannel.mouse with firmware-line enrichment

**Firmware**
- [ ] IntelliMouse negotiation (F3 sequence, ID=0x03)
- [ ] 4-byte packets with wheel delta
- [ ] Structured telemetry lines

**Frontend**
- [ ] Emit WS messages for move/buttons/wheel/config
- [ ] Respect existing stream input lock behavior
- [ ] Clamp absolute coords within div bounds before send (optional; service must also clamp)

---
