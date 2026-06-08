# detection/screens

Focused screen matching utilities live here.

Current implementation:

- `SidecarFrameProvider` reads the latest encoded frame from the FFmpeg sidecar `/screenshot` endpoint.
- `ScreenMatchingService` normalizes encoded current/reference images with `sharp` and compares them with `ssim.js`.
- Static detection keeps only the previous frame needed for current-vs-previous checks.
- Reference matching resolves relative image names inside the configured server reference directory and rejects traversal.

The REST surface is registered by `plugins/screenMatching.ts` for manual diagnostics and future benchmark-runner integration.
