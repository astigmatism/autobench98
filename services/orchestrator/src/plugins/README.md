# plugins

Plugins registered into Fastify (encapsulated logic):
- `routes.api.ts`: HTTP routes grouped by feature; imports contracts/schemas.
- `ws.ts`: WebSocket events (progress updates, logs, device status).
- `health.ts`: liveness/readiness aggregation from dependencies.

