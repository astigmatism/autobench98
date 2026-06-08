# AutoBench 98 Benchmark Runner Scaffold

## Architecture analysis summary

The current backend is a Fastify orchestrator in `services/orchestrator/src`. `app.ts` creates the shared Fastify instance, decorates the shared client log buffer, registers serial discovery first, then registers the result sinks, WebSocket/state transport, layouts routes, device plugins, the FFmpeg sidecar proxy, and now the benchmark runner plugin.

The server already has a central AppState store in `core/state.ts`. State updates are emitted as snapshot and JSON-patch events through `stateEvents`; `plugins/ws.ts` broadcasts those snapshots/patches and the shared client log buffer to Studio clients. This is the correct event/status path for benchmark runner state because it is already used by the hardware services and avoids creating a second event system.

Keyboard input currently lives in `devices/ps2-keyboard/PS2KeyboardService.ts`, with state projection in `adapters/ps2Keyboard.adapter.ts` and Fastify registration in `plugins/ps2Keyboard.ts`. WebSocket keyboard commands are translated in `plugins/ws.ts` into `PS2KeyboardService.enqueueKeyEvent(...)`. The benchmark runner uses the same service-level API through `core/benchmarks/keyboard-input.adapter.ts` rather than writing directly to serial hardware.

Mouse input exists through `devices/ps2-mouse/*`, `adapters/ps2Mouse.adapter.ts`, `plugins/ps2Mouse.ts`, and WS command handling in `plugins/ws.ts`. This scaffold does not add mouse benchmark steps yet.

Screen capture is owned by the separate `services/sidecar-ffmpeg` service. It exposes `/stream`, `/health`, and `/screenshot`; the orchestrator already proxies `/stream` and `/health` through `plugins/streamProxy.ts`. The benchmark runner reads screenshots server-side from the sidecar `/screenshot` endpoint through `SidecarScreenAnalysisAdapter`.

Serial discovery and hardware readiness live in `plugins/serial.ts` and `core/serial/SerialDiscoveryService.ts`. Device plugins expose services on the Fastify instance. The benchmark runner is intentionally layered above those services and does not modify serial discovery or hardware control behavior.

## Recommended location

The benchmark runner lives under `services/orchestrator/src/core/benchmarks` with a Fastify integration plugin at `services/orchestrator/src/plugins/benchmarks.ts`.

That location was chosen because the runner is not a low-level device, not a UI pane, and not a Google Sheets sink. It is controller-level orchestration that coordinates existing device/capture services. The project already uses this pattern: device services emit domain events, adapters project events into AppState, plugins wire services into Fastify, and WebSocket broadcasts AppState/logs.

## Files and responsibilities

- `core/benchmarks/types.ts` defines recipe, step, runner state, event, adapter, and result contracts.
- `core/benchmarks/recipe-validator.ts` validates and normalizes version-1 JSON recipes.
- `core/benchmarks/BenchmarkRunner.ts` owns one active run, executes ordered steps, applies failure behavior, emits benchmark events, and supports cancellation.
- `core/benchmarks/keyboard-input.adapter.ts` converts benchmark keyboard steps into PS/2 keyboard service operations.
- `core/benchmarks/screen-analysis.adapter.ts` reads sidecar screenshots and provides placeholder image/static comparison boundaries.
- `adapters/benchmarkRunner.adapter.ts` maps benchmark runner events into the `benchmarkRunner` AppState slice.
- `plugins/benchmarks.ts` wires the runner into Fastify and exposes minimal HTTP endpoints.
- `core/state.ts` now includes a `benchmarkRunner` AppState slice so Studio clients can observe runs through the existing WebSocket state channel.

## Recipe schema v1

Recipes are JSON objects with this baseline shape:

```json
{
  "schemaVersion": 1,
  "id": "string",
  "name": "string",
  "description": "optional string",
  "defaults": {
    "stepTimeoutMs": 30000,
    "onFailure": "abort",
    "retry": {
      "maxAttempts": 2,
      "delayMs": 1000
    }
  },
  "metadata": {},
  "steps": []
}
```

`schemaVersion` must be `1`. `id`, `name`, and a non-empty `steps` array are required. Step ids are optional in input and default to `step-1`, `step-2`, etc., but explicit ids are recommended. Duplicate step ids are rejected.

Supported `onFailure` values are:

- `abort`: fail the run after the step fails.
- `continue`: record the step failure and continue to the next step.
- `retry`: retry the step according to `retry.maxAttempts` and `retry.delayMs`; `maxAttempts` is total attempts including the first attempt.

## Supported step types

### `wait`

Waits for a fixed duration without blocking the Node.js event loop.

```json
{
  "id": "settle",
  "type": "wait",
  "durationMs": 5000
}
```

### `keyboard.typeText`

Types a string through the PS/2 keyboard service. The adapter supports a practical US-keyboard ASCII map for letters, digits, whitespace, and common punctuation. Shifted characters are implemented by holding and releasing `ShiftLeft` around the keypress.

```json
{
  "id": "type-command",
  "type": "keyboard.typeText",
  "text": "C:\\QUAKE\\WINQUAKE.EXE",
  "interKeyDelayMs": 40
}
```

### `keyboard.key`

Sends one key action. The default action is `press`; `hold` and `release` are scaffolded for future macro flows.

```json
{
  "id": "press-enter",
  "type": "keyboard.key",
  "key": "ENTER"
}
```

### `keyboard.hotkey`

Holds all keys except the last as modifiers, presses the final key, then releases modifiers in reverse order. Supported modifier aliases include `CTRL`, `CONTROL`, `SHIFT`, `ALT`, `META`, `WIN`, and `WINDOWS`.

```json
{
  "id": "open-run-dialog",
  "type": "keyboard.hotkey",
  "keys": ["META", "R"]
}
```

### `screen.waitForImageMatch`

Polls sidecar screenshots until the current encoded frame is similar enough to a reference image or the timeout expires.

```json
{
  "id": "wait-for-desktop",
  "type": "screen.waitForImageMatch",
  "referenceImage": "references/windows98-desktop.png",
  "threshold": 0.92,
  "timeoutMs": 30000
}
```

The current implementation is an explicit placeholder: it compares encoded image bytes and length, not decoded pixels. It exists to exercise the orchestration boundary. A future implementation should replace `SidecarScreenAnalysisAdapter` with real image decoding, region masks, and SSIM/template matching.

### `screen.waitForStatic`

Polls sidecar screenshots until consecutive encoded frames remain within a configured difference threshold for the requested stable duration.

```json
{
  "id": "wait-for-benchmark-to-settle",
  "type": "screen.waitForStatic",
  "stableDurationMs": 3000,
  "differenceThreshold": 0.03,
  "timeoutMs": 60000
}
```

This is also a placeholder comparison over encoded JPEG bytes. It can demonstrate the runner loop today, but it should be replaced with pixel-level frame comparison for robust benchmark completion/freeze detection.

## Runner state

`AppState.benchmarkRunner.phase` may be one of:

- `idle`
- `loading-recipe`
- `running`
- `waiting`
- `watching-screen`
- `sending-input`
- `step-succeeded`
- `step-failed`
- `run-failed`
- `run-completed`
- `cancelled`

The state slice also includes the current run id, recipe id/name, current step, last step result, last error, counters, cancellation flag, and a bounded event history.

## Event/status emission

The runner emits typed benchmark events into a local event sink. `plugins/benchmarks.ts` fans those events out to:

1. `LogChannel.benchmark`, visible in the existing logs stream.
2. `BenchmarkRunnerStateAdapter`, which updates `AppState.benchmarkRunner`.

Because the existing WebSocket plugin already broadcasts AppState snapshots/patches, Studio clients can observe the runner without a new event bus.

Emitted event kinds include:

- `benchmark-run-loading`
- `benchmark-run-started`
- `benchmark-step-started`
- `benchmark-step-completed`
- `benchmark-step-failed`
- `benchmark-run-failed`
- `benchmark-run-completed`
- `benchmark-run-cancelled`

## API scaffold

The plugin adds the smallest useful HTTP surface:

```text
POST /api/benchmarks/validate
POST /api/benchmarks/runs
GET  /api/benchmarks/runs/current
POST /api/benchmarks/runs/current/cancel
```

`POST /api/benchmarks/validate` accepts either the recipe JSON directly or `{ "recipe": { ... } }` and returns the normalized recipe or validation errors.

`POST /api/benchmarks/runs` validates the recipe and starts a run asynchronously. Only one run may be active at a time. The endpoint returns quickly with the run id and current state; progress is observed through WebSocket/AppState or `GET /api/benchmarks/runs/current`.

`POST /api/benchmarks/runs/current/cancel` aborts the current run and calls `keyboard.cancelAll(...)` best-effort.

## Example recipe

See `services/orchestrator/examples/benchmark-recipes/quake-640x480-smoke.json`.

## Keyboard routing

Benchmark keyboard steps are routed like this:

```text
BenchmarkRunner
  -> PS2KeyboardBenchmarkInputAdapter
  -> app.ps2Keyboard.enqueueKeyEvent(...)
  -> PS2KeyboardService queue
  -> Arduino PS/2 keyboard serial protocol
```

The runner does not access serial ports or scan codes directly.

## Screen readback routing

Benchmark screen steps are routed like this:

```text
BenchmarkRunner
  -> SidecarScreenAnalysisAdapter
  -> http://127.0.0.1:$SIDECAR_PORT/screenshot
  -> latest sidecar FFmpeg frame
```

By default, reference images are resolved relative to:

```text
$BENCHMARK_ASSET_ROOT
```

If that variable is unset, the orchestrator uses:

```text
$DATA_DIR/benchmark-assets
```

with `DATA_DIR` defaulting to `/app/data`.

## Failure handling

Each step resolves into a structured `BenchmarkStepRunResult`. Failures carry:

- `code`
- `message`
- `fatal`
- `retryable`
- optional `detail`

Failure policy is resolved as:

```text
step.onFailure -> recipe.defaults.onFailure -> abort
```

Retry policy is resolved as:

```text
step.retry -> recipe.defaults.retry -> { maxAttempts: 2, delayMs: 1000 }
```

The current scaffold does not implement a complex policy engine, branching, pass-level failure marking, or fallback step graphs. Those should be added after the final recipe model stabilizes.

## How to start/test a scaffold run

From the repository root, after installing workspace dependencies and starting the orchestrator:

```bash
curl -s http://127.0.0.1:3000/api/benchmarks/validate \
  -H 'content-type: application/json' \
  --data-binary @services/orchestrator/examples/benchmark-recipes/quake-640x480-smoke.json
```

Start the example run:

```bash
curl -s http://127.0.0.1:3000/api/benchmarks/runs \
  -H 'content-type: application/json' \
  --data-binary @services/orchestrator/examples/benchmark-recipes/quake-640x480-smoke.json
```

Check current state:

```bash
curl -s http://127.0.0.1:3000/api/benchmarks/runs/current
```

Cancel a run:

```bash
curl -s http://127.0.0.1:3000/api/benchmarks/runs/current/cancel \
  -H 'content-type: application/json' \
  -d '{"reason":"operator cancelled smoke test"}'
```

For a hardware-free smoke test, use a recipe that only contains `wait` steps. Keyboard steps require the PS/2 keyboard service to be attached. Screen steps require the sidecar to have a recent screenshot.

## Future implementation notes

- Replace encoded-byte screen comparison with a real image decoder and SSIM/template matching.
- Add region/crop/mask support for image matching and static detection.
- Add OCR extraction steps once OCR utilities exist under `detection/ocr`.
- Add mouse steps through the existing PS/2 mouse service.
- Add recipe persistence only after deciding whether recipes live in local files, Sheets, SQLite, or another datastore.
- Add a UI pane after the API/state model proves stable.
- Add artifact capture and result publication through the existing result sink interfaces.
- Add branching/fallback DAG support only after the linear v1 runner has been exercised against real benchmarks.
