# Orchestrator Service

**Role:** Control plane API that coordinates benchmarks, devices, and sidecars.

- Exposes HTTP & WebSocket endpoints.
- Owns job lifecycle, scheduling, supervision, and state projections.
- Emits structured logs (Pino) and health/readiness signals.
- Interacts with sidecars (e.g., FFmpeg) via simple control endpoints.

See `src/` subfolders for domain breakdown per the design document.
