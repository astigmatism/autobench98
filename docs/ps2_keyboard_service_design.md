# PS/2 Keyboard Simulator Service — Design Document

## 1. Purpose

This document defines the **design and behavioral contract** for the PS/2 Keyboard Simulator service within the Autobench98 Fastify application.

It is intended to:
- Serve as the **authoritative reference** for how the keyboard service should behave.
- Be readable and actionable by **both humans and AI models** implementing the service.
- Align strictly with existing Fastify architecture, SerialDiscoveryService behavior, and Arduino firmware constraints.
- Avoid implementation details except where required to define contracts and boundaries.

This document is the outcome of an explicit **analysis and discovery phase** and precedes any implementation work.

---

## 2. Scope and Non‑Goals

### In scope
- Keyboard command orchestration for a Windows 98 machine via an Arduino PS/2 keyboard emulator.
- Integration with Fastify using **service → adapter → AppState → WebSocket → pane** flow.
- Rich observability via structured state and logs.
- Explicit handling of interruption, retries, and failure semantics.

### Out of scope
- UI layout, styling, or UX decisions.
- HTTP or WebSocket protocol details (WebSockets are state-only).
- Modifying existing Arduino firmware.
- Mouse simulator implementation (only coordination boundaries are defined here).

---

## 3. Architectural Context

### 3.1 High-level architecture

```
┌──────────────┐
│ Orchestrator │
│  (Fastify)   │
└──────┬───────┘
       │
       ▼
┌──────────────────────────┐
│ PS2KeyboardService       │  ← owns serial port
│ (domain + queue + retry) │
└──────┬───────────────────┘
       │ emits domain events
       ▼
┌──────────────────────────┐
│ State Adapter            │
│ (pure mapping)           │
└──────┬───────────────────┘
       ▼
┌──────────────────────────┐
│ AppState (snapshot/patch)│
└──────┬───────────────────┘
       ▼
┌──────────────────────────┐
│ WebSocket (generic)      │
└──────┬───────────────────┘
       ▼
┌──────────────────────────┐
│ Pane (mirror store)      │
└──────────────────────────┘
```

Key constraints:
- Services **do not know about panes or WebSockets**.
- WebSockets are **state transport only**.
- All UI derives from mirrored AppState.
- Logs flow exclusively through the shared `clientBuf`.

---

## 4. Serial Discovery & Port Ownership

### 4.1 Discovery responsibility

- **SerialDiscoveryService** is the sole authority for:
  - Enumerating serial devices.
  - Performing token-based identification (`identify` / token / `identify_complete`).
  - Emitting lifecycle events (`device:identified`, `device:lost`).

### 4.2 Keyboard service responsibility

- The **PS2KeyboardService owns the live serial port**.
- Upon `onDeviceIdentified({ id, path, baudRate })`:
  - The service opens the serial port itself.
  - The service manages reconnects, retries, and teardown.
- Upon `onDeviceLost({ id })`:
  - The service closes the port and transitions to a non-ready state.

This mirrors the established **AtlonaControllerService** pattern.

---

## 5. Device Protocol (Arduino Keyboard Firmware)

### 5.1 Serial protocol (host → Arduino)

Commands are newline-delimited ASCII strings:

- `identify`
- `identify_complete`
- `power_on`
- `power_off`
- `press <prefix>:<scancode>`
- `hold <prefix>:<scancode>`
- `release <prefix>:<scancode>`

### 5.2 Serial output (Arduino → host)

- `success:` lines indicate successful command execution.
- `debug:` lines are telemetry only.
- No structured negative acknowledgment exists.

### 5.3 PS/2 behavior

- Arduino emulates a PS/2 keyboard (scan code set behavior handled internally).
- Readiness is implicit; there is **no explicit “ready” signal** beyond identification and power.

---

## 6. Power Coordination Contract

- The keyboard Arduino drives **PIN 5 (POWER_STATUS_PIN)** as OUTPUT.
- The mouse Arduino reads **PIN 5** as INPUT.
- `power_on` → PIN HIGH
- `power_off` → PIN LOW

### Contract:
- **Power coordination is hardware-only.**
- No software-level keyboard ↔ mouse signaling is required.
- The keyboard service is responsible for issuing `power_on` / `power_off`.

Power commands are **fire-and-forget side effects**; orchestration timing is handled externally.

---

## 7. Service API Surface (Authoritative)

The keyboard service exposes a **full ergonomic command vocabulary**.

### 7.1 Low-level primitives
- `press(key | scancode)`
- `hold(key | scancode)`
- `release(key | scancode)`

### 7.2 High-level operations
- `type(text, options?)`
- `combo(modifiers, key, options?)`
- `macro(sequence, options?)`
- `releaseAll()`

### 7.3 Power control
- `powerOn()`
- `powerOff()`

### 7.4 Timing controls
All timing parameters:
- Inter-command delay
- Press duration
- Hold duration
- Per-operation speed factor

Defaults are defined via **environment variables**, with **per-call overrides** allowed.

---

## 8. Execution Model

### 8.1 Queueing
- Commands are executed sequentially.
- Only **one low-level command is in-flight** at any time.
- High-level operations expand into ordered low-level sequences.

### 8.2 Operation model (hybrid semantics)
- Every operation produces an **Operation Handle**:
  - `operationId`
  - `queued | running | completed | failed | cancelled`
- Callers may:
  - await completion
  - or fire-and-forget
- Progress and completion are emitted as events.

---

## 9. Interruption & Cancellation

### 9.1 Hard cancel (required)
- Immediately aborts:
  - in-flight command
  - queued commands
- Service attempts to:
  - release held modifiers
  - return keyboard to a safe state

Used when benchmarking or orchestration is stopped mid-run.

---

## 10. Reliability & Retry Semantics

### 10.1 Hybrid retry model
- If device is disconnected:
  - Service waits for reconnect and re-identification.
  - Retries internally up to **bounded attempts/time**.
- Pending commands remain queued unless hard-cancelled.
- On exhaustion:
  - Operation fails
  - Escalation is reported via state and logs.

### 10.2 Failure definition
An operation fails if:
- Serial write fails
- Ack (`success:`) times out
- Device disconnects mid-execution
- Hard cancel is invoked

High-level operations **fail immediately** on partial execution; partial success is never reported as success.

---

## 11. Observability & State Model

### 11.1 Rich state (required)

The keyboard slice of AppState must include:
- Connection / identification status
- Power state
- Busy / idle
- Queue depth
- Current operation summary
- Operation status
- Last error

Optional extensions:
- Operation history (bounded)
- Progress counters

### 11.2 Logs
Logs include:
- Raw serial lines
- Debug telemetry
- Retry attempts
- Interrupts and failures

Logs are **never parsed** by UI logic.

---

## 12. Pane Contract

## 12.1 Frontend keyboard test input (pane requirement)

The frontend must support **interactive keyboard testing** so a user can send real-time keystrokes to the PS/2 keyboard service.

### Goals
- Allow the user to **focus** an interactive region (typically by clicking the video/streaming pane or a dedicated “Keyboard Capture” control).
- While focused, the pane captures browser keyboard events and forwards them to the orchestrator as **keyboard operations** (low-level `press/hold/release` or higher-level helpers).
- Provide visual feedback in the pane (derived from AppState) showing:
  - capture focus state (armed/disarmed)
  - keyboard service readiness (connected/identified)
  - queue depth / busy
  - last error (if any)

### Architectural constraint
Service → pane communication remains **state-only over WebSockets**.

To support pane → service control for testing, the application must expose a **command ingress** that the pane can call (e.g., an HTTP API route or a dedicated command channel distinct from the state WebSocket). The pane must never write directly to serial.

### Event mapping (design-level)
- The pane captures keydown/keyup and maps them into the keyboard service’s accepted representation:
  - preferred: standardized `KeyboardEvent.code` (e.g., `KeyA`, `Enter`, `Escape`)
  - fallback: character mapping for typed text when appropriate
- Modifiers (Shift/Ctrl/Alt/Meta) must be represented as **hold/release** around the target key when the service API requires explicit modifier control.

### Safety and usability
- Include an explicit toggle (“Capture Keyboard Input”) and an escape hatch (e.g., `Esc` to release capture) to avoid trapping user input.
- On capture disable, the pane should request `releaseAll()` (or equivalent) so the emulated keyboard returns to a safe state.


- Panes read from `mirror.data.keyboard`.
- No pane communicates directly with the service or socket.
- Pane may choose what to display, but **state must expose full visibility**.

---

## 13. Explicit Non-Assumptions

The design intentionally does **not** assume:
- A keyboard “ready” signal beyond identification.
- Software-based keyboard↔mouse power coordination.
- Unlimited retries or infinite queues.
- That UI will necessarily display all available state.

---

## 14. Summary

This design prioritizes:
- Deterministic orchestration
- Maximum visibility
- Strict separation of concerns
- Consistency with existing Fastify + SerialDiscovery patterns
- Fidelity to real hardware behavior

It is intended to be implemented **as-is**, without inference or embellishment.
