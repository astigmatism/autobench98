# @autobench98/logging

Channelized logging for AutoBench98 with pretty terminal output (emoji + color per channel) and a lightweight fan-out to a client buffer you can expose over HTTP/WebSocket.

-   🌈 **Readable console logs** (emoji + `[channel]` prefix)
-   🧭 **Channels** (orchestrator, sidecar, ffmpeg, ocr, etc.)
-   🧵 **Same API in TS and JS** (works in services and workers)
-   📤 **Client log buffer** for UIs (reduced payloads)
-   🧰 **No `any`** — fully typed

> Runtime target: Node 18+ / ESM (`module: "NodeNext"`).  
> Pretty printing is powered by `pino` + `pino-pretty`.

---

## Quick start

### 1) Install (monorepo)

```bash
npm install --workspaces
npm -w packages/logging run build
```

(If you’re running via Docker, the Dockerfiles already build this package inside the images; the above is for local IDE/type support.)

### 2) Log from your service

**TypeScript example (orchestrator):**

```ts
import { createLogger, makeClientBuffer, LogChannel } from '@autobench98/logging'

const clientBuf = makeClientBuffer()
const { channel } = createLogger('orchestrator', clientBuf)

const logApp = channel(LogChannel.app)
const logOrch = channel(LogChannel.orchestrator)
const logWs = channel(LogChannel.websocket)

logApp.info('orchestrator app built')
logOrch.info('listening on 0.0.0.0:3000')
logWs.debug('client connected', { id: 'abc123' })
```

**JavaScript example (sidecar):**

```js
import { createLogger, LogChannel } from '@autobench98/logging'

const { channel } = createLogger('sidecar')
const logApp = channel(LogChannel.app)
const logAgent = channel(LogChannel.sidecar)

logApp.info('sidecar app built')
logAgent.info('ready')
```

You’ll see output like:

```
[2025-11-08 07:23:40 +0000] 📦 [app]: orchestrator app built
[2025-11-08 07:23:40 +0000] 🛰️ [orchestrator]: listening on 0.0.0.0:3000
```

---

## Concepts

### Channels

A **channel** represents a subsystem (orchestrator, sidecar, ffmpeg, ocr, …). Each channel has:

-   an emoji (quick visual cue)
-   a color (terminal prefix color)
-   an optional custom log level (we map channels to a level name so the left-hand “level label” disappears in pretty mode)

This package ships with:

-   `orchestrator` 🛰️ blue
-   `sidecar` 🧩 yellow
-   `ffmpeg` 🎬 magenta
-   `stream` 📺 cyan
-   `ocr` 🔎 green
-   `device` 🔌 white
-   `benchmark` ⏱️ green
-   `websocket` 🔗 cyan
-   `app` 📦 blue

---

## API

### `createLogger(service: string, clientBuf?: ClientLogBuffer): LoggerBundle`

Creates a pino logger configured for channelized output.

-   `service` – label stored in the record (hidden from pretty output).
-   `clientBuf` – optional in-memory buffer to mirror reduced logs to the UI.

Returns:

```ts
type LoggerBundle = {
    base: import('pino').Logger
    channel: (ch: LogChannel) => ChannelLogger
}

type ChannelLogger = {
    debug(msg: string, extra?: Record<string, unknown>): void
    info(msg: string, extra?: Record<string, unknown>): void
    warn(msg: string, extra?: Record<string, unknown>): void
    error(msg: string, extra?: Record<string, unknown>): void
    fatal(msg: string, extra?: Record<string, unknown>): void
}
```

### `makeClientBuffer(limit?: number): ClientLogBuffer`

Creates a simple rolling buffer (default 500 entries) of **reduced** log events for UI consumption.

```ts
type ClientLog = {
    ts: number
    channel: LogChannel
    emoji: string
    color: ChannelColor
    level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'
    message: string
}

type ClientLogBuffer = {
    push(log: ClientLog): void
    getLatest(n: number): ClientLog[]
    subscribe(listener: (log: ClientLog) => void): () => void // returns unsubscribe
}
```

Typical usage in an API to expose live logs:

```ts
const buf = makeClientBuffer()
const { channel } = createLogger('orchestrator', buf)

app.get('/logs', async (req) => {
    const n = Number((req.query as { n?: string }).n ?? 200)
    return buf.getLatest(Number.isFinite(n) && n > 0 ? n : 200)
})
```

### Types you’ll use

```ts
import {
    LogChannel,
    type ChannelColor,
    type ClientLog,
    type ClientLogBuffer
} from '@autobench98/logging'
```

---

## Configuration

Environment variables (read at logger creation):

-   `PRETTY_LOGS` (`true`|`false`) – enable `pino-pretty` output (default `true`)
-   `LOG_LEVEL` (pino levels; default `info`) – e.g. `debug`, `info`, `warn`, …

> We intentionally disable Fastify’s built-in logger in services and use this package instead, to control the exact output format.

---

## How it works

-   **pino hooks**: we wrap `logMethod` to detect `{ channel }` in the first argument and **prepend** an emoji + `[channel]:` prefix directly into the message string. This keeps the console line compact.
-   **pino-pretty destination**: when `PRETTY_LOGS=true`, we pipe logs through `pino-pretty` with a `messageFormat` that renders **only** the message (no `INFO:` or `USERLVL:` labels).
-   **custom levels**: each `LogChannel` is also registered as a **custom level** (same numeric priority as `info`). When `CHANNEL_AS_LEVEL` is `true`, channel logs use that level name internally; because we hide the level field in pretty output, you don’t see the left-hand level label at all.
-   **client buffer**: every call to a `ChannelLogger` also pushes a reduced `ClientLog` into the provided `ClientLogBuffer`, so UIs don’t need to parse pino JSON.

---

## Add a new channel (emoji + color)

1. Add to the enum in `src/types.ts`:

    ```ts
    export enum LogChannel {
        // ...
        scheduler = 'scheduler'
    }
    ```

2. Map its emoji & color in `src/channels.ts`:

    ```ts
    import { LogChannel, type ChannelColor } from './types.js'

    export const CHANNELS = {
        // ...
        [LogChannel.scheduler]: { emoji: '🗓️', color: 'purple' as ChannelColor }
    }
    ```

3. Ensure it has a numeric level in `CUSTOM_LEVELS`:
    ```ts
    export const CUSTOM_LEVELS = {
        // ...
        [LogChannel.scheduler]: 30
    }
    ```

Now use it anywhere:

```ts
const logSched = channel(LogChannel.scheduler)
logSched.info('job queued', { jobId: 'J-42' })
```

---

## Change colors or emoji

Edit `src/channels.ts`:

```ts
export const CHANNELS = {
    [LogChannel.ffmpeg]: { emoji: '🎞️', color: 'magenta' }
    // ...
}

export const ANSI = {
    blue: '\x1b[34m',
    yellow: '\x1b[33m',
    green: '\x1b[32m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    red: '\x1b[31m',
    white: '\x1b[37m',
    purple: '\x1b[95m'
}
```

If you introduce a new color, add its ANSI code to `ANSI`.

---

## Best practices

-   **Per-subsystem loggers**: Create one `channel(LogChannel.xyz)` per subsystem and reuse it.
-   **Structured extras**: Pass structured data for context.
    ```ts
    logOcr.warn('ocr slow', { ms: 240, page: 3 })
    ```
-   **UI feed**: reuse one `ClientLogBuffer` per service.
-   **Fastify**: always use `logger: false` and log with this package.
-   **Docker**: the Dockerfiles already build this package before starting services.

---

## Troubleshooting

**I still see `INFO:` or `USERLVL:`**  
→ make sure Fastify’s internal logger is off:

```ts
const app = Fastify({ logger: false })
```

**Editor says “Cannot find module '@autobench98/logging'”**  
→ run:

```bash
npm install --workspaces
npm -w packages/logging run build
```

or add a path alias in the service `tsconfig.json`:

```json
"paths": {
  "@autobench98/logging": ["../../packages/logging/src/index.ts"]
}
```

**Timestamps look odd**  
→ we use `pino-pretty`’s `SYS:standard` preset; change it in `src/pino.ts` if you prefer another format.

---

## Development

Build once:

```bash
npm -w packages/logging run build
```

Rebuild on changes:

```bash
npm -w packages/logging run build
```

In Docker dev, the image build step runs the logging build automatically.

---

## License

Internal use within the AutoBench98 project.
