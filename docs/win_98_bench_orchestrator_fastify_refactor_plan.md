# Win98 Bench Orchestrator — Fastify Refactor Plan

> Goal: Rebuild the benchmarking orchestrator around **Fastify** with a clean, Windows‑98‑only focus, robust device management, externalized “recipes,” and strong fallbacks/reconciliation. Ship as a Docker composition with a separate view app.

---

## 1) System Topology (Docker)

**Services**
- **orchestrator** (Fastify, Node 20+): device control, workflow engine, recipe runner, screen/ocr workers, event log API, WS.
- **view** (friend app): UI (Vite/React/Svelte), connects to orchestrator via REST/WS for state/stream.
- **recorder** (**FFmpeg sidecar**, separate container): manages capture pipelines, recording, and HLS/MJPEG serving; exposes a tiny control API to the orchestrator. Failure‑isolated with its own supervisor.
- **redis**: required for job queues, pub/sub fan‑out, durable state diff buffers, distributed locks.

**Volumes**
- `/data/videos` (recordings)
- `/data/logs` (structured logs)
- `/data/recipes` (YAML recipes + assets)

**Ports**
- orchestrator: 8080 (REST/WS), 8090 (MJPEG/HLS proxy if needed)
- view: 3000
- recorder: 8099 (control), 8100 (HLS), 8101 (MJPEG)

**Dev ergonomics**: hot-reload via `nodemon`/`ts-node-dev` for orchestrator and Vite for the view.

---

## 2) Bounded Contexts & Module Boundaries

```
packages/orchestrator/src
  app.ts                   # Fastify bootstrap
  plugins/
    routes.*.ts            # HTTP routes grouped by feature
    ws.ts                  # WebSocket events
    health.ts              # liveness/readiness
  core/
    events/                # Typed event bus + pub/sub
    state/                 # In-memory state, projections, cache
    jobs/                  # Job runner + DAG compiler
    recipes/               # Parser, validator, resolver
    scheduler/             # Queue construction from user selections
    persistence/           # SQLite (Drizzle) event store + projections
    supervision/           # Process & device supervisors
    telemetry/             # pino logger, metrics
  devices/
    frontpanel/            # Arduino serial adapter + commands
    ps2keyboard/           # PS/2 keyboard serial adapter
    ps2mouse/              # PS/2 mouse serial adapter
    stream/                # capture, frame bus, health
  detection/
    screens/               # SSIM matching, mask/crop support
    ocr/                   # Tesseract workers
  domain/
    win98/                 # Win98-specific commands, paths, sprites, screens
    benchmarks/            # shared high-level benchmark helpers
```

**Principles**
- **Single responsibility** per package.
- **Windows‑98 specific** naming in `domain/win98/*`; drop cross‑OS abstraction.
- **Dependency injection** via factory functions; no hard singletons.
- **Typed messages** across boundaries.

---

## 3) Device Supervisors & Reconciliation

Each hardware integration runs under a **Supervisor** with these behaviors:
- **Desired/Observed Model**: keep a desired state object (e.g., `{"stream": "RUNNING"}`) and continuously reconcile with observed.
- **Probes**: cheap health checks on an interval (serial ping, heartbeat frame age, worker queue backlog).
- **Restart Strategy**: exponential backoff, jitter, capped retries; escalate to `DEGRADED` and notify UI.
- **Idempotent (Re)Attach**: reconnect serial ports, reinitialize baud/handshake; for FFmpeg, rebuild process; for Tesseract, recycle workers.
- **Quorum for Healthy**: e.g., stream is healthy **iff** last frame age < threshold **and** FFmpeg PID alive **and** frame checksum varies.

**Stream Liveness**
- `FrameAger`: tracks `now - lastFrameTs`.
- `EntropyGuard`: detects frozen video if frame hash unchanged for N intervals.
- **Auto‑heal**: restart FFmpeg; if N consecutive failures -> flip to `DEGRADED` and notify.

**Serial Devices (front panel / PS2)**
- Start on boot; if unplugged, supervisor attempts detection by vendor/product IDs every T seconds.
- Command queue with **ack/timeout**. On timeout -> requeue with backoff; on 3 failures -> reset port.

---

## 4) Fastify App Skeleton

- **Plugins**:
  - `health`: `/healthz` (liveness), `/readyz` (readiness after devices green or in acceptable degraded state).
  - `recipes`: CRUD for YAML recipes, schema validation.
  - `jobs`: create/run/stop jobs; list history.
  - `devices`: current status, send manual commands (for debugging).
  - `stream`: proxy MJPEG/HLS, latest screenshot endpoint.
  - `events`: WS channel broadcasting typed events.

- **Tooling**: TypeScript + Zod for schemas; Pino for logs; OpenAPI (fastify-swagger) for documentation.

---

## 5) Externalized “Recipe” Format (YAML)

A **declarative** playbook that describes *how* to run a benchmark and *what* success looks like, including fallbacks and recovery.

### YAML Example — Quake II Timedemo
```yaml
apiVersion: win98.bench/v1
kind: Benchmark
metadata:
  name: quake2-timedemo
  title: "Quake II – demo1 640x480"
  tags: ["opengl", "id software"]
spec:
  parameters:
    resolution: { type: string, default: "640x480" }
  assets:
    screens:
      mainmenu: screens/quake2/mainmenu.png
      console: screens/quake2/console.png
      result:  screens/quake2/result.png
  steps:
    - name: ensure-at-desktop
      waitForScreen: screens/win98/desktop.png
      timeout: 30000
      onTimeout: [ { action: rebootFrontPanel }, { action: wait, ms: 60000 } ]
    - name: launch-game
      sendKeys: ["win+r"]
      typeText: "C:\\GAMES\\QUAKE2\\QUAKE2.EXE -width ${resolution.split('x')[0]} -height ${resolution.split('x')[1]}\n"
      waitForScreen: ${assets.screens.mainmenu}
      timeout: 45000
      retries: 2
      onFailure:
        - action: killIfRunning
          process: QUAKE2.EXE
        - action: relaunchStep
    - name: open-console
      sendKeys: ["~"]
      waitForScreen: ${assets.screens.console}
      timeout: 10000
    - name: run-timedemo
      typeText: "timedemo 1; map demo1\n"
      waitForScreen: ${assets.screens.result}
      timeout: 300000
      extract:
        fps: { ocr: { region: { x: 540, y: 420, w: 90, h: 20 } } }
      record:
        includeScreenshot: true
        includeVideo: true
  outputs:
    metrics:
      fps: { unit: "fps", format: "0.00" }
    artifacts:
      - screenshot
      - video
```

### Error Handling Primitives
- `retries`, `timeout`, `onTimeout`, `onFailure`, `relaunchStep`, `rollback`, `rebootFrontPanel`, `powerCycle` (via smart plug), `killIfRunning`, `wait`, `goto:<step>` (limited, to avoid spaghetti), `markDegraded`.

### Variables & Templating
- `${parameters.*}` and `${assets.*}` placeholders; safe eval for simple expressions.

### Validation
- Zod/JSON Schema validation at load time; referential integrity for screens/assets.

---

## 6) Execution Engine (DAG over FSMs)

**Model**
- Each recipe compiles to a **DAG** of **Steps** (nodes) with **Edges** labeled by outcomes (`ok`, `timeout`, `failure`).
- A **Workflow FSM** runs a job instance; each step runs an atomic command (or small macro) and emits an outcome.
- **Idempotent retries** with backoff per step; step timers for precise accounting.

**Why DAG (vs Linked List)**
- Natural branching for fallbacks and recovery without ad‑hoc `if` ladders.
- Supports **skips** and **retries** without mutating a list pointer.
- Enables compile‑time checks: unreachable steps, cycles, missing assets.

**Scheduler**
- User selects a set of benchmarks (UI playlist) → compiler builds a **JobSet** (ordered queue) with per‑job parameters.
- Default FIFO with priorities; optional parallelism = 1 (serial) for Win98; but engine supports >1 for future.

---

## 7) Screen Matching & OCR Workers

- **Workers**: Node Worker Threads pool with task queue.
- **APIs**
  - `matchScreen(image, template, {region, threshold}) -> {score, ok}`
  - `readText(image, {region, whitelist}) -> string`
- **Backpressure**: max in‑flight tasks; caller awaits tokens from a semaphore.
- **Caching**: retain last N frames & their hashes to compare diffs quickly; store last matches per step for diagnostics.

---

## 8) Data Model & Persistence

- **Event Store** (SQLite via Drizzle): append‑only events: `DeviceStateChanged`, `JobStarted`, `StepCompleted`, `MetricExtracted`, `RecordingSaved`, etc.
- **Projections**: materialized views for dashboard, history, flakiness.
- **Artifacts**: path conventions `videos/<jobId>/<step>.mp4`, `screens/<jobId>/<step>.png`.
- **Exports**: CSV/JSON; optional Google Sheets publisher (plugin) decoupled from core.

---

## 9) Observability & Ops

- **Health**: `/healthz` == process up; `/readyz` == all supervisors in `HEALTHY` or allowed `DEGRADED`.
- **Metrics**: step durations, match scores, retries, restarts, stream fps, lastFrameAge.
- **Structured Logs** with correlation IDs for job/step/device.
- **Crash Safety**: on restart, engine restores incomplete job to last *checkpointed step* and continues (or awaits operator).

---

## 10) API Sketch (selected)

- `GET /devices` → status map
- `POST /devices/frontpanel/action` { action: "press", key: "reset" }
- `GET /stream/live.mjpeg` (or HLS)
- `GET /recipes` / `POST /recipes` (upload YAML)
- `POST /jobs` { recipe: "quake2-timedemo", params: {...} }
- `POST /jobs/:id/stop`
- `GET /jobs/:id` → live state, steps, metrics, artifacts
- WS topic: `events` → `JobUpdated`, `SupervisorState`, `LogLine`, `MetricExtracted`

---

## 11) Sample Fastify Plugin Snippets

```ts
// app.ts
import Fastify from 'fastify';
import health from './plugins/health';
import events from './plugins/ws';
import devices from './plugins/devices';
import jobs from './plugins/jobs';
import recipes from './plugins/recipes';

export async function build() {
  const app = Fastify({ logger: true });
  await app.register(health);
  await app.register(events);
  await app.register(devices);
  await app.register(recipes);
  await app.register(jobs);
  return app;
}
```

```ts
// core/jobs/engine.ts (sketch)
export type Outcome = 'ok' | 'timeout' | 'failure';
export interface Step {
  id: string;
  run(ctx: Ctx): Promise<Outcome | { outcome: Outcome; data?: any }>;
  edges: Partial<Record<Outcome, string>>; // next step IDs
  retries?: number; timeoutMs?: number;
}

export async function runWorkflow(startId: string, steps: Map<string, Step>, ctx: Ctx) {
  let current = startId; let attempts = 0;
  while (current) {
    const step = steps.get(current)!;
    const res = await withTimeout(step.run(ctx), step.timeoutMs);
    const outcome = normalize(res);
    if (outcome === 'failure' && attempts < (step.retries ?? 0)) { attempts++; continue; }
    attempts = 0; // reset per step
    current = step.edges[outcome];
  }
}
```

---

## 12) Playlist Construction (Linked List Alternatives)

**Recommended**: **DAG** per benchmark + **Queue** of benchmarks
- Each benchmark is a mini‑DAG (as above).
- The UI “playlist” compiles to a queue of job instances with parameters.

**Other viable options**
1) **Statechart/XState** per benchmark: expressive guards/parallel states; great tooling; little heavier; keep to orchestrator only.
2) **Rule‑driven Planner**: rules map events to next step; flexible but harder to validate.
3) **Temporal/Workflow engines**: overkill for one host, but gains durability. Likely unnecessary here.

**Why not Linked List**
- Poor for error branching & retries; mutating the pointer becomes control flow; debugging is harder.

---

## 12.1) Concurrency & Workers (affirmed)

- Heavy async remains: OCR/SSIM workers, serial I/O, Redis queues, and FFmpeg live in separate threads/processes.
- Backpressure via semaphores on detection tasks; bounded queues with drop/merge strategies for frames.
- Main thread focuses on orchestration and IO—never blocks on CPU‑heavy work.

---

## 13) Windows‑98 Focused Domain

- Hard‑code Win98‑specific screens, paths, windowing quirks, and timing in `domain/win98/*`.
- Remove cross‑OS abstraction layers; prefer precise names: `win98Desktop.png`, `sendCtrlEsc`, `win98RunDialog()` helpers.
- Recipes reference these assets directly.

---

## 14) Fallbacks You Get “For Free”

- Device reconnect & backoff supervisors.
- Stream liveness watchdog with auto‑restart.
- Step‑level retries with alternate branches.
- Global **panic** policy: pause jobs if critical device is `DEGRADED` beyond threshold; resume when healthy.
- **Operator prompts**: recipe step can `awaitOperator` with on‑timeout branch (e.g., power cycle).

---

## 15) Minimal docker‑compose.yml (sketch)

```yaml
services:
  orchestrator:
    build: ./packages/orchestrator
    ports: ["8080:8080", "8090:8090"]
    depends_on: [redis, recorder]
    environment:
      - NODE_ENV=production
      - REDIS_URL=redis://redis:6379
      - RECORDER_BASE_URL=http://recorder:8099
    volumes:
      - ./data/videos:/data/videos
      - ./data/logs:/data/logs
      - ./recipes:/data/recipes
    devices:
      - "/dev/ttyUSB0:/dev/ttyUSB0"
      - "/dev/ttyUSB1:/dev/ttyUSB1"

  recorder:
    build: ./packages/recorder
    ports: ["8099:8099", "8100:8100", "8101:8101"]
    environment:
      - NODE_ENV=production
    volumes:
      - ./data/videos:/data/videos

  view:
    build: ./packages/view
    ports: ["3000:3000"]
    environment:
      - VITE_API_URL=http://localhost:8080

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
```yaml
services:
  orchestrator:
    build: ./packages/orchestrator
    ports: ["8080:8080", "8090:8090"]
    volumes:
      - ./data/videos:/data/videos
      - ./data/logs:/data/logs
      - ./recipes:/data/recipes
    devices:
      - "/dev/ttyUSB0:/dev/ttyUSB0"
      - "/dev/ttyUSB1:/dev/ttyUSB1"
    environment:
      - NODE_ENV=production
  view:
    build: ./packages/view
    ports: ["3000:3000"]
    environment:
      - VITE_API_URL=http://localhost:8080
```

---

## 16) Next Steps / Implementation Order

1) Bootstrap Fastify + health + WS + logging.
2) Implement **Supervisors** for stream + serial; expose `/devices`.
3) Frame bus + liveness watchdog + screenshot endpoint.
4) YAML recipe loader + schema validation + assets resolver.
5) Minimal engine: `sendKeys`, `typeText`, `waitForScreen`, `record`.
6) Persist job events (SQLite); basic dashboard in **view**.
7) Add OCR extract + metrics; export CSV.
8) Add recovery actions: `killIfRunning`, `powerCycle`, `relaunchStep`.
9) Harden: soak tests on flaky stream + serial reconnection.

---

## 16.1) FFmpeg Sidecar Design (decision: sidecar)

- Separate **recorder** service encapsulates FFmpeg processes and pipelines.
- **Control API** (HTTP): `/pipelines`, `/pipelines/:id/start|stop|restart`, `/status`, `/hls/:id/*.m3u8`, `/mjpeg/:id`.
- **Health**: process watchdog + frame entropy guard; restart with exponential backoff.
- **IPC**: Orchestrator issues commands over HTTP; status events also published to Redis pub/sub (`recorder.events`).
- **Why**: failure isolation, easier crash recovery, cleaner logs. Orchestrator only depends on health+URLs.

---

## 16.2) Streaming Format (decision: keep existing)

- Preserve current, proven pipeline (MJPEG and/or HLS) from original project. Recorder supports both; orchestrator consumes via proxy when needed.

---

## 16.3) Redis Usage (decision: yes)

- **BullMQ**: job queues for benchmarks and step workers. Priority, retries, backoff.
- **Pub/Sub Channels**: `state.patch`, `recorder.events`, `devices.state`, `jobs.events` for fan‑out to multiple UI clients.
- **Caching**: frame metadata (hashes, last timestamps), recent screenshots, last job summaries.
- **Distributed Locks**: ensure single control writer to PS/2/front‑panel.
- **Streams (optional)**: persist event logs for replay/resync if WS drops.

---

## 16.4) Pluggable Result Sinks (Google Sheets as primary)

- Define `ResultSink` interface:
  ```ts
  interface ResultSink {
    id: string;
    init(): Promise<void>;
    publish(run: RunSummary, metrics: MetricMap, artifacts: ArtifactRefs): Promise<void>;
    healthy(): Promise<boolean>;
  }
  ```
- **Sinks**: `sheets`, `csv`, `sqlite`, `jsonl`.
- **Config**: enable one or many; `sheets` remains default primary.
- **Mapping**: a small transformer maps internal metrics/tabulations to sink-specific schemas.

---

## 16.5) State Sync Protocol (server ⇄ client)

- **Model**: authoritative in‑memory state tree on server (also projected to Redis for durability).
- **Bootstrap**: on WS connect, client receives `state.full` = full JSON snapshot + `version`.
- **Live updates**: server emits **RFC 6902 JSON Patch** ops (`state.patch`) with `version`+1 increments.
- **Paths**: JSON Pointer paths (e.g., `/devices/stream/status`).
- **Ack & Backfill**: client acks last `version`; on gap, server sends a compact **merge** patch or a `state.full` re‑sync.
- **Selective subscribe**: clients can filter namespaces (e.g., `jobs`, `devices`, `logs`) to reduce traffic.
- **Persistence**: last 5 minutes of patches kept in Redis Stream for reconnect replay.

**Message Types**
```json
{ "type": "state.full", "version": 1024, "data": { /* entire state */ } }
{ "type": "state.patch", "version": 1025, "ops": [ {"op":"replace","path":"/jobs/123/status","value":"running"} ] }
{ "type": "event", "name": "JobUpdated", "data": { /* ... */ } }
{ "type": "log", "level": "info", "msg": "Recorder restarted", "ts": 1730822330000 }
```

---

## 16.6) Logging Architecture (Pino + categories)

- **Pino** with redaction + serializers; log levels by module.
- **Categories**: `devices`, `recorder`, `jobs`, `detect`, `recipes`, `sinks`, `ws`, `http`.
- **Routing**: logs mirrored to Redis Stream `logs` for UI tailing + archival to JSONL on disk.
- **Correlations**: `jobId`, `stepId`, `deviceId`, `traceId` on every record.
- **Views**: UI facets by category/level and timeline heatmap.

---

## 16.7) Updated APIs (selected)

- Orchestrator additions:
  - `GET /state` → full snapshot + version
  - `WS /events` → `state.full`, `state.patch`, `event`, `log`
  - `POST /recorder/pipelines/:id/restart` → proxy to sidecar
- Recorder (sidecar):
  - `GET /status`, `POST /pipelines`, `POST /pipelines/:id/start|stop|restart`
  - `GET /hls/:id/index.m3u8`, `GET /mjpeg/:id`

---

## 17) Open Questions (rev 2)

- Do we want JSON Patch **and** a compact binary patch (e.g., msgpack) for high‑throughput cases?
- Should we promote Redis Streams to the **primary** event log, or keep SQLite event store + project to Streams?
- Any other sinks to prioritize besides Sheets/CSV/SQLite/JSONL?

