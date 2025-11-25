# AutoBench98 Datastore & Google Sheets Integration Design

## 1. Scope and Goals

This document defines a **new datastore design** for AutoBench98 that:

- Uses **Google Sheets** as the *primary, human-facing store* for benchmark and identification data.
- Maintains a **local filesystem backup** written at runtime, in parallel with Sheets writes.
- Exposes a **clean, technology-agnostic abstraction** to the rest of the application (the orchestrator and front end).
- Preserves the **good instincts** from the previous implementation (workers, blocking vs non-blocking ops) without copying its structure verbatim.

This is a **conceptual and architectural design**, not an implementation spec for specific files or modules.


## 2. High-Level Architecture

The datastore layer is decomposed into three main parts:

1. **Datastore Adapter Interface**  
   A technology-agnostic API used by the orchestrator and services. It defines operations in domain terms (e.g. “record a benchmark run”, “update device identification”), not “write range to Sheet X”.

2. **Sheets Datastore Backend**  
   Implements the adapter operations against **Google Sheets** using worker threads, queues, and blocking/non-blocking commands. This is the primary live store that the user edits and inspects.

3. **Local JSON Datastore Backend (Backup)**  
   Implements the same operations by writing to the local filesystem as **JSON documents** — a “log / backup” of what the orchestrator knows, written at runtime (dual-write), not via periodic scraping of Sheets.

A **Composite Datastore** coordinates these backends:

```text
Orchestrator / Application
         |
         v
  DatastoreAdapter (composite)
         |
         +-- SheetsDatastore (workers, network I/O)
         |
         +-- LocalJsonDatastore (filesystem backup)
```

At this stage:

- **Sheets is authoritative for reading** and for human editing.
- **Local JSON is a runtime backup**, suitable for recovery and future migration to a dedicated DB if desired.


## 3. Terminology

- **Benchmark Run**: A single execution of a benchmark configuration (game, map, resolution, platform, etc.) on a given Win98 machine.
- **Identification Data**: Structured hardware and configuration information, primarily from AIDA64; includes GPUs, CPUs, memory, platforms, etc.
- **AIDA64 Identification Categories**: Nested data of the form `category → subcategory → property → value`.
- **Sheets Worker**: A worker thread responsible for interacting with the Google Sheets API on behalf of the main process.
- **Blocking Operation**: A datastore operation that must complete successfully before the orchestrator can proceed.
- **Non-Blocking Operation**: A datastore operation that can be queued and executed in the background.


## 4. Functional Requirements

### 4.1 Core Use Cases

1. **Write benchmark tabulations to one or more Sheets**  
   - Insert a new result row (if requested), based on a template row with formulas.
   - Write per-benchmark metric values (e.g. FPS, etc.) with appropriate numeric formatting.
   - Optionally write summaries (aggregated formulas, entry dates).

2. **Write and update device identification details (Platform / CPU / GPU / Memory)**  
   - Ensure a row exists for a given **unique ID** (e.g. GPU ID).
   - If the ID is new:
     - Insert a row.
     - Copy template formulas into the row.
     - Write AIDA64-derived identification properties into the row.
   - If the ID exists: update the existing row only where appropriate.

3. **Write AIDA64 benchmark / identification data to benchmark or other Sheets**  
   - Consume nested `IdentificationCategories` objects.
   - Dynamically create new columns (categories/subcategories/properties) as new AIDA fields appear.
   - Write property values into the appropriate columns for the current row.

4. **Record test duration statistics**  
   - For a dedicated “Durations” sheet:
     - Ensure a row is allocated (template-based).
     - Write pass count.
     - Write average full test duration, pass duration, and a “meaningful metric” per test key.

5. **Lookup and preface writing**  
   - Read identification data (e.g. platform name, GPU name) from one sheet.
   - Write the “keyed” text (e.g. a dropdown/lookup value) into a target benchmark row.
   - Used to decorate benchmark rows with human-readable device names.

6. **Tips / Info Pane Support (Future)**  
   - Ability to store and retrieve “tips” or informational snippets (e.g., per game, per map, general tips).
   - These can be kept in a dedicated Sheet and mirrored locally as JSON for potential in-app display.


### 4.2 Non-Functional Requirements

- **Non-blocking orchestrator**: benchmark timing and orchestration must not be stalled by network I/O to Sheets.
- **Hybrid blocking & non-blocking behavior**:
  - Some operations must be *blocking* (e.g. row creation, ID discovery) so the orchestrator has the necessary state to proceed.
  - Others can be *non-blocking* (e.g. writing large AIDA64 reports, notes, or tabulations that don’t affect control flow).
- **Resilience to Sheets latency / errors**: Retry logic, worker isolation, and clear error paths.
- **Support for evolving schema**:
  - AIDA64 may introduce new categories, subcategories, or properties.
  - Sheets should be allowed to grow new columns dynamically.
  - Local JSON should represent the nested structures naturally, without schema headaches.
- **Human-centric editing**:
  - Sheets remain the preferred environment for inspection and editing.
  - Layout and formulas are under the user’s control.
- **Future extensibility**:
  - Local JSON backup is structured so that upgrading to SQLite / another DB is straightforward if needed.
  - The adapter API remains stable even if backends change.


## 5. Data Model Overview

### 5.1 Conceptual Entities

We intentionally model at a **domain level**, not at the level of columns or rows:

- `DeviceId`: stable unique ID for a device record (GPU, CPU, Platform, Memory).
- `BenchmarkRunId`: unique ID per benchmark run.
- `AidaSnapshotId`: unique ID linking to a full AIDA report snapshot.
- `GameKey`: e.g. `ut99`, `quake3`.
- `ContextKey`: e.g. `map_q3dm6`, `intro_platform`, `any` for tips.

These IDs are used both in Sheets (as a dedicated column) and in local JSON. **Row numbers are never used as stable IDs.**

### 5.2 Local JSON Structure (Backup)

The local datastore keeps JSON files in a structure like:

```text
data/
  identification/
    gpu/
      gpu-<device-id>.json
    cpu/
      cpu-<device-id>.json
    platform/
      platform-<device-id>.json
    memory/
      memory-<device-id>.json

  benchmarks/
    runs/
      run-<benchmark-run-id>.json

  aida_snapshots/
    snapshot-<aida-snapshot-id>.json

  tips/
    tip-<tip-id>.json    # future use
```

Each JSON document is **what the orchestrator knows** at the time of writing, not a projection of the Sheets layout.

#### Example: GPU identification file

```jsonc
{
  "deviceId": "gpu-nv25-4200",
  "category": "GPU",
  "vendor": "NVIDIA",
  "marketingName": "GeForce4 Ti 4200",
  "coreName": "NV25",
  "family": "GeForce4",
  "busType": "AGP 4x",
  "memoryMB": 64,
  "launchPriceUSD": 199.99,
  "launchDate": "2002-04-01",

  "aida": {
    "Graphics Processor Properties": {
      "Transistors": "63 million",
      "Process Technology": "0.15 micron",
      "GPU Clock": "250 MHz",
      "Pixel Pipelines": 4,
      "TMU Per Pipeline": 2
    },
    "Memory Bus Properties": {
      "Bus Type": "DDR",
      "Bus Width": "128-bit",
      "Real Clock": "250 MHz",
      "Effective Clock": "500 MHz",
      "Bandwidth": "8.0 GB/s"
    },
    "OpenGL Properties": {
      "Vendor": "NVIDIA Corporation",
      "Version": "1.3.1",
      "Max Texture Size": 2048,
      "Supported Extensions": [
        "GL_ARB_multitexture",
        "GL_EXT_texture_env_add"
      ]
    }
    // ... other AIDA categories as needed ...
  },

  "meta": {
    "firstSeenAt": "2025-11-23T12:34:56Z",
    "lastUpdatedAt": "2025-11-23T12:34:56Z"
  }
}
```

#### Example: benchmark run file

```jsonc
{
  "benchmarkRunId": "run-2025-11-23T20-01-00Z",
  "platformId": "platform-440bx-001",
  "cpuId": "cpu-p3-1000",
  "gpuId": "gpu-nv25-4200",
  "memoryId": "mem-sdram-256mb-001",

  "gameKey": "ut99",
  "mapKey": "dm_deck16",
  "resolution": "1024x768",
  "passes": 3,
  "runDate": "2025-11-23T20:01:00Z",

  "metrics": {
    "fpsAverage": 125.4,
    "fpsMin": 90.2,
    "fpsMax": 180.7,
    "meaningfulMetric": 125.4
    // plus any additional metrics
  },

  "aidaSnapshotId": "snapshot-<uuid>",

  "meta": {
    "createdFromMachine": "win98-box-01",
    "orchestratorVersion": "x.y.z"
  }
}
```

Local JSON is **append-only and tolerant of new fields**. It does not require migrations for new metrics or properties.


## 6. Datastore Adapter API

The **DatastoreAdapter** is an interface that the orchestrator uses. It encapsulates both the Sheets and local JSON backends.

### 6.1 Blocking vs Non-Blocking Calls

Two categories of operations:

- **Blocking operations**: must complete successfully before the orchestrator proceeds.
- **Non-blocking operations**: queued and executed in the background.

Conceptually:

```ts
interface DatastoreAdapter {
  // BLOCKING
  prepareBenchmarkRow(params: PrepareBenchmarkRowParams): Promise<PreparedBenchmarkRow>;
  ensureIdentificationRecord(params: EnsureIdentificationRecordParams): Promise<IdentificationRecordInfo>;
  getIdentificationUniqueIds(): Promise<IdentificationUniqueIds>;
  prepareDurationRow(params: PrepareDurationRowParams): Promise<PreparedDurationRow>;

  // NON-BLOCKING
  writeTabulations(params: WriteTabulationsParams): void;
  writeSummary(params: WriteSummaryParams): void;
  writeAida64Benchmark(params: WriteAida64BenchmarkParams): void;
  writeTestDurations(params: WriteTestDurationsParams): void;
  writeWorksheetPreface(params: WriteWorksheetPrefaceParams): void;
  writeSheetNotes(params: WriteSheetNotesParams): void;

  // Future tips/info APIs
  writeTip(params: WriteTipParams): void;
  getTipsForContext(params: GetTipsParams): Promise<Tip[]>; // may be blocking, but not time-critical
}
```

Internally, these are mapped to:

- **SheetsDatastore** operations (with worker queues).
- **LocalJsonDatastore** operations (direct filesystem writes).


### 6.2 Example Operation Semantics

#### 6.2.1 `prepareBenchmarkRow` (blocking)

- Allocates a new row in each active benchmark sheet OR uses a specified row.
- Copies formulas from a template row over a defined range.
- Returns:
  - Effective row number per sheet.
  - Key → column letter maps.
  - Possibly the “display name” cell location for later reading.

This is blocking because follow-up writes (prefaces, tabulations, summaries) need the row number and column map.

#### 6.2.2 `ensureIdentificationRecord` (blocking)

- Ensures a row exists for a given `deviceId` in the relevant identification sheet (Platform/CPU/GPU/Memory).
- If the ID exists:
  - Returns the row number and metadata; may update values if appropriate.
- If the ID is new:
  - Inserts a new row.
  - Copies template formulas.
  - Writes the incoming identification data (categories/subcategories/properties).
- Writes a corresponding JSON file in the local identification folder.

Blocking because the orchestrator may need the row number for cross-sheet lookups and logging.


#### 6.2.3 `writeTabulations` (non-blocking)

- Takes benchmark ID → tabulation metrics, plus number format hints.
- Queues a Sheets write to fill the metrics row.
- Writes a local benchmark-run JSON record in parallel.

Non-blocking because it does not affect control flow; failure can be retried/logged.


#### 6.2.4 `writeAida64Benchmark` (non-blocking)

- Takes `IdentificationCategories` (nested AIDA structure) for the benchmark sheets.
- Queues a Sheets operation to:
  - Ensure category/subcategory/property columns exist.
  - Write values into the appropriate columns.
- Writes the same nested structure into a local JSON file (e.g. `aida_snapshots/snapshot-*.json`), possibly linked by `aidaSnapshotId` to the benchmark run file.

Non-blocking because this is rich, non-critical metadata.


#### 6.2.5 `writeTestDurations` (non-blocking)

- Uses prepared duration row info to write:
  - pass count,
  - average full test duration,
  - average pass duration,
  - average meaningful metric per test key.
- Writes the same data to a local JSON file in `benchmarks/runs/` or a dedicated durations folder.

Non-blocking because it does not affect control flow once the duration row exists.


## 7. Sheets Datastore Backend (Workers & Queues)

### 7.1 Worker Pools

We preserve the core idea of **dedicated worker threads** for Sheets I/O, but the implementation is fresh and shaped by the new adapter.

Two main pools (configurable):

1. **Blocking Operations Pool** (small, possibly 1–2 workers)
   - Used for operations that the orchestrator must await:
     - `prepareBenchmarkRow`
     - `ensureIdentificationRecord`
     - `prepareDurationRow`
     - `getIdentificationUniqueIds`
   - Ensures deterministic ordering and reduced contention for critical manipulations (row/column insertion, template copying).

2. **Non-Blocking Operations Pool** (larger, e.g. 4 workers)
   - Used for high-volume or heavy operations:
     - `writeTabulations`
     - `writeSummary`
     - `writeAida64Benchmark`
     - `writeTestDurations`
     - `writeWorksheetPreface`
     - `writeSheetNotes`
   - Can process tasks in parallel to maximize throughput.

Both pools share common mechanisms:

- **Task queue** per pool.
- **Promise-based completion** for blocking operations.
- **Fire-and-forget with logging** for non-blocking ones.
- **Retry with delay** for transient Sheets errors (5xx, network issues).


### 7.2 Sheets Operations (Conceptual)

The Sheets backend implements the abstract commands via the `google-spreadsheet` library (or a successor). Key capabilities include:

- **Worksheet caching** by ID, with explicit reload when necessary.
- **Row insertion** with template-based formula copying.
- **Column insertion** when new AIDA categories/subcategories/properties appear.
- **Header-based column mapping** using key rows:
  - Key rows: category, subcategory, property, and logical keys like `"ENTRY_DATE"`, `"Preface-start"`, `"display-name"`, etc.
- **Cell range loading and updates** with error cleanup (e.g. clearing `#DIV/0!`, `#VALUE!` if needed).

The previous implementation already demonstrated these capabilities; the new design keeps the behaviors but exposes them via higher-level commands instead of direct function calls.


## 8. Local JSON Datastore Backend (Backup)

### 8.1 Responsibilities

The local JSON backend is **not authoritative** at this stage. Its duties are:

- **Write-through backup**:
  - Whenever a datastore operation is invoked with some domain payload (e.g. identification, benchmark run, durations), the local backend writes a JSON representation to disk.
- **Simple, stable naming conventions**:
  - Device files keyed by `deviceId`.
  - Benchmark runs keyed by `benchmarkRunId`.
  - AIDA snapshots keyed by `aidaSnapshotId`.
- **Append-only by default**:
  - Records can store `meta.lastUpdatedAt` to support eventual updates, but historical data should be preserved where feasible (optionally via parallel `*.history.log` files).

### 8.2 File Layout and Naming

A proposed layout (can be adjusted to taste):

```text
data/
  identification/
    gpu/
      gpu-<device-id>.json
    cpu/
      cpu-<device-id>.json
    platform/
      platform-<device-id>.json
    memory/
      memory-<device-id>.json

  benchmarks/
    runs/
      run-<benchmark-run-id>.json

  aida_snapshots/
    snapshot-<aida-snapshot-id>.json

  durations/
    duration-<benchmark-run-id>.json   # optional, if separate

  tips/
    tip-<tip-id>.json
```

The exact schema of each JSON is deliberately flexible. The essential requirement is that **everything needed to rebuild Sheets or seed a future DB exists in these files**.

### 8.3 Recovery and Migration

If Sheets are corrupted, or the user deletes rows accidentally, recovery can proceed as follows:

1. Use local JSON data as input.
2. Run a **rebuild tool** that:
   - Creates or reconfigures Sheets to a desired layout.
   - Replays identification records (per device).
   - Replays benchmark run rows, tabulations, and summaries.
   - Replays AIDA64 extended data to regenerate dynamic columns.

Because the local JSON retains *full nested AIDA structures and metadata*, the rebuild tool is free to project those into a new Sheets layout without being tied to old column names.


## 9. Tips / Information Pane (Future Vertical Slice)

A lightweight early consumer of this datastore abstraction is the **tips pane** on the front end.

### 9.1 Storage

Tips can be stored in either:

- A dedicated **Tips Sheet** (for ease of editing), mirrored to local JSON, or
- A local JSON file first, with a Sheets projection later.

Example tip structure:

```jsonc
{
  "tipId": "tip-ut99-general-001",
  "gameKey": "ut99",
  "contextKey": "any",
  "weight": 10,
  "text": "UT99 benchmarks use demo XYZ to reduce variance between runs.",
  "enabled": true
}
```

### 9.2 Retrieval

A datastore method like:

```ts
getTipsForContext({
  gameKey?: string;
  contextKey?: string;
}): Promise<Tip[]>
```

can query either:

- Directly from local JSON (fast, in-process), or
- From Sheets, then cached locally.

The front-end pane can then periodically request a random tip, filtered by game and/or context.


## 10. Future Evolution: From Backup to Authoritative DB

The design intentionally keeps the door open for promoting the local datastore to an authoritative system:

- The **DatastoreAdapter** does not assume Sheets is the single source of truth; it just happens that the current read operations prefer Sheets.
- If performance, size, or reliability requirements change, a future **SQLite** or **DuckDB** backend could be added:
  - It would consume the same JSON structures currently written to disk.
  - It could become the primary target for `prepareBenchmarkRow` / `ensureIdentificationRecord`, with Sheets becoming a reporting/visualization projection.
- The worker-based concurrency model still applies:
  - Database operations might be faster and could run in-process.
  - Sheets projection could remain worker-based and fully async, independent of the main orchestrator.


## 11. Summary

This design:

- **Respects the realities of your workflow**:
  - Sheets as the visible, editable, human-friendly environment.
  - AIDA64-driven, evolving, nested data structures.
  - High-volume benchmark runs with lots of metrics.
- **Preserves the good instincts of the old system**:
  - Worker threads for Sheets I/O.
  - Separation of blocking and non-blocking operations.
  - Header/key-driven mapping instead of brittle column indices.
  - Dynamic column creation for new AIDA fields.
- **Introduces a clean abstraction**:
  - A `DatastoreAdapter` with domain-centric commands.
  - A composite backend that dual-writes to Sheets and local JSON.
- **Provides a safe path forward**:
  - Runtime backup of everything written to Sheets.
  - Simple, ID-based JSON files for each record.
  - Clear recovery path if Sheets data is damaged.
  - Future extensibility to “real” databases without changing orchestrator logic.

This document should be used as the guiding architecture for implementing the new datastore layer in AutoBench98, with freedom to adjust naming and concrete details as the actual code structure evolves.
