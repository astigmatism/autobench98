# AutoBench98 2.0 — Google Sheets Result Sink (Worker‑Threaded) Design

**Document purpose:** Specify a fresh, explicit design for integrating Google Sheets as a “data store” / publishing sink for Win98 benchmark results in the Fastify orchestrator—without committing to the exact behavior of the previous implementation (used only as reference).  
**Core requirement:** *All Google Sheets API I/O happens in worker threads*, with configurable thread counts and an explicit **blocking (“barrier”) mode** that forces the orchestration flow to wait for a Sheets operation to complete.

---

## 1) Context from the existing AutoBench98 architecture

### 1.1 Orchestrator is already designed for pluggable “result sinks”
The refactor plan calls out a **pluggable ResultSink interface** and lists `sheets` as the primary sink.

### 1.2 Worker threads are an accepted pattern in this codebase
The plan already embraces worker pools for OCR/screen matching with backpressure and bounded queues. This design mirrors those concurrency principles for Sheets.

### 1.3 State + WS + logs patterns exist and should be used
The WebSocket + AppState pattern is: **snapshot then RFC6902 patches**, and adding a new subsystem means adding a new AppState slice + adapter.  
Logging uses a shared buffer so subsystem logs appear in the UI; avoid creating isolated buffers.

### 1.4 “Old integration” reference points (not a target)
Your prior Google Sheets system:
- Offloaded all Sheets work to worker threads.
- Used multiple worker pools with different concurrency goals (serialized vs parallel).
- Had practical env pitfalls like private key newlines.

This design takes the *intent* (threading + resilience) but redesigns the workbook schema and operation model.

---

## 2) Goals and non-goals

### Goals
1. **Worker-thread-only Sheets I/O:** The main Fastify thread never calls Google APIs.
2. **Configurable concurrency:** Background worker count + blocking worker count are configurable.
3. **Blocking “barrier mode”:** The orchestrator can *wait* for a Sheets worker result before progressing the workflow (without freezing HTTP/WS).
4. **Operational resilience:** Retries, backoff, clear failure reporting, and reconciliation on restart.
5. **Idempotent publishing:** A job/run published twice should not duplicate rows silently.
6. **UI visibility:** Sheets sink health/queue/publish status visible via AppState + logs.

### Non-goals (v1)
- Full spreadsheet CRUD UI.
- Real-time collaborative editing controls or multi-orchestrator distributed locks (beyond a single orchestrator instance).
- Mirroring every computed formula behavior from older workbook templates.

---

## 3) Proposed architecture overview

### 3.1 Components
**Main thread (Fastify / Orchestrator):**
- `SinkManager`: owns enabled sinks and routes `publish(...)` calls.
- `SheetsSink`: transforms internal results into a single “publish envelope” and submits it to a worker pool.
- `SheetsWorkerPool`: manages worker threads, queues, backpressure, and the “blocking barrier” mode.
- `SheetsStateAdapter`: updates AppState slice from sink/worker events.

**Worker threads (Google Sheets I/O):**
- `SheetsWorkerRuntime`: initializes auth client once, caches sheet IDs, validates schema.
- `SheetsPublisher`: implements `publishRunEnvelope(envelope)` with idempotent upsert logic and batched updates.

### 3.2 Data flow (end of a benchmark run)
1. Job completes → orchestrator assembles `RunEnvelope` (run metadata + metrics + artifacts).
2. `SinkManager` calls `SheetsSink.publish(envelope, mode)`.
3. `SheetsSink` enqueues a worker task:
   - `mode="blocking"` → orchestration flow awaits publish receipt.
   - `mode="background"` → orchestration continues; sink updates status asynchronously.
4. Worker does:
   - schema check (fast path cached),
   - idempotent upsert,
   - batched writes,
   - returns `PublishReceipt` (sheet row/range refs + timestamp + status).
5. Main thread records:
   - event store entry (optional but recommended),
   - AppState update,
   - logs + UI notifications.

**Important clarification about “blocking”:**  
“Blocking” here means *the job/workflow waits for the Sheets worker result*—it does **not** mean freezing the Node event loop. HTTP/WS keep working.

---

## 4) Workbook design (fresh take): normalized “data store” tabs + optional dashboards

Template-driven, formula-copy sheets are powerful, but often fragile and difficult to evolve. For a “data store” posture, a normalized schema is simpler, more durable, and easier to version.

### 4.1 Required tabs (v1)
1. **`Runs`** (1 row per run/job)
2. **`Metrics`** (N rows per run; long-form)
3. **`Artifacts`** (N rows per run; long-form)
4. **`Devices`** (optional v1; recommended v2)

### 4.2 `Runs` columns (header row = row 1)
Minimum recommended columns:

- `run_id` (string, stable, unique)
- `job_id` (string)
- `recipe_id` (string)
- `recipe_version` (string | hash)
- `started_at` (ISO string)
- `finished_at` (ISO string)
- `duration_ms` (number)
- `status` (`success` | `failed` | `aborted`)
- `device_id` (string)
- `operator_note` (string)
- `orchestrator_build` (string)
- `published_at` (ISO string)
- `publish_status` (`published` | `failed` | `pending`)
- `publish_error` (string; last error summary)

### 4.3 `Metrics` columns
- `run_id`
- `benchmark_id` (or recipe step id)
- `metric_key` (e.g., `fps`, `score_overall`)
- `metric_name` (human)
- `value` (number or string)
- `unit`
- `lower_is_better` (boolean)
- `format` (e.g., `0.00`)
- `source` (`ocr` | `parsed` | `computed`)
- `captured_at` (ISO string)

### 4.4 `Artifacts` columns
- `run_id`
- `artifact_type` (`screenshot` | `video` | `log` | `raw_result`)
- `path` (container path or URL if you later expose artifacts)
- `sha256` (optional)
- `created_at` (ISO string)

### 4.5 Optional: dashboards and pivots
Add a `Dashboard` or `Summary` tab that uses pivots/QUERY formulas on `Metrics`. This preserves spreadsheet usability without requiring the orchestrator to manage formula-copy behavior.

---

## 5) Idempotency and “row addressing” strategy

Google Sheets has no native unique constraints, so idempotency must be designed.

### Recommended approach: Developer Metadata as the primary index
Use **Google Sheets Developer Metadata** to “tag”:
- the `Runs` row for `run_id`,
- the contiguous `Metrics` block for `run_id`,
- the contiguous `Artifacts` block for `run_id`.

Why:
- You can search metadata quickly without scanning entire columns.
- Re-publishing is deterministic: find tagged row/range → overwrite in place.

Fallback approach (simpler, slower):
- read `Runs!A:A` (`run_id` column), find row, update,
- same for metrics/artifacts with scan + delete/insert.

---

## 6) Worker thread model and the “blocking barrier” requirement

### 6.1 Two pools + one lock controller
**Pool A — Blocking (“barrier”) pool**
- Default size: `1`
- Intended for: publish operations that must serialize and must complete before workflow continues.

**Pool B — Background pool**
- Default size: `N` (e.g., 2–6; configurable)
- Intended for: preflight checks, schema validation, deferred publishes, retries, reconciliation tasks.

**Cross-pool lock (configurable):**
- `lockMode=exclusiveBarrier` (recommended):
  - Background tasks run concurrently with each other.
  - Blocking tasks acquire an **exclusive lock** so *no background tasks run during the blocking publish window*.
- `lockMode=none`:
  - Pools run independently.
- `lockMode=serializeAll`:
  - Everything goes through the blocking pool.

This is the cleanest interpretation of “main thread locked waiting for a Sheets thread”: the *workflow* waits and (optionally) the Sheets subsystem becomes single-writer during that window.

### 6.2 Backpressure rules
- Hard cap pending tasks per pool (`maxPending`).
- If cap exceeded:
  - For background tasks: drop or coalesce (configurable).
  - For blocking tasks: reject with a clear error (and mark sink `DEGRADED`).

### 6.3 Timeouts
Every worker task has:
- `timeoutMs` (end-to-end wall clock)
- retry policy (max attempts, exponential backoff, jitter)

---

## 7) Worker protocol (main ↔ worker)

### 7.1 Message types
**Main → Worker**
- `init` `{ auth, spreadsheetId, schemaSpec, clientInfo }`
- `healthcheck` `{}`
- `publishRun` `{ envelope, options }`
- `reconcile` `{ since?: timestamp }`
- `shutdown` `{}`

**Worker → Main**
- `ready` `{ workerId, version }`
- `progress` `{ taskId, phase, detail }`
- `result` `{ taskId, receipt }`
- `error` `{ taskId, error: { code, message, retryable, stack? } }`
- `log` `{ level, message, meta? }` (optional; main thread can also just log locally)

### 7.2 Receipt format
`PublishReceipt` should include:
- `runId`
- `publishedAt`
- `runsRowRef` (sheet name + row index)
- `metricsRangeRef` (sheet + start/end rows)
- `artifactsRangeRef`
- `warnings` (array)
- `schemaVersion`

---

## 8) Reliability strategy

### 8.1 Retries and quota handling
- Retry only on retryable classes: 429, 5xx, network timeouts.
- Exponential backoff with jitter.
- Cap total elapsed time per task (timeout).

### 8.2 Reconciliation on restart
To avoid “job completed but never published”:
1. When a job completes, persist an internal event like `RunFinalized(runId, envelopeHash)`.
2. When Sheets publish succeeds, persist `RunPublished(runId, receipt)`.
3. On orchestrator startup, the sink manager scans for finalized runs lacking publish receipts and enqueues background reconcile.

---

## 9) Orchestrator integration points

### 9.1 Where to hook into job execution
At job completion (or at a dedicated “finalize” step):
- build `RunEnvelope`
- call `SinkManager.publishAll(envelope, { mode })`

To support “blocking barrier” mode:
- set job status to `publishing`
- `await` the blocking publish
- then mark job `completed`

### 9.2 AppState slice
Add a new state domain under something like:

```ts
sinks: {
  sheets: {
    enabled: boolean
    phase: 'disabled'|'starting'|'ready'|'degraded'|'error'
    workers: {
      blocking: { size: number; busy: number; lastReadyAt?: number }
      background: { size: number; busy: number; lastReadyAt?: number }
    }
    queue: { blockingPending: number; backgroundPending: number }
    lastPublish?: { runId: string; at: number; ok: boolean; error?: string }
    lastErrorAt?: number
  }
}
```

### 9.3 Logging
Use the existing logging package and the shared client buffer so Sheets logs show up in the UI.  
Recommended channels:
- `sinks` (or add `sheets` if you extend the channel enum)
- include `runId`, `jobId`, `taskId` as structured fields

---

## 10) Configuration (.env)

### 10.1 Required env vars
Auth:
- `SHEETS_ENABLED=true|false`
- `GOOGLE_SHEETS_SPREADSHEET_ID=...`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL=...`
- `GOOGLE_PRIVATE_KEY=...` *(handle newline escaping as needed)*

Concurrency / behavior:
- `SHEETS_WORKERS_BLOCKING=1`
- `SHEETS_WORKERS_BACKGROUND=4`
- `SHEETS_LOCK_MODE=exclusiveBarrier|none|serializeAll`
- `SHEETS_BLOCKING_TIMEOUT_MS=300000`
- `SHEETS_BACKGROUND_TIMEOUT_MS=300000`
- `SHEETS_MAX_PENDING_BLOCKING=20`
- `SHEETS_MAX_PENDING_BACKGROUND=200`

Retries:
- `SHEETS_RETRY_MAX_ATTEMPTS=10`
- `SHEETS_RETRY_BASE_DELAY_MS=1000`
- `SHEETS_RETRY_MAX_DELAY_MS=30000`

Workbook schema:
- `SHEETS_SCHEMA_VERSION=1`
- `SHEETS_TAB_RUNS=Runs`
- `SHEETS_TAB_METRICS=Metrics`
- `SHEETS_TAB_ARTIFACTS=Artifacts`

### 10.2 Publish mode controls
- `SHEETS_DEFAULT_PUBLISH_MODE=blocking|background`
- `SHEETS_BLOCK_ON_JOB_END=true|false`

---

## 11) File/folder layout (explicit)

Below is a concrete placement that matches the orchestrator module boundary style.

```
packages/orchestrator/src
  core/
    sinks/
      result-sink.ts
      sink-manager.ts
      sheets/
        sheets.sink.ts
        sheets.config.ts
        sheets.envelope.ts
        sheets.mapper.ts
        sheets.worker-pool.ts
        sheets.lock.ts
        sheets.protocol.ts
        worker/
          sheets.worker.ts
          sheets.runtime.ts
          sheets.client.ts
          sheets.schema.ts
          sheets.idempotency.ts
          sheets.retry.ts
          sheets.errors.ts
  adapters/
    sinks/
      sheets-state.adapter.ts
  plugins/
    routes.sinks.ts
```

### 11.1 What each file should contain

#### `core/sinks/result-sink.ts`
- `ResultSink` interface (init/health/publish/shutdown)
- `PublishMode` type: `blocking | background`
- `PublishReceipt` base type

#### `core/sinks/sink-manager.ts`
- Loads enabled sinks from env/config
- Provides:
  - `initAll()`
  - `publishAll(envelope, opts)`
  - `healthSnapshot()`
- Emits sink lifecycle events (to adapter + logs)

#### `core/sinks/sheets/sheets.config.ts`
- Env parsing + Zod validation
- Produces a `SheetsConfig` object:
  - auth fields (or a reference to auth)
  - pool sizes, timeouts
  - workbook tabs + schema version
- Redaction helpers for AppState (never put private key in state)

#### `core/sinks/sheets/sheets.envelope.ts`
- Defines the **single canonical payload** the worker consumes:
  - `RunEnvelope { run, metrics[], artifacts[] }`
- Keeps this stable and versioned (`schemaVersion`)

#### `core/sinks/sheets/sheets.mapper.ts`
- Converts internal job/run objects into `RunEnvelope`
- Normalizes metric keys, units, rounding, etc.
- This is where you “format/calculate/coalesce” before publishing.

#### `core/sinks/sheets/sheets.lock.ts`
- Implements cross-pool lock modes (`exclusiveBarrier`, etc.)
- Exposes helper:
  - `runBlocking(fn)` / `runBackground(fn)` wrappers that acquire/release locks

#### `core/sinks/sheets/sheets.worker-pool.ts`
- Spawns and manages worker threads (two pools)
- Queueing + max pending + timeouts
- Correlation IDs
- Emits worker status events

#### `core/sinks/sheets/sheets.protocol.ts`
- Shared types for worker messaging:
  - request/response unions
  - `Operation` enum
  - error serialization contract

#### `core/sinks/sheets/sheets.sink.ts`
- Implements `ResultSink`
- `publish(envelope, {mode})` chooses pool + lock policy
- Updates AppState via emitted events (or via adapter subscription)

---

### Worker-side files

#### `core/sinks/sheets/worker/sheets.worker.ts`
- Worker entrypoint:
  - receives `init`
  - dispatches `publishRun`, `healthcheck`, etc.

#### `core/sinks/sheets/worker/sheets.runtime.ts`
- Holds worker-global singletons:
  - auth client
  - spreadsheet metadata cache
- Ensures init happens once

#### `core/sinks/sheets/worker/sheets.client.ts`
- The only place that imports Google APIs
- Implements:
  - `ensureWorkbookSchema()`
  - `upsertRunRow()`
  - `upsertMetricsBlock()`
  - `upsertArtifactsBlock()`
  - `publishRunEnvelope()`

#### `core/sinks/sheets/worker/sheets.schema.ts`
- Declares required tabs + headers
- Schema upgrade path:
  - if schema version changes, add columns, create tabs, etc.

#### `core/sinks/sheets/worker/sheets.idempotency.ts`
- Developer-metadata tagging/search helpers
- Determines row/range to overwrite for a given `runId`

#### `core/sinks/sheets/worker/sheets.retry.ts`
- Retry wrapper with backoff/jitter
- Classifies errors as retryable/non-retryable

#### `core/sinks/sheets/worker/sheets.errors.ts`
- Error types + serialization (safe to send to main thread)

---

### Adapter + plugin

#### `adapters/sinks/sheets-state.adapter.ts`
- Converts sink/worker events into `updateAppState({ sinks: { sheets: ... } })`
- Pure-ish mapping; doesn’t talk to Google APIs

#### `plugins/routes.sinks.ts`
Optional but useful:
- `GET /sinks` → sink health snapshot
- `POST /sinks/sheets/test` → enqueue a healthcheck task
- `POST /sinks/sheets/reconcile` → enqueue reconcile

---

## 12) Operational UX (recommended)

### AppState-driven visibility
Show in the UI:
- Sheets sink phase (`ready/degraded/error`)
- worker counts and busy status
- queue depth
- last publish result (runId + timestamp + error summary)

### Logging
Emit log lines like:
- `sheets init ok spreadsheet=…`
- `publish start runId=… mode=blocking`
- `publish ok runId=… runsRow=… metricsRows=…`
- `publish failed runId=… retryable=true attempt=…`

…and ensure they go through the shared buffer.

---

## 13) Summary of key design decisions

1. **Use a normalized data store workbook schema** (Runs/Metrics/Artifacts) rather than a template-driven wide-sheet write strategy.
2. **Two worker pools** (blocking + background) with **configurable sizes** and a **configurable cross-pool lock** to satisfy the “blocking barrier” requirement.
3. **Idempotency via Developer Metadata**, making re-publish deterministic without scanning entire columns.
4. **Explicit AppState slice** (`sinks.sheets`) + adapter for UI observability and operational control.
5. **Strict separation:** only worker code imports Google APIs.
