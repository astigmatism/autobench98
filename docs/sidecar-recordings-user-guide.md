# Autobench98 FFmpeg Sidecar – Recordings API Guide

This document describes how **recordings** work in the FFmpeg sidecar used by Autobench98, including directory layout, environment variables, and the HTTP API the orchestrator will call.

The goal is that the orchestrator (or any client) can:
- Start one or more recordings
- Stop recordings explicitly
- Query the status of individual recordings
- Clear the recordings workspace when it is safe to do so

---

## 1. Overview

The sidecar exposes a **recordings API** over HTTP on the sidecar host/port:

```text
http://{SIDECAR_HOST}:{SIDECAR_PORT}
```

Key points:

- Recordings are created by **POSTing** to `/recordings/start`.
- Each recording:
  - Reads from the sidecar’s own `/stream` MJPEG endpoint.
  - Is written as a single **MP4 file** under `SIDECAR_RECORDINGS_ROOT`.
  - Has a **stable ID** (UUID) returned in the API response.
- Recordings are stopped by **POSTing** to `/recordings/{id}/stop`.
- The current status is available at **GET** `/recordings/{id}/status`.
- The recordings workspace can be cleared via **POST** `/recordings/clear` (only when no recordings are active).
- Concurrency is limited by an environment variable (`SIDECAR_MAX_RECORDINGS`), defaulting to `2`.

This guide assumes the sidecar is already running and the video capture stream is healthy.

---

## 2. Environment & Configuration

These environment variables, defined in the **root `.env`**, control recording behavior:

```bash
# Path where all recording output will be stored.
# The launch scripts expand ~ and ensure this directory is created and writable.
SIDECAR_RECORDINGS_ROOT=~/autobench98-recordings

# Maximum number of concurrent recordings the sidecar will allow.
# Default is 2. Increase only if host hardware/CPU can handle additional encoders.
SIDECAR_MAX_RECORDINGS=2
```

Other related sidecar env vars (not specific to recordings, but useful context):

```bash
# Maximum number of clients allowed to connect to /stream simultaneously.
# 0 or negative = unlimited (not recommended). Default is 100.
SIDECAR_MAX_STREAM_CLIENTS=100

# Safety cap for maximum buffered MJPEG capture data (in bytes).
# Protects against malformed MJPEG output causing unbounded memory growth.
SIDECAR_MAX_CAPTURE_BUFFER_BYTES=8388608

# FFmpeg arguments for the capture device (do NOT include "pipe:")
FFMPEG_ARGS=-f v4l2 -framerate 60 -input_format nv12 -video_size 1280x1024 -i /dev/video0 -c:v mjpeg -b:v 10M -threads auto -f mjpeg
```

### 2.1 Startup behavior

On startup, the **Linux** and **macOS** launcher scripts:

- Expand `SIDECAR_RECORDINGS_ROOT` (handle `~` properly).
- Create the directory if it doesn’t exist.
- Ensure it is **readable and writable** by the current user.
- **Clear all contents** under `SIDECAR_RECORDINGS_ROOT` (short‑lived workspace).

This means a fresh sidecar start always begins with an **empty recordings directory**.

---

## 3. Directory Layout and File Naming

For each recording, the sidecar creates:

- A **per‑recording directory** under `SIDECAR_RECORDINGS_ROOT`.
- A single MP4 file inside that directory.

### 3.1 Directory name

The directory name is a **slug** derived from:

1. `referenceId` (preferred, if provided); otherwise  
2. `subdir` (if provided); otherwise  
3. The internal recording UUID

Rules:

- Lowercased
- Non-alphanumeric characters → `-`
- Leading/trailing `-` removed
- Max length: 80 chars (longer values are truncated)
- Fallback: the recording UUID if the input slugs to empty

Example:

- `referenceId = "win98-run-001@A"` → directory `win98-run-001-a`
- `subdir = "baseline test #1"` → directory `baseline-test-1`

### 3.2 File name

The file name has the form:

```text
{dirSlug}__{timestamp}.mp4
```

where `{timestamp}` is `YYYYMMDD-HHMMSS` in the sidecar’s local time.

Example:

```text
win98-run-001-a__20251216-192045.mp4
```

Combined with the root and directory, a complete path might be:

```text
/home/user/autobench98-recordings/win98-run-001-a/win98-run-001-a__20251216-192045.mp4
```

The API returns both:

- `outputPath` – absolute path
- `relativePath` – path relative to `SIDECAR_RECORDINGS_ROOT`

---

## 4. Recordings API Summary

Base URL: `http://{SIDECAR_HOST}:{SIDECAR_PORT}`

| Method | Path                       | Description                                         |
|--------|---------------------------|-----------------------------------------------------|
| POST   | `/recordings/start`       | Start a new recording                               |
| POST   | `/recordings/{id}/stop`   | Stop an existing recording                          |
| GET    | `/recordings/{id}/status` | Get the current status of a recording               |
| POST   | `/recordings/clear`       | Clear all files under `SIDECAR_RECORDINGS_ROOT`     |

---

## 5. Start a Recording

**Endpoint**

```http
POST /recordings/start
Content-Type: application/json
```

**Request body fields**

All fields are optional, but **`referenceId` or `runId` is strongly recommended** for discoverability.

- `referenceId` (string, optional)  
  Stable ID from the orchestrator (run id, benchmark id, etc.).  
  - Used as the preferred source for directory/file naming.
- `runId` (string, optional)  
  Legacy/alternate name for `referenceId`. If both are present, `referenceId` wins.
- `label` (string, optional)  
  Human-friendly label attached to the recording (not used for paths).
- `subdir` (string, optional)  
  Explicit directory name override. Used only if `referenceId` is absent.

The orchestrator will usually send at least `referenceId` or `runId`.

**Example request**

```bash
curl -X POST http://localhost:3100/recordings/start       -H "Content-Type: application/json"       -d '{
    "referenceId": "win98-bench-20251216-01",
    "label": "Windows 98 cold boot baseline",
    "subdir": "win98-baseline-run-01"
  }'
```

**Example successful response (201 Created)**

```json
{
  "status": "ok",
  "recording": {
    "id": "a1c5f4a8-2e7a-4e1b-9a6e-8d2c6aa1d9ef",
    "referenceId": "win98-bench-20251216-01",
    "label": "Windows 98 cold boot baseline",
    "state": "recording",
    "dir": "/home/user/autobench98-recordings/win98-baseline-run-01",
    "fileName": "win98-baseline-run-01__20251216-192045.mp4",
    "outputPath": "/home/user/autobench98-recordings/win98-baseline-run-01/win98-baseline-run-01__20251216-192045.mp4",
    "relativePath": "win98-baseline-run-01/win98-baseline-run-01__20251216-192045.mp4",
    "startedAt": "2025-12-16T19:20:45.123Z",
    "stoppedAt": null,
    "durationMs": null,
    "error": null
  }
}
```

**Concurrency limit (429 Too Many Requests)**

If starting this recording would exceed `SIDECAR_MAX_RECORDINGS`, the sidecar responds with:

```json
{
  "status": "error",
  "error": "TooManyRecordings",
  "message": "Maximum concurrent recordings (2) reached (active=2).",
  "maxRecordings": 2
}
```

The orchestrator should treat this as a **hard refusal** to start another recording and can either:
- Queue the request and retry later, or
- Fail the enclosing workflow explicitly.

---

## 6. Stop a Recording

**Endpoint**

```http
POST /recordings/{id}/stop
```

- `id` is the **UUID** returned from `/recordings/start` in `recording.id`.
- This endpoint is **idempotent**: calling it multiple times on the same `id` is safe.

**Example request**

```bash
curl -X POST http://localhost:3100/recordings/a1c5f4a8-2e7a-4e1b-9a6e-8d2c6aa1d9ef/stop
```

**Example successful response (200 OK)**

The response reflects the best-known state of the recording at the time of the call:

```json
{
  "status": "ok",
  "recording": {
    "id": "a1c5f4a8-2e7a-4e1b-9a6e-8d2c6aa1d9ef",
    "referenceId": "win98-bench-20251216-01",
    "label": "Windows 98 cold boot baseline",
    "state": "completed",
    "dir": "/home/user/autobench98-recordings/win98-baseline-run-01",
    "fileName": "win98-baseline-run-01__20251216-192045.mp4",
    "outputPath": "/home/user/autobench98-recordings/win98-baseline-run-01/win98-baseline-run-01__20251216-192045.mp4",
    "relativePath": "win98-baseline-run-01/win98-baseline-run-01__20251216-192045.mp4",
    "startedAt": "2025-12-16T19:20:45.123Z",
    "stoppedAt": "2025-12-16T19:21:30.456Z",
    "durationMs": 45233,
    "error": null
  }
}
```

If the FFmpeg process is still tearing down, you might briefly see:

- `state: "stopping"` with a `null` `stoppedAt`/`durationMs`.
- A subsequent `/status` call will show the final `"completed"` or `"failed"` state.

**Not found (404)**

If `id` does not correspond to a known recording:

```json
{
  "status": "error",
  "error": "RecordingNotFound",
  "message": "Recording not found: <id>"
}
```

---

## 7. Get Recording Status

**Endpoint**

```http
GET /recordings/{id}/status
```

**Example request**

```bash
curl http://localhost:3100/recordings/a1c5f4a8-2e7a-4e1b-9a6e-8d2c6aa1d9ef/status
```

**Example successful response (200 OK)**

```json
{
  "status": "ok",
  "recording": {
    "id": "a1c5f4a8-2e7a-4e1b-9a6e-8d2c6aa1d9ef",
    "referenceId": "win98-bench-20251216-01",
    "label": "Windows 98 cold boot baseline",
    "state": "recording",
    "dir": "/home/user/autobench98-recordings/win98-baseline-run-01",
    "fileName": "win98-baseline-run-01__20251216-192045.mp4",
    "outputPath": "/home/user/autobench98-recordings/win98-baseline-run-01/win98-baseline-run-01__20251216-192045.mp4",
    "relativePath": "win98-baseline-run-01/win98-baseline-run-01__20251216-192045.mp4",
    "startedAt": "2025-12-16T19:20:45.123Z",
    "stoppedAt": null,
    "durationMs": null,
    "error": null
  }
}
```

Possible `state` values:

- `"recording"`  – FFmpeg capture is active
- `"stopping"`   – `stop` has been requested; FFmpeg is shutting down
- `"completed"`  – recording finished cleanly
- `"failed"`     – FFmpeg exited unexpectedly or with an error

**Not found (404)**

Same as for `stop`:

```json
{
  "status": "error",
  "error": "RecordingNotFound",
  "message": "Recording not found: <id>"
}
```

---

## 8. Clear All Recordings

The recordings workspace is **short-lived**. While launch scripts clear it on startup, the orchestrator may also want an explicit way to clean up once it has safely copied or processed recordings.

**Endpoint**

```http
POST /recordings/clear
```

Behavior:

- Deletes **all files and subdirectories** directly under `SIDECAR_RECORDINGS_ROOT`.
- Resets the in-memory recording registry.
- Refuses to run if any recording is currently active (`recording` or `stopping`).

**Example request**

```bash
curl -X POST http://localhost:3100/recordings/clear
```

**Example successful response (200 OK)**

```json
{
  "status": "ok",
  "root": "/home/user/autobench98-recordings",
  "deletedEntries": 3
}
```

`deletedEntries` is the number of top-level entries (files and directories) removed under the root.

**Active recordings present (409 Conflict)**

```json
{
  "status": "error",
  "error": "ActiveRecordingsPresent",
  "message": "Cannot clear recordings root while 1 recording(s) are active."
}
```

In this case, the orchestrator should:

1. Stop any active recordings.
2. Optionally wait for them to transition to `"completed"` or `"failed"`.
3. Retry `/recordings/clear` if appropriate.

---

## 9. Typical Orchestrator Flow

A common “run + capture” workflow from the orchestrator’s perspective might look like this:

1. **Start recording** tied to a run ID:

   ```http
   POST /recordings/start
   {
     "referenceId": "run-1234",
     "label": "Windows 98 boot time",
     "subdir": "run-1234"
   }
   ```

   → Save `recording.id` and `recording.relativePath` in orchestrator state.

2. **Execute benchmark** (boot VM, run tests, etc.).

3. **Stop recording** when the benchmark completes:

   ```http
   POST /recordings/{id}/stop
   ```

4. Optional: **Poll status** until `state` is `"completed"` or `"failed"`:

   ```http
   GET /recordings/{id}/status
   ```

5. Copy or process the recording from:

   ```text
   SIDECAR_RECORDINGS_ROOT + "/" + recording.relativePath
   ```

6. After the orchestrator has safely archived or processed all recordings for a batch, it may optionally:
   - Call `POST /recordings/clear` to reclaim disk space, **or**
   - Rely on the next sidecar restart (launcher) to clear the workspace.

---

## 10. Notes and Recommendations

- **Use `referenceId` consistently**  
  Use a stable ID from the orchestrator (e.g. `run-uuid`) in `referenceId` so that:
  - The directory names are human-readable and searchable.
  - It’s easy to correlate a recording with a specific benchmark run.

- **Respect `SIDECAR_MAX_RECORDINGS`**  
  If you receive `TooManyRecordings` (429), treat it as a guardrail and avoid retrying in a tight loop.

- **Clear only when safe**  
  `POST /recordings/clear` removes everything under `SIDECAR_RECORDINGS_ROOT`. Always ensure the orchestrator has already copied/archived any needed files before calling it.

- **Don’t depend on absolute paths across hosts**  
  Prefer `relativePath` when passing data between components. The absolute `outputPath` is accurate **on the sidecar host**, but may not be meaningful to other machines.

---

End of document.
