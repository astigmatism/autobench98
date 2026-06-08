# Screen Matching

AutoBench 98 includes a focused server-side screen matching diagnostic surface. It is intended for manual testing today and for later use by benchmark-runner screen-wait steps.

## What screen matching does

Screen matching compares the latest captured frame from the Windows 98 capture sidecar against either:

1. the previously captured frame, to decide whether the screen is effectively static, or
2. a reference image stored on the orchestrator server, to decide whether the current screen resembles a known state.

The comparison is perceptual rather than byte-for-byte. It uses SSIM, so minor compression artifacts, capture noise, and small color shifts are less likely to cause a false mismatch than with raw pixel equality.

## Capture source and current-frame acquisition

The FFmpeg sidecar keeps the latest encoded JPEG frame in memory and exposes it at:

```http
GET /screenshot
```

The orchestrator screen matching plugin reads that endpoint through `SidecarFrameProvider`. The matching service depends on the provider interface rather than frontend UI state, so a future runner can call the service directly or swap in a different frame provider. If the sidecar has not captured a frame yet, the API returns a controlled `CaptureFrameUnavailable` error.

## Static detection

`GET /api/screen-matching/static` obtains the current frame and compares it to the previous frame stored by the service.

First-call behavior: the service stores a baseline frame and returns `previousFrameAvailable: false` with `score: null`. Call it again to receive a numeric SSIM score. Only one previous frame is kept in memory.

The result includes:

```json
{
  "isStatic": true,
  "score": 0.99123,
  "threshold": 0.985,
  "previousFrameAvailable": true,
  "checkedAt": "2026-05-16T20:00:00.000Z",
  "method": "ssim.js"
}
```

Use `POST /api/screen-matching/static/reset` to clear the previous-frame baseline.

## Reference image matching

`POST /api/screen-matching/reference` compares the current frame to a stored reference image:

```http
POST /api/screen-matching/reference
Content-Type: application/json

{
  "referenceImage": "windows98-desktop.png",
  "threshold": 0.92
}
```

`threshold` is optional. If it is omitted, the server uses `SCREEN_MATCH_REFERENCE_THRESHOLD`.

The result includes:

```json
{
  "matched": true,
  "score": 0.95123,
  "threshold": 0.92,
  "referenceImage": "windows98-desktop.png",
  "checkedAt": "2026-05-16T20:00:00.000Z",
  "method": "ssim.js"
}
```

## SSIM library and image normalization

The backend uses:

- `ssim.js` for SSIM scoring.
- `sharp` to decode encoded frames/reference files and normalize images to RGBA pixel buffers.

Both images are decoded to RGBA. Alpha is flattened onto black before comparison, then an alpha channel is ensured for the SSIM input. The current frame is the target comparison size. If the previous frame or reference image has different dimensions, it is resized to the current frame dimensions with deterministic `fit: fill` behavior before SSIM. API results include normalization metadata so callers can see the dimensions used and whether a reference image was resized.

Unsupported, corrupt, or too-large reference images return controlled errors rather than crashing the server.

## Configuration

The orchestrator reads thresholds and reference storage from environment variables:

```env
SCREEN_MATCH_STATIC_THRESHOLD=0.985
SCREEN_MATCH_REFERENCE_THRESHOLD=0.92
SCREEN_MATCH_REFERENCE_DIR=screen-references
SCREEN_MATCH_SIDECAR_BASE_URL=http://127.0.0.1:3100
```

Defaults:

- `SCREEN_MATCH_STATIC_THRESHOLD`: `0.985`
- `SCREEN_MATCH_REFERENCE_THRESHOLD`: `0.92`
- `SCREEN_MATCH_REFERENCE_DIR`: `${DATA_DIR:-/app/data}/screen-references`
- `SCREEN_MATCH_SIDECAR_BASE_URL`: `BENCHMARK_SIDECAR_BASE_URL`, or `http://127.0.0.1:${SIDECAR_PORT:-3100}`

Relative `SCREEN_MATCH_REFERENCE_DIR` values are resolved under `DATA_DIR`. Absolute values are allowed for server-side deployment configuration.

Threshold values must be numeric values from `0` to `1`. Invalid environment threshold values are logged and replaced with safe defaults. Dynamic API thresholds are rejected with `InvalidThreshold`.

## Reference image storage and path safety

Place reference images under the configured screen reference directory. The API accepts only relative image names inside this directory. Absolute paths, `..` traversal, null bytes, unsupported extensions, and paths that resolve outside the configured root are rejected.

Supported reference extensions for listing and path validation (decode still depends on the deployed `sharp`/libvips build, and decode failures are returned as controlled errors):

- `.jpg`
- `.jpeg`
- `.png`
- `.webp`
- `.bmp`

The reference list is recursive and capped at 1,000 images to avoid excessive directory traversal.

## API summary

```http
GET /api/screen-matching/config
GET /api/screen-matching/static
POST /api/screen-matching/static/reset
GET /api/screen-matching/references
POST /api/screen-matching/reference
```

All normal failures return structured JSON:

```json
{
  "ok": false,
  "error": {
    "code": "ReferenceImageNotFound",
    "message": "Reference image was not found."
  }
}
```

## Frontend usage

A pane component named `Screen Matching Test` is auto-discovered by the Studio pane registry. Add it from the pane selector.

The pane can:

- manually run static detection,
- optionally poll static detection every 5 seconds,
- reset the static baseline,
- list available reference images,
- compare the current frame against a selected or manually entered reference image,
- show score, threshold, status, last-checked time, current-frame age, and controlled error messages.

Polling is intentionally conservative and is disabled by default.

## Verification

1. Install dependencies and build the orchestrator.
2. Start the FFmpeg sidecar and confirm `/api/sidecar/health` reports a recent frame.
3. Start the orchestrator.
4. Open Studio and add the `Screen Matching Test` pane.
5. Click `Check now` once to capture a baseline, then again to obtain a numeric SSIM score.
6. Add a PNG/JPEG/WebP/BMP reference image to the configured reference directory.
7. Refresh the reference list, choose the image, and click `Compare`.
8. Try a missing reference image name and confirm the UI shows a controlled error.
9. Stop the sidecar or clear capture and confirm no-frame errors are controlled.

## Known limitations

- Static detection keeps only one previous frame in memory.
- The feature is exposed for diagnostics and is not yet wired into benchmark recipes.
- Reference-image management is intentionally minimal; image creation/upload is not included.
- SSIM runs per explicit request or conservative frontend polling; continuous high-frequency comparisons are not implemented.
- Dimension mismatches are handled by resizing the previous/reference image to the current frame dimensions, which is deterministic but can affect scores.
- Large full-frame SSIM comparisons are CPU work; the API avoids continuous loops and the UI defaults to manual checks.

## Future benchmark-runner integration

The existing benchmark runner already has screen-wait concepts. A later pass can replace the placeholder encoded-byte comparison in `core/benchmarks/screen-analysis.adapter.ts` with this SSIM normalization/comparison service, then reuse the same threshold and reference-directory validation rules for recipe-driven waits.
