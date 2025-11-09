# AutoBench98 — Monorepo Skeleton

This repository bootstraps the **Win 98 Bench Orchestrator** architecture:

-   **Orchestrator** (Fastify/TypeScript): control plane that schedules jobs, supervises devices, and coordinates sidecars.
-   **FFmpeg Sidecar** (Fastify/Node): runs close to the OS/codec stack; exposes simple control endpoints.
-   **Shared Packages**: contracts, logging helpers, config schemas.
-   **Apps**: web/admin frontends (placeholders).

See per-folder READMEs for detailed intent.

instructions to run:
cp .env.example .env
docker compose up --build
