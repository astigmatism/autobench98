# AutoBench98 — Google Sheets Integration (Sinks + Gateway + Worker Threads) — Reference Design

> **Purpose of this document**  
> This is a “living” reference that explains the Google Sheets integration we designed and scaffolded together:
> - **Google Sheets as a Result Sink** (publish benchmark output)
> - **Google Sheets as a Data Store** (read lookup/reference/layout data)
> - **All Sheets I/O in worker threads**
> - **Configurable concurrency**, **barrier (“blocking”) operations**, **auth strategies**, and **in‑memory caching**
>
> **Important note about naming**  
> We standardized on **“sinks”** (S‑I‑N‑K‑S) everywhere to avoid speech-to-text ambiguity.

---

## Table of Contents

1. [System Goals](#system-goals)  
2. [High-Level Architecture](#high-level-architecture)  
3. [Repository / File Layout](#repository--file-layout)  
4. [Environment Variables](#environment-variables)  
5. [Logging & Observability](#logging--observability)  
6. [Threading Model & Locking](#threading-model--locking)  
7. [Authentication Strategy (`SHEETS_AUTH_STRATEGY`)](#authentication-strategy-sheets_auth_strategy)  
8. [Caching Design (Memory, TTL)](#caching-design-memory-ttl)  
9. [Sheets as a Sink: Publishing Results](#sheets-as-a-sink-publishing-results)  
10. [Sheets as a Database: Gateway Surface](#sheets-as-a-database-gateway-surface)  
11. [Workbook Template Model Support (Keys Row → Block Writes)](#workbook-template-model-support-keys-row--block-writes)  
12. [Typical Flows (Examples)](#typical-flows-examples)  
13. [Failure Modes & Safety Gates](#failure-modes--safety-gates)  
14. [Extensibility (Other sinks / more Sheets ops)](#extensibility-other-sinks--more-sheets-ops)  
15. [Relation to the Older Implementation](#relation-to-the-older-implementation)

---

## System Goals

### Primary goals
- **All Google Sheets I/O in worker threads** to keep Fastify’s event loop responsive (network calls, retries, throttling).
- **Configurable concurrency**: background and blocking pools.
- **Barrier / blocking operations**: allow a workflow step to *wait for Sheets completion* without freezing the Node event loop.
- **Google Sheets as both**:
  - a **Result Sink** (write/publish benchmark outputs), and
  - a **Data Store** (read lookup/historical/reference/layout data).
- **Cache values intelligently**:
  - Avoid “load everything at startup”
  - Load on demand + TTL caching for hot data (keys rows, metadata, lookup tables).

### Non-goals (for the scaffold stage)
- Implementing every workbook convention from the previous app on day 1.
- Introducing external caching (Redis/Memcached) unless needed.
- Exposing a full Sheets CRUD REST API surface (we kept routes minimal by design).

---

## High-Level Architecture

### Conceptual view

```
Fastify main thread
  ├─ sinks-plugin (register sinks + lifecycle)
  │    ├─ SinkManager (owns sinks)
  │    └─ SheetsSink (publish path)
  │
  ├─ SheetsGateway (database-like read/write surface)
  │    └─ Shares worker pools with SheetsSink
  │
  └─ Web/WS/UI + other device plugins (serial, stream, etc.)
         (remain responsive; no direct Sheets I/O)
                |
                v
Worker thread pools (Google Sheets I/O only)
  ├─ blocking pool  (barrier operations)
  └─ background pool (parallel work)
        |
        v
Google APIs (Sheets)
```

### Components (what each does)

- **sinks-plugin**
  - Registers sinks (Sheets now, others later)
  - Sets up lifecycle hooks (`onReady`, `onClose`)
  - Logs configuration in **key=value** style

- **SinkManager**
  - Owns an array of `ResultSink` implementations
  - `initAll()`, `shutdownAll()`, `publishAll()`, `healthySnapshot()`
  - Best-effort publishing: one sink failing does not crash others

- **SheetsHost** (recommended shared internal concept)
  - Owns worker pools (blocking/background)
  - Applies locking policy (`exclusiveBarrier` / `serializeAll` / `none`)
  - Implements `authWarmup()` per `SHEETS_AUTH_STRATEGY`
  - Provides shared “execute in pool” helpers

- **SheetsGateway**
  - A database-like surface for **reads and writes**
  - Implements caching and primitives like:
    - `valuesGet`, `valuesBatchGet`, `valuesUpdate`
    - `getSpreadsheetMeta`
    - `getValueToColumnLetterMap` (keys row mapping)
    - insert row/column, copy row template, etc.

- **SheetsSink**
  - Thin adapter for sink publishing that calls SheetsHost / worker ops
  - Uses the same worker pools and auth strategy as the Gateway
  - Returns receipts for publish attempts

---

## Repository / File Layout

> Your repo uses `services/orchestrator/src/...`. If you have an alternate root (e.g. `packages/orchestrator/src`), the **relative structure** is still valid.

### Orchestrator

```
services/orchestrator/src
  plugins/
    sinks-plugin.ts                 # registers sinks + lifecycle
  core/
    sinks/
      result-sink.ts                # ResultSink types
      sink-manager.ts               # fanout publisher
      sheets/
        sheets.config.ts            # env parsing + defaults (includes AUTH_STRATEGY)
        sheets.sink.ts              # Sheets result sink
        sheets.worker-pool.ts       # worker pool implementation + helpers
        sheets.lock.ts              # Barrier + Mutex for lock modes
        sheets.protocol.ts          # worker request/response types
        sheets.envelope.ts          # publish envelope types (sink publishing)
        worker/
          sheets.worker.ts          # worker entrypoint (message dispatch)
          sheets.runtime.ts         # auth client + spreadsheet cache
          sheets.service.ts         # actual Google API calls (read/write primitives)
```

### Logging package changes

```
packages/logging/src
  types.ts                          # adds LogChannel.google_sheets + ChannelColor.orange
  channels.ts                       # adds channel metadata + ANSI orange escape
  logger.ts                         # unchanged except supports new channel/color
```

---

## Environment Variables

Below is the **drop-in section** to add to your `.env`. This covers:
- enabling/disabling
- dry-run safety
- auth strategy
- worker pool sizes
- lock mode
- timeouts + queue limits
- caching knobs
- workbook schema conventions (tabs)

### `.env` section: Google Sheets

```bash
# ------------------------------------------------------------------------------
# Google Sheets (Result Sink + Data Store) — Orchestrator-owned
# ------------------------------------------------------------------------------

# Enable/disable Sheets integration.
SHEETS_ENABLED=false

# Safety: when true, the worker will NOT perform write mutations.
# Keep true until you have validated spreadsheet sharing + ranges + behavior.
SHEETS_DRY_RUN=true

# Auth strategy:
# - lazy   : no preflight; first real op triggers auth/network
# - warmup : run a preflight at init (non-blocking)
# - strict : run preflight at init; fail init if preflight fails
SHEETS_AUTH_STRATEGY=lazy

# Spreadsheet file identifier. This is what many codebases call "doc id".
GOOGLE_SHEETS_SPREADSHEET_ID=
# Optional compatibility alias (same value):
# GOOGLE_SHEETS_DOC_ID=

# Service account credentials
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=

# Worker pools
SHEETS_WORKERS_BLOCKING=1
SHEETS_WORKERS_BACKGROUND=4

# Lock mode:
# - exclusiveBarrier: blocking waits/drains background then runs exclusively (recommended)
# - serializeAll: everything runs via blocking mutex
# - none: allow concurrency between pools
SHEETS_LOCK_MODE=exclusiveBarrier

# Timeouts (ms)
SHEETS_BLOCKING_TIMEOUT_MS=300000
SHEETS_BACKGROUND_TIMEOUT_MS=300000

# Backpressure
SHEETS_MAX_PENDING_BLOCKING=20
SHEETS_MAX_PENDING_BACKGROUND=200

# Retry policy (scaffold knobs)
SHEETS_RETRY_MAX_ATTEMPTS=10
SHEETS_RETRY_BASE_DELAY_MS=1000
SHEETS_RETRY_MAX_DELAY_MS=30000

# Cache (in-memory TTL)
SHEETS_CACHE_ENABLED=true
SHEETS_CACHE_MAX_ENTRIES=500
SHEETS_CACHE_SHEET_META_TTL_MS=300000     # 5 minutes
SHEETS_CACHE_KEYMAP_TTL_MS=3600000        # 1 hour
SHEETS_CACHE_RANGE_TTL_MS=30000           # 30 seconds

# Workbook conventions (tabs / schema)
SHEETS_SCHEMA_VERSION=1
SHEETS_TAB_RUNS=Runs
SHEETS_TAB_METRICS=Metrics
SHEETS_TAB_ARTIFACTS=Artifacts

# Publish behavior
SHEETS_DEFAULT_PUBLISH_MODE=background    # blocking | background
SHEETS_BLOCK_ON_JOB_END=false
```

### Logging allowlist (important)
If your Studio / WS log streaming uses an allowlist, ensure the Sheets channel is included:

```bash
LOG_CHANNEL_ALLOWLIST=...,google-sheets
```

---

## Logging & Observability

### Why we added a dedicated channel
You wanted Sheets logs to **stand out** and not be mixed with `app` or `benchmark`.  
We introduced:

- `LogChannel.google_sheets = 'google-sheets'`
- `ChannelColor.orange`
- ANSI: `\x1b[38;5;208m` (terminal orange)

### Conventions: key=value formatting
You pointed out your existing logs look like:

```
⌨️  [keyboard]: kind=keyboard-device-identified path=/dev/ttyACM2 baud=9600
```

So we standardized sinks + sheets logs to:

- **one line**
- **key=value tokens**
- avoid structured objects in log calls by default

#### Example logs
```text
📦 [app]: kind=sinks-plugin-config-loaded sheetsEnabled=true sheetsDryRun=true sheetsLockMode=exclusiveBarrier workersBlocking=1 workersBackground=4 spreadsheetIdPresent=true serviceAccountEmailPresent=true privateKeyPresent=true
🟧 [google-sheets]: kind=sheets-sink-initialized dryRun=true lockMode=exclusiveBarrier workersBlocking=1 workersBackground=4
📦 [app]: kind=sink-init-start id=sheets
📦 [app]: kind=sink-init-ok id=sheets
```

### Where logs are emitted
- `sinks-plugin` lifecycle/config → `LogChannel.app`
- Sheets API / worker pool / preflight / publish ops → `LogChannel.google_sheets`

---

## Threading Model & Locking

### Two pools
- **Blocking pool** (`SHEETS_WORKERS_BLOCKING`)
  - Used for barrier operations where the workflow must wait.
  - Typical size: `1`.

- **Background pool** (`SHEETS_WORKERS_BACKGROUND`)
  - Used for parallelizable work (reads, non-critical publishes, cache warmups).
  - Typical size: `2–6` depending on host resources and quota behavior.

### Backpressure
Each pool has:
- `maxPending` queue cap
- if exceeded:
  - background tasks may be rejected or deferred (implementation-dependent)
  - blocking tasks should be treated as a “hard” failure (caller decides policy)

### Lock modes
`SHEETS_LOCK_MODE`:

#### `exclusiveBarrier` (recommended)
- Background tasks run normally.
- When a **blocking** op starts:
  1) background pool drains
  2) barrier activates
  3) blocking op runs exclusively
  4) barrier deactivates

Use when you want deterministic “no other Sheets changes happening” during a barrier op.

#### `serializeAll`
- Everything runs through a mutex (even background-style tasks).
- Simpler reasoning, lower throughput.

#### `none`
- No ordering constraints.
- Highest throughput, but can create write contention and more complex debug stories.

---

## Authentication Strategy (`SHEETS_AUTH_STRATEGY`)

This was added because you wanted a clear, configurable answer to:

> “Should we authenticate at startup, or on first operation?”

### `lazy`
- No preflight at init.
- First real Sheets operation triggers auth + network.
- Pros: fastest boot, resilient to transient network at startup.
- Cons: you might discover auth problems only when you try to read/write.

### `warmup`
- On init: enqueue a worker-side **preflight** (non-blocking).
- Pros: early signal in logs + sink health without blocking startup.
- Cons: still possible a later operation fails if permissions change.

### `strict`
- On init: run preflight **blocking** and fail init if it fails.
- Pros: deterministic; you don’t start “green” unless Sheets is reachable & creds are correct.
- Cons: startup depends on Google availability; may be undesirable in some environments.

### What the preflight actually does
A safe preflight is a **read-only** call such as:
- Fetch spreadsheet metadata (title / id)
- Or read a single cell/range

The key point is: preflight must force the auth token flow and confirm that the spreadsheet is accessible.

---

## Caching Design (Memory, TTL)

### Why memory caching is sufficient (for now)
You explicitly said you likely do not want a third-party cache unless it’s incredibly useful.  
So the scaffold uses:
- in-process memory cache
- TTL-based eviction
- size cap (`SHEETS_CACHE_MAX_ENTRIES`)

### What we cache
1) **Spreadsheet metadata** (sheet names, ids, row/column count)
2) **Key maps** (keys row values → column letters)
3) **Range reads** (values from `valuesGet` / `valuesBatchGet`)

### TTL guidance
- Key maps change rarely → TTL 30–60 minutes is reasonable
- Range reads for UI data might update → TTL 5–30 seconds
- Metadata might change occasionally → TTL 5 minutes

### Cache invalidation triggers
- `forceReload` options (caller can bypass cache)
- on write operations that mutate structure (insert column/row), you may choose to:
  - invalidate metadata cache for that sheet
  - invalidate key-map cache for affected rows

---

## Sheets as a Sink: Publishing Results

### Sink interface (conceptually)
A sink exists to answer: “where should run results go?”

A minimal interface we used:

```ts
interface ResultSink {
  id: string
  init(): Promise<void>
  healthy(): Promise<boolean>
  publish(run, metrics, artifacts): Promise<PublishReceipt>
  shutdown?(): Promise<void>
}
```

### SinkManager
- Owns sinks
- initializes them at startup
- publishes results (best effort)
- returns receipts for each sink

### SheetsSink behavior
- Reads config from env (or injected config)
- Starts worker pools if enabled
- Applies auth strategy
- On `publish()`:
  - choose blocking/background by `SHEETS_DEFAULT_PUBLISH_MODE`
  - send a publish envelope to a worker operation
  - return receipt

### Publish receipts
Receipts are structured so the orchestrator can:
- show status in UI
- store in event logs (if you choose)
- detect failures and retry later

---

## Sheets as a Database: Gateway Surface

This is the key evolution you asked for: **Sheets is a storage layer**, not just a sink.

### SheetsGateway: core idea
A *main-thread facade* that:
- exposes typed operations (read/write)
- uses worker threads for all I/O
- caches common reads

### Recommended API surface (example)
```ts
interface SheetsGateway {
  // meta
  getSpreadsheetMeta(opts?: { forceReload?: boolean }): Promise<SpreadsheetMeta>

  // values reads/writes
  valuesGet(rangeA1: string, opts?: { cacheTtlMs?: number; forceReload?: boolean }): Promise<{ values: any[][] }>
  valuesBatchGet(rangesA1: string[], opts?: { cacheTtlMs?: number; forceReload?: boolean }): Promise<Record<string, any[][]>>
  valuesUpdate(rangeA1: string, values: any[][], opts?: { valueInputOption?: 'RAW'|'USER_ENTERED' }): Promise<void>

  // template / structure helpers
  getValueToColumnLetterMap(sheetName: string, keysRowNumber: number, opts?: { startCol?: string; endCol?: string; forceReload?: boolean }): Promise<Record<string,string>>
  insertRow(sheetName: string, rowNumber?: number): Promise<{ insertedRowNumber: number }>
  insertColumn(sheetName: string, afterColumnLetter: string): Promise<{ insertedColumnLetter: string }>
  copyRow(sheetName: string, sourceRowNumber: number, targetRowNumber: number, startColumnLetter: string, endColumnLetter?: string): Promise<void>
}
```

### Why this solves the “DB” problem
- UI panels can read reference data as needed (cached).
- Benchmark runner can resolve keys rows and block locations (cached).
- Publisher can write into template blocks.

---

## Workbook Template Model Support (Keys Row → Block Writes)

Your older app’s core idea:

> “Don’t hard-code column indices; use keys rows in the sheet to locate blocks.”

That remains the best approach for a template workbook that evolves.

### Keys row mapping
A **keys row** is a row in the sheet where each cell contains a marker string.
We build a map:

```
"value in cell" -> "column letter"
```

Example:
- `"Preface-start" -> "B"`
- `"Preface-end"   -> "J"`
- `"1001"          -> "K"` (benchmark block start)
- `"GrandSummary-summary" -> "AA"`

Then:
- find the start column letter for a metric block
- write values across consecutive columns

### Copying formulas from a template row
Your old code copied formulas and values from a “formulas row” into a newly inserted row, adjusting row references.

We kept the same capability as a primitive:
- `insertRow(...)`
- `copyRow(...)` (sourceRow → targetRow, range)

This is essential for:
- maintaining computed columns
- preserving workbook formatting and formulas

---

## Typical Flows (Examples)

### 1) Startup: warmup vs strict vs lazy

**lazy**
```text
app starts -> workers start -> no network call
first read/write triggers auth + network
```

**warmup**
```text
app starts -> workers start -> schedule authWarmup in background
logs show warmup result, but app continues regardless
```

**strict**
```text
app starts -> workers start -> authWarmup blocking
if warmup fails -> sink init fails (policy dependent)
```

### 2) Benchmark run: template publishing (key row → insert row → write)

**Pseudo-flow**
```ts
// At start of run
const keyMap = await app.sheetsGateway.getValueToColumnLetterMap('Benchmarks', /*keysRow*/ 3)

// Insert new row (if this run needs a new row)
const { insertedRowNumber } = await app.sheetsGateway.insertRow('Benchmarks')

// Copy template formulas across preface range
await app.sheetsGateway.copyRow('Benchmarks', /*formulasRow*/ 5, insertedRowNumber, keyMap['Preface-start'], keyMap['Preface-end'])

// Write preface fields, then write metrics into blocks
await app.sheetsGateway.valuesUpdate(`Benchmarks!${keyMap['ENTRY_DATE']}${insertedRowNumber}`, [[serialDate]], { valueInputOption: 'USER_ENTERED' })

const startCol = keyMap['1001']  // benchmarkId marker
await app.sheetsGateway.valuesUpdate(`Benchmarks!${startCol}${insertedRowNumber}:${/*end*/'P'}${insertedRowNumber}`, [[/*metrics*/]], { valueInputOption: 'USER_ENTERED' })
```

### 3) UI reads: reference/historical data

```ts
// Periodic UI refresh (cached)
const r = await app.sheetsGateway.valuesGet('Reference!A2:F200', { cacheTtlMs: 15_000 })
```

---

## Failure Modes & Safety Gates

### Safety: `SHEETS_DRY_RUN`
When `true`:
- worker still performs reads and validations
- write operations are treated as no-ops or simulated
- logs should say dryRun=true and include kind markers

This is the safest “bring-up” mode.

### Auth failures
- `lazy`: first operation fails (error returned/logged)
- `warmup`: warmup logs a failure; later ops may also fail
- `strict`: sink init fails early

### Queue overload
If `maxPending` is exceeded:
- return error immediately
- logs: `kind=sheets-queue-overflow pool=... pending=... max=...`

### Google throttling / transient failures
Retries should be:
- bounded by attempts
- backed off
- visible in logs

---

## Extensibility (Other sinks / more Sheets ops)

### Other sinks
SinkManager is built to take more sinks:
- `jsonl` (append JSON lines to disk)
- `csv`
- `sqlite`
- `text` summaries

The sinks-plugin can register them all and publish to all.

### More Sheets ops
If you want parity with the older service class, the next “upgrade path” is to add higher-level gateway helpers that wrap multiple primitives, e.g.:

- `prepareBenchmarkWorksheet({sheetId, keysRow, formulasRow, writeAccess})`
- `writeWorksheetPreface({lookupSheet, lookupCell, destKey})`
- `writeTabulations({benchmarkId -> values[]})`
- `writeSummary({worksheetKey, insertTime})`

But those can be layered on top of:
- key maps
- row insert/copy
- valuesUpdate/batchUpdate

---

## Relation to the Older Implementation

You shared a worker-threaded implementation that used:
- service account JWT auth
- document/worksheet caching
- aggressive retries
- workbook template conventions (keys rows, formulas rows, preface ranges)
- dynamic column insertion for identification sheets

That older approach is described in your prior design doc as well. fileciteturn0file0

### What we kept
- Worker-thread-only Sheets I/O
- Two-pool concurrency model (serialized vs parallel)
- Key-row based column resolution
- Template-row copy workflows
- “auth at start vs on-demand” as a configurable choice

### What we changed / improved
- **Unified terminology**: “sinks” everywhere
- **Explicit auth strategy**: `SHEETS_AUTH_STRATEGY=lazy|warmup|strict`
- **Dedicated log channel**: `google-sheets` in orange
- **Consistent log formatting**: key=value everywhere
- **Sheets as DB support** via a Gateway surface and caching

### Why this matters for your “Sheets as DB” use case
The older system already had read operations (e.g., lookup values, key maps).  
The new design formalizes that as a first-class surface (**SheetsGateway**) so you can:
- read reference data for UI
- read key rows for writes
- keep all I/O threaded
- cache safely and predictably

---

## Appendix A: Key=value logging recommendations

Use a consistent `kind=` marker first:

- `kind=sheets-auth-warmup-start`
- `kind=sheets-auth-warmup-ok`
- `kind=sheets-auth-warmup-failed err="..."`
- `kind=sheets-values-get range="..." cacheHit=true`
- `kind=sheets-insert-row sheet=... row=...`

This makes log filtering and timeline analysis much easier.

---

## Appendix B: Suggested next milestone (if you want “old parity”)

Implement a `TemplatePublisher` on top of `SheetsGateway`:

- `prepareBenchmarkWorksheets()`
- `prepareDurationWorksheet()`
- `writeWorksheetPreface()`
- `writeTabulations()`
- `writeSummary()`
- `writeTestDurations()`
- `writeDeviceIdentificationDetails()`

Each can be built by composing Gateway primitives while benefiting from:
- caching
- pooled workers
- lock modes
- auth strategy

---

**End of document.**
