# Autobench98 FFmpeg Sidecar Design

## 1. Purpose and Scope

This document describes the design of the **FFmpeg sidecar** used by Autobench98 for video capture, streaming, recording, and related post‑processing tasks.

It is intended to be:

- **Human-readable**: for developers implementing or modifying the sidecar.
- **Model-readable**: structured and explicit enough that an AI can use it as grounding when generating code or reasoning about changes.

The design is a refactor and extraction of an earlier, in-process implementation that used worker threads and Express routes. The goal is to preserve the valid behaviors of that implementation while isolating all FFmpeg- and device-related responsibilities into a dedicated sidecar process.

---

## 2. High-Level Responsibilities

The sidecar is a **single-purpose Node.js service** that owns all interaction with the video capture device and FFmpeg. It provides:

1. **Capture / Preview Stream**
   - Owns the capture device (e.g., `/dev/video0`) and runs FFmpeg to produce a continuous stream.
   - Extracts individual JPEG frames from the FFmpeg byte stream.
   - Serves an **MJPEG HTTP stream** to one or more clients.
   - Tracks capture statistics (fps, time, bitrate, etc.) from FFmpeg stderr.

2. **Recording Management**
   - Records video from the live stream (or directly from the device) into MP4 files.
   - Supports **multiple logical recordings** over the lifetime of the sidecar (0–N recordings), with an eye toward future concurrency (multiple recordings at once).
   - Handles transient failures via segmented recording and recovery.

3. **Post-Processing / Finishing Jobs**
   - Performs operations on completed recordings in **child processes**, including:
     - Adjusting video speed to match wall‑clock duration.
     - Optionally baking subtitles or other overlays into the video.
   - These jobs must not block or interfere with the always-on capture/stream loop.

4. **Status and Health Reporting**
   - Exposes a simple health/status API so the orchestrator can:
     - Confirm the sidecar is up.
     - Fetch basic capture metrics.
     - Inspect recording / post-processing job status.

5. **Optional Screenshot Support (Future-Ready)**
   - Internally tracks the “last frame” from the stream.
   - May expose an endpoint to return a single frame (screenshot) if desired.
   - Orchestrator may alternatively derive screenshots directly from the MJPEG stream and is not required to use a dedicated screenshot endpoint.

The orchestrator **does not** talk directly to `/dev/video*` or FFmpeg. It coordinates **when** to record and **how** the resulting artifacts are named and used, while the sidecar is responsible for **how** video is captured and processed.

---

## 3. Non-Goals

The sidecar is **not** responsible for:

- Any UI or web frontend.
- Business logic for benchmark workflows or orchestration state machines.
- Long-term storage management (e.g., archiving, uploading to cloud storage).
- Semantic understanding of application logs or domain events.
- Advanced authorization / authentication beyond what is needed for the appliance environment.

These concerns belong to the orchestrator or higher-level services.

---

## 4. Process Model

The sidecar is a standalone Node.js process with three main categories of child processes:

1. **Capture Process (Always-On)**
   - A single FFmpeg process that:
     - Reads from the capture device.
     - Produces a JPEG stream over stdout.
   - The main Node process:
     - Parses stdout into individual JPEG frames.
     - Broadcasts frames to connected MJPEG clients.
     - Emits a `newFrame` event and caches the most recent frame.
   - On error/exit, the sidecar automatically restarts FFmpeg with backoff.

2. **Recording Processes (On Demand)**
   - FFmpeg processes spawned to record from the sidecar’s own stream endpoint (or directly from the device pipeline).
   - Each logical recording gets its own FFmpeg child:
     - Input: sidecar stream URL (e.g., `http://localhost:<port>/stream.mjpeg`) or device input.
     - Output: `outputPath/<filename>_segment_<N>.mp4` segment files (see segmented recording below).

3. **Finishing / Post-Processing Processes (On Demand)**
   - FFmpeg processes spawned to operate on completed recordings:
     - Concatenate segments into a single file.
     - Adjust playback speed (using `setpts`) to align with measured duration.
     - Optionally apply subtitles / overlays.

All heavy FFmpeg work runs in child processes, keeping the main Node event loop responsive and the capture pipeline stable.

---

## 5. External API (HTTP)

The sidecar exposes a small HTTP API. The framework is intentionally minimal (vanilla Node `http` or a lightweight router); Fastify is not required here.

### 5.1 Base URL

The sidecar listens on a configurable host/port, e.g.:

- `http://localhost:3100` (example; actual port is configurable).

### 5.2 Endpoints

#### 5.2.1 Live Stream

- **`GET /stream`**  
  Returns an MJPEG stream sourced from the capture device.

  **Behavior:**
  - Content-Type: `multipart/x-mixed-replace; boundary=--frameboundary`
  - Each frame written as:
    ```
    --frameboundary

    Content-Type: image/jpeg


    <binary JPEG bytes>

    ```
  - Connections are kept open until client disconnect or sidecar shutdown.
  - Max concurrent clients limited (configurable, default ~100).

#### 5.2.2 Health / Status

- **`GET /health`**  
  Lightweight health check.

  **Response example:**
  ```json
  {
    "status": "ok",
    "capture": {
      "running": true,
      "lastFrameAgeMs": 42,
      "fps": "29.97",
      "bitrate": "4000kbits/s",
      "time": "00:00:34.21"
    }
  }
  ```

- **`GET /status`** (optional extended status)  
  Can include recording and job state:

  ```json
  {
    "capture": { ... },
    "recordings": {
      "active": [
        { "id": "run-123", "state": "recording", "startedAt": "...", "segmentCount": 3 }
      ],
      "recent": [
        { "id": "run-122", "state": "finished", "outputPath": "/captures/run-122-final.mp4" }
      ]
    },
    "jobs": [
      { "id": "job-abc", "type": "finish", "state": "running", "recordingId": "run-122" }
    ]
  }
  ```

#### 5.2.3 Recording Control

**Start a recording**

- **`POST /recordings/start`**

  **Request body:**
  ```json
  {
    "id": "run-123",          // Optional; if omitted, sidecar generates an ID
    "filename": "run-123",    // Base filename (without extension)
    "outputPath": "/captures" // Optional; if omitted, sidecar uses default
  }
  ```

  **Behavior:**
  - Creates a logical recording entry.
  - Spawns a recording FFmpeg process that:
    - Reads from the sidecar’s stream URL or direct device pipeline.
    - Writes to segment files: `<outputPath>/<filename>_segment_0.mp4`, `_segment_1.mp4`, ...
    - Uses `libx264` with a reasonable quality preset (e.g., `-crf 23`).
    - Uses reconnect options for robustness.

  **Response example:**
  ```json
  {
    "recordingId": "run-123",
    "state": "recording",
    "outputPath": "/captures",
    "filename": "run-123"
  }
  ```

**Stop a recording (complete and finish)**

- **`POST /recordings/:id/stop`**

  **Behavior:**
  - Marks the recording as “end requested”.
  - Signals the recording FFmpeg process to exit gracefully (e.g., SIGINT).
  - On process exit:
    - Records `endTime`.
    - Spawns a finishing job to merge segments and adjust speed.
  - Returns a brief acknowledgment and/or status snapshot.

  **Response example:**
  ```json
  {
    "recordingId": "run-123",
    "state": "finishing"
  }
  ```

**Abort a recording (discard segments)**

- **`POST /recordings/:id/halt`** (optional, but mirrors the old code’s behavior)

  **Behavior:**
  - Marks the recording as “halt requested”.
  - Sends a halt signal to the recording FFmpeg process.
  - On process exit:
    - Deletes all segment files for that recording.
  - Marks recording as `aborted`.

  **Response example:**
  ```json
  {
    "recordingId": "run-123",
    "state": "aborted"
  }
  ```

**Query recording status**

- **`GET /recordings/:id/status`**

  **Response example:**
  ```json
  {
    "recordingId": "run-123",
    "state": "finishing",
    "startedAt": "...",
    "endedAt": "...",
    "outputPath": "/captures",
    "filename": "run-123",
    "segments": 4,
    "jobs": [
      { "id": "job-xyz", "type": "merge", "state": "completed" },
      { "id": "job-uvw", "type": "speedAdjust", "state": "running" }
    ]
  }
  ```

#### 5.2.4 Screenshot (Optional)

- **`GET /screenshot`** (or `/screenshot/main`)

  **Behavior:**
  - Returns a single JPEG frame.
  - Implementation options:
    - Directly return the cached `lastFrame` from the capture pipeline.
    - Or generate on demand via FFmpeg if not using MJPEG internally.

  **Response headers:**
  - `Content-Type: image/jpeg`

The orchestrator is free to **ignore this endpoint** and instead derive screenshots directly from the MJPEG stream; the API is designed to be optional.

---

## 6. Internal Components

### 6.1 Capture Pipeline

**Responsibilities:**

- Start and supervise the always-on FFmpeg process that reads from the capture device.
- Parse stdout into individual JPEG frames.
- Emit a `newFrame` event with `(Buffer frame, timestamp)`.
- Broadcast frames to all connected MJPEG clients.
- Parse FFmpeg stderr to extract capture status metrics.

**Key behaviors inspired by old code:**

- FFmpeg is started with arguments from `FFMPEG_ARGS`:
  - Example: device, resolution, framerate, JPEG output to `pipe:`.
- JPEG detection:
  - Look for start-of-image marker `0xFF 0xD8` and end-of-image marker `0xFF 0xD9`.
  - Accumulate chunks in a buffer until a full frame is detected.
- Client management:
  - Maintain an array of active `Response` objects (`audienceResponses`).
  - On each frame:
    - Write multipart boundary + headers + JPEG bytes to all responses.
  - Clean up responses on client disconnect/error.
  - Enforce a configurable `MAX_CLIENTS`.

**Resilience:**

- On `ffmpeg` error:
  - Log error.
  - Optionally restart process with backoff.
- On `close`:
  - Log exit code.
  - Restart capture unless sidecar is shutting down.

### 6.2 Recording Manager

**Responsibilities:**

- Track active and completed recordings.
- Spawn and supervise recording FFmpeg processes.
- Handle segmented recording and recovery.

**Data structure (conceptual):**

```ts
type RecordingState = {
  id: string;
  filename: string;
  outputPath: string;
  startedAt: Date;
  endedAt?: Date;
  segments: number;
  status: 'recording' | 'finishing' | 'completed' | 'aborted' | 'error';
  process?: ChildProcess;
};
```

**Segmented Recording Logic (from old code):**

- When a recording starts:
  - Set `segmentNumber = 0`.
  - Start FFmpeg to record from `streamUrl` to `<filename>_segment_0.mp4`.
  - Use reconnect-friendly input options:
    - `-rtbufsize 100M`
    - `-reconnect 1`
    - `-reconnect_streamed 1`
    - `-reconnect_delay_max 5`
  - Use `libx264` with `-crf 23` or similar.

- On FFmpeg `error` or `end`:
  - If recording was intentionally ended (`end` requested):
    - Stop segmenting; move to finishing jobs (merge, speed adjust, etc.).
  - If recording was intentionally halted (`halt` requested):
    - Delete all segment files.
  - If recording stopped unintentionally:
    - Log the interruption.
    - Increment `segmentNumber`.
    - Start a new segment (`_segment_1`, `_segment_2`, ...).

This allows long recordings to survive transient errors, with segments later merged into a single output.

### 6.3 Finishing / Post-Processing Jobs

Once a recording is stopped (end requested), the sidecar runs post-processing jobs in sequence, each in its own child process:

1. **Segment Merge Job**

   - Reads the directory for segment files matching `${filename}_segment_<N>.mp4`.
   - Generates a temporary file list for FFmpeg concat:
     ```
     file '/path/to/filename_segment_0.mp4'
     file '/path/to/filename_segment_1.mp4'
     ...
     ```
   - Runs FFmpeg concat demuxer:
     - `ffmpeg -f concat -safe 0 -i filelist.txt -c copy outputFile.mp4`
   - On success:
     - Deletes segment files and the temp list.
     - Marks merged output as the main recording file.

2. **Speed Adjustment Job**

   - Takes the merged output file and measured `startTime`/`endTime`.
   - Computes desired duration in milliseconds.
   - Measures current video duration via `ffprobe`.
   - Computes a `speedRatio` and applies a `setpts` filter:
     - Example: `-filter:v setpts=<speedRatio>*PTS -an`
   - Uses a temporary `.temp` file rename pattern to keep the final filename stable.
   - On success:
     - Deletes the temporary input file.
   - On failure:
     - Renames the temp file back to original (best-effort recovery).

3. **Subtitles / Overlays Job (Optional)**

   - If the orchestrator provides an SRT file or equivalent:
     - Use FFmpeg `subtitles=` filter to bake the text into the video.
   - The sidecar itself should treat subtitle content as opaque; it just applies the filter.

**Important:**  
These jobs must be **queued and limited** so that only a small number of heavy FFmpeg jobs run in parallel, preventing starvation of the capture process.

### 6.4 Screenshot / Last Frame Cache

Even if the sidecar does not expose a `/screenshot` endpoint initially, it should:

- Cache the most recent frame (`Buffer`) and timestamp from the capture pipeline.
- Optionally provide an internal or future API to return this frame as a screenshot.

This mirrors the old `StreamService.getMostRecentFrame()` behavior and provides flexibility for future use cases.

---

## 7. Interaction with Orchestrator

### 7.1 Orchestrator Responsibilities

The orchestrator:

- Decides **when** to start and stop recordings.
- Provides logical names/IDs for recordings.
- Consumes sidecar status to surface health/metrics in the UI.
- Manages domain-specific metadata (logs, run IDs, case IDs, etc.).
- Optionally prepares subtitle data (as SRT) and instructs sidecar to apply it.

### 7.2 Typical Flow

1. Orchestrator checks sidecar health:
   - `GET /health` → ensures capture pipeline is running.

2. Orchestrator starts a recording:
   - `POST /recordings/start` with `{ id, filename }`.
   - Receives `recordingId` and initial state.

3. During a benchmark run, live preview is shown using:
   - `GET /stream` embedded in the web UI as MJPEG.

4. When the benchmark finishes:
   - Orchestrator calls `POST /recordings/:id/stop`.
   - Sidecar finishes the recording and runs post-processing jobs.

5. Orchestrator polls or subscribes for recording status:
   - `GET /recordings/:id/status` until `state == "completed"`.
   - Reads `outputPath`/`filename` and stores those in its domain objects.

6. Optional:
   - Orchestrator generates SRT from logs and sends it to a dedicated endpoint to trigger a subtitles job.

---

## 8. Configuration

Key configuration options (via environment variables or config file):

- `FFMPEG_ARGS`  
  Base arguments for the capture FFmpeg process (device, resolution, fps, etc.). The sidecar appends `pipe:` to write JPEG to stdout.

- `CAPTURE_DEVICE` (optional)  
  Explicit device path; if present, the sidecar can construct `FFMPEG_ARGS` itself.

- `SIDECAR_PORT`  
  Port for HTTP server.

- `MAX_CLIENTS`  
  Maximum number of concurrent stream clients.

- `CAPTURES_DIR`  
  Base directory for recordings.

- Resource limits for post-processing jobs:
  - `MAX_CONCURRENT_JOBS`
  - `MAX_CONCURRENT_RECORDINGS`

- Logging verbosity level.

---

## 9. Observability

The sidecar should log the following:

- Capture lifecycle:
  - FFmpeg spawn arguments (sanitized).
  - Capture start, restarts, and termination codes.
- Recording lifecycle:
  - Recording start (`recordingId`, filename, output path).
  - Segment transitions and unexpected interruptions.
  - Successful completion, aborts, or errors.
- Job lifecycle:
  - Job creation, start, completion, failure (including stderr when safe).

Metrics (if integrated):
- Current fps, bitrate, frame count from FFmpeg.
- Number of connected clients.
- Number of active recordings.
- Number of running jobs.

These can be exposed in `/status` or exported via a metrics endpoint if desired.

---

## 10. Error Handling and Failure Modes

Key failure cases and responses:

1. **Capture FFmpeg process crashes or fails to start**
   - Sidecar logs error.
   - Sets `capture.running = false` in health/status.
   - Attempts restart with backoff.
   - `/stream` requests may fail or block until capture resumes.

2. **Recording FFmpeg process crashes unexpectedly**
   - If `end` or `halt` was not requested:
     - Treat as unintentional interruption.
     - Start a new segment (`_segment_N+1`) if recording is still logically active.
   - If interruption persists beyond a threshold:
     - Mark recording as `error`.
     - Report via status API.

3. **Finishing job fails (merge or speed adjust)**
   - Mark job as `error` with message.
   - Recording may still have partial output (e.g., merged but not speed-adjusted).
   - Sidecar reports job state; orchestrator decides how to handle.

4. **Disk space issues**
   - FFmpeg failures will surface as errors.
   - Sidecar should log clearly and mark recordings/jobs as failed.
   - Out of scope for this design: automated cleanup policies.

5. **Too many concurrent clients or recordings**
   - Enforced via `MAX_CLIENTS` and `MAX_CONCURRENT_RECORDINGS`.
   - Sidecar should return a 429-style error for new requests when limits are exceeded.

---

## 11. Implementation Notes

- **Language/Runtime**: Node.js (version aligned with main project, e.g., Node 20+).
- **HTTP Layer**: vanilla `http` module, or a very small router; no dependency on Fastify is required.
- **Process Management**: `child_process.spawn` for FFmpeg and post-processing jobs.
- **Code Organization** (suggested):
  - `src/capture/` – capture pipeline and MJPEG streaming.
  - `src/recordings/` – recording manager and state.
  - `src/jobs/` – finishing jobs (merge, speed adjust, subtitles).
  - `src/api/` – HTTP endpoints and routing.
  - `src/config/` – configuration loading and validation.
  - `src/log/` – logging helpers.

---

## 12. Future Extensions

The design intentionally leaves room for:

- Additional output formats (e.g., HLS stream alongside MJPEG).
- Thumbnail or preview image generation as a background job.
- Hardware-accelerated encoding, if the platform allows (e.g., NVENC).
- A richer job engine (priority queues, retries, etc.).
- Optional `/screenshot` endpoint backed by `lastFrame` or a lightweight on-demand FFmpeg invocation.

All such enhancements should preserve the core principle:  
**The sidecar fully owns the video device and FFmpeg, and the orchestrator remains focused on orchestration and domain logic.**

---

## 13. Deployment and Local Launcher

### 13.1 Project Layout

The sidecar lives inside the monorepo under:

- `services/sidecar-ffmpeg` – this FFmpeg sidecar (the service described in this document).
- `services/orchestrator` – the main Fastify-based orchestrator service.

Both are **host-run Node applications**. Docker is **not** used for local development or normal operation in the current design.

### 13.2 Launch Script (Linux / macOS)

A top-level launcher script is responsible for building and starting both services on the host (no containers). At a high level, it:

1. Runs from the repo root and:
   - Validates required tools (`node`, `npm`, `npx`, and either `lsof` or `ss`).
   - Optionally syncs `.env.production` → `.env` and loads environment variables.
   - Ensures certain helper binaries/scripts (e.g., CF imager, WattsUp) are executable.
   - Ensures `CF_IMAGER_ROOT` and `DATA_DIR` exist and are writable.

2. Builds shared packages and the web app via npm workspaces:
   - `npm -w packages/logging run build`
   - `npm -w apps/web run build`

3. Checks port availability:
   - `SIDECAR_PORT` (defaults to `3100` if not set).
   - `API_PORT` for the orchestrator (defaults to `3000` if not set).

4. Starts both services as host processes:
   - Sidecar:
     ```bash
     cd services/sidecar-ffmpeg
     node src/server.js
     ```
   - Orchestrator:
     ```bash
     cd services/orchestrator
     export DATA_DIR SERIAL_SUMMARY_MS
     npx tsx src/server.ts
     ```

5. Tracks both PIDs, and on Ctrl+C or termination:
   - Performs a **graceful shutdown**, killing the entire process groups for the orchestrator and sidecar with a helper `kill_tree` function.

### 13.3 Runtime Assumptions

- The sidecar reads `SIDECAR_PORT` from the environment (default `3100`) and binds its HTTP server to `localhost:SIDECAR_PORT`.
- The orchestrator reads `API_PORT` (default `3000`) and assumes the sidecar is reachable at `http://localhost:${SIDECAR_PORT}`.
- Environment variables such as `FFMPEG_ARGS`, `CAPTURES_DIR`, and others described in this design are typically configured via `.env` / `.env.production` and loaded by the launcher.
- The working directory for the sidecar process is `services/sidecar-ffmpeg`.

This section supersedes any older container-based or Docker-compose-based notions of deployment from previous design documents. The canonical deployment model for this sidecar in Autobench98 is **host processes launched via the shared bash script**, with the orchestrator and sidecar as sibling services within the `services/` directory.
