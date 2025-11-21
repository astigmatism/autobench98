# Serial Printer Service Design Overview

## Purpose
Design goals and strategy for building a robust Serial Printer Service within the AutoBench98 orchestrator. This document provides a structured foundation for future development discussions and AI-assisted sessions, capturing all architectural reasoning and failure-mode considerations.

---

# 1. Role of the Serial Printer Service

The Serial Printer Service (SPS) is responsible for:

- Establishing and maintaining a connection to a serial-to-USB printer device.
- Reading streamed print data from Windows 98 test machines.
- Buffering and completing print jobs using timing-based job-boundary detection.
- Handling device loss, reconnection attempts, and fatal service errors.
- Providing job lifecycle events to the orchestrator via an internal event bus.
- Exposing useful APIs such as retrieving completed jobs, clearing state, etc.
- Optionally providing WebSocket-based UI updates (stubbed for future work).

The SPS is a **stateful, long-lived service** that must operate reliably during benchmark runs.

---

# 2. Failure Modes & Recovery Strategy

The service must classify failures into three types:

## 2.1 Recoverable Errors (Transient)
Examples:
- Brief cable disconnect.
- USB hub resets.
- Temporary I/O hiccups.

Behavior:
- SPS transitions to `online = false`.
- Attempts periodic reconnection to the same device path.
- Raises internal `state` events indicating reconnection attempts.
- Upon success, emits `state(online = true)` and resumes normal operation.

Main loop impact:
- Benchmark pass containing a failed print is invalid; the next pass may be retried.

---

## 2.2 Job-Level Failures (Non-fatal for service)
Examples:
- Data truncated due to disconnect.
- Data corrupted.
- Max job size exceeded.
- Printer resets unexpectedly.

Behavior:
- The job is marked `failed`, including reason (`io-error`, `device-lost`, `max-job-size`, etc.).
- Partial job is discarded.
- SPS attempts recovery and continues listening.

Main loop impact:
- Benchmark pass must be repeated.
- SPS continues operating.

---

## 2.3 Fatal Service Errors
Examples:
- Device cannot be opened after N retries or T seconds.
- Persistent permission issues.
- Hardware failure or unsupported behavior.
- Critical internal invariant violation.

Behavior:
- SPS emits a `fatal` event via the event bus.
- SPS transitions to `online = false`.
- Orchestrator stops the benchmark loop immediately.

Main loop impact:
- Entire application loop must stop.

---

# 3. Job Lifecycle Handling

Windows 98 print jobs typically arrive as **raw serial streams**, not framed with clear job delimiters. SPS uses a **silence timeout** strategy:

1. On first byte received → start new job buffer.
2. Append chunks to buffer as data arrives.
3. If no bytes arrive for `X ms` → treat as end of job.
4. Emit job event:
   - `job-complete` (normal)
   - `job-failed` (if device lost mid-job)
   - `job-truncated` (max size reached)

This model matches how legacy serial printers behave.

---

# 4. Service API (Conceptual)

SPS internal API surface:

```ts
start(): Promise<void>
stop(): Promise<void>

getJob(): PrintJob | null
getAllJobs(): PrintJob[]
clearJobs(): void

on(event: 'state', handler)
on(event: 'job-complete', handler)
on(event: 'job-failed', handler)
on(event: 'fatal', handler)
```

Jobs have metadata:

```ts
{
  id: string
  startedAt: number
  completedAt?: number
  data: string
  status: 'complete' | 'failed' | 'truncated'
  reason?: string // for failed/truncated jobs
}
```

---

# 5. Event Bus Integration

The orchestrator integrates SPS via an **internal event bus**, not external WebSockets. SPS emits:

### 5.1 Service State Events
```ts
{
  online: boolean
  reason?: string            // 'device-lost', 'open-failed', 'reconnecting', etc.
  attempt?: number
  maxAttempts?: number
}
```

### 5.2 Job Events
- `job-start`
- `job-chunk` (optional)
- `job-complete`
- `job-failed`

These inform the benchmark loop of job validity.

### 5.3 Fatal Event
```ts
fatal(new Error("serial-printer: device unreachable"))
```

Main loop reacts by halting further runs.

---

# 6. Reconnection Logic

Reconnection steps:

1. Device disconnects or port errors.
2. SPS closes the port.
3. SPS retries opening the *same* path:
   - Retry period: configurable (e.g., 2 seconds)
   - Max retries or max time window
4. If reconnected:
   - SPS signals success (`online: true`)
5. If not reconnected after policy:
   - SPS emits `fatal`.

Edge behavior: if a job was in-flight during disconnect, job is marked failed.

---

# 7. Memory & Queue Safety Controls

To avoid runaway memory usage:

- `maxJobBytes`: Cap per-job size.
- `maxJobs`: Cap in-memory history buffer.
- If limits exceeded:
  - Truncate job or drop oldest jobs.
  - Emit warnings / job failure events.

---

# 8. Optional WebSocket Streaming

Stub for future support:

- SPS emits `job-chunk` events internally.
- A UI module can forward these via WebSockets.
- Potential UI features:
  - Real-time print stream viewer
  - Spool history table
  - Printer online/offline indicators

This is optional and not required for initial implementation.

---

# 9. Summary of Responsibilities

### SPS Responsibilities
- Opening & maintaining serial connection
- Data buffering, framing, and job completion
- Reconnection attempts and error classification
- Emitting job/state/fatal events
- Enforcing memory & safety limits

### Main Loop Responsibilities
- Interpreting job-complete/job-failed for benchmark scoring
- Retrying benchmarking passes on job failure
- Halting process on fatal SPS errors
- Potentially displaying UI status via WebSockets

---

# 10. Next Steps

When ready, we can:

1. Create `services/orchestrator/src/core/devices/serial-printer/SerialPrinterService.ts`
2. Implement event bus wiring
3. Hook SPS into startup (after serial discovery confirms device)
4. Define main loop reactions to SPS events
5. Add optional WebSocket reflection later

---

This document now serves as the **canonical design reference** for the Serial Printer Service and will allow future AI sessions or engineers to quickly understand the architectural intent and reliability model.
