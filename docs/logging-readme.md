# @autobench98/logging (Updated)

Channelized logging for AutoBench98 with pretty terminal output (emoji + color per channel) and a lightweight fan-out to a **shared client buffer** you can expose over HTTP/WebSocket.

- 🌈 **Readable console logs** (emoji + `[channel]` prefix)
- 🧭 **Channels** (orchestrator, sidecar, ffmpeg, ocr, device, …)
- 🧵 **Same API in TS and JS**
- 📤 **Shared client log buffer** for live UIs
- 🧰 **No `any`** — fully typed

> Runtime target: Node 18+ / ESM (`module: "NodeNext"`).  
> Pretty printing via `pino` + `pino-pretty`.

---

## Quick start

### 1) Build the package

```bash
npm install --workspaces
npm -w packages/logging run build
```

### 2) Log from your service

#### TypeScript example (orchestrator)

```ts
import {
  createLogger,
  makeClientBuffer,
  LogChannel
} from '@autobench98/logging'

const clientBuf = makeClientBuffer()
const { channel } = createLogger('orchestrator', clientBuf)

const logApp  = channel(LogChannel.app)
const logOrch = channel(LogChannel.orchestrator)
const logWs   = channel(LogChannel.websocket)

logApp.info('orchestrator app built')
logOrch.info('listening host=0.0.0.0 port=3000')
logWs.debug('client connected', { id: 'abc123' })
```

You’ll see:

```
[2025-11-12 10:30:00 +0000] 📦 [app]: orchestrator app built
[2025-11-12 10:30:00 +0000] 🛰️ [orchestrator]: listening host=0.0.0.0 port=3000
```

---

## Shared buffer for WebSocket / multi-plugin setups

When exposing logs to a **client UI** (e.g. via WebSocket), **all plugins and subsystems must use the same `ClientLogBuffer` instance**.

Example Fastify pattern:

```ts
import { createLogger, makeClientBuffer, LogChannel } from '@autobench98/logging'

export function buildApp() {
  const app = Fastify({ logger: false })
  app.decorate('clientBuf', makeClientBuffer())

  const { channel } = createLogger('orchestrator', app.clientBuf)
  const logApp = channel(LogChannel.app)

  // Shared buffer for WebSocket + plugins
  await app.register(wsPlugin)
  await app.register(serialPlugin)

  logApp.info('app started')
  return app
}
```

Inside any plugin (e.g. serial, ws):

```ts
const { channel } = createLogger('orchestrator:serial', app.clientBuf)
const logDevice = channel(LogChannel.device)
logDevice.info('device connected')
```

> 🧩 **Common mistake:**  
> Calling `makeClientBuffer()` again inside a plugin creates a separate buffer.  
> Logs written to that buffer won’t appear in the WebSocket stream or client UI.

---

## Concepts

### Channels

Each channel = one subsystem.

| Channel | Emoji | Color |
|----------|--------|--------|
| orchestrator | 🛰️ | blue |
| sidecar | 🧩 | yellow |
| ffmpeg | 🎬 | magenta |
| stream | 📺 | cyan |
| ocr | 🔎 | green |
| device | 🔌 | white |
| benchmark | ⏱️ | green |
| websocket | 🔗 | cyan |
| app | 📦 | blue |

---

## API

### `createLogger(service: string, clientBuf?: ClientLogBuffer)`

Creates a channelized pino logger.

### `makeClientBuffer(limit?: number)`

Creates a shared rolling buffer of reduced log events for UIs.

```ts
type ClientLog = {
  ts: number
  channel: LogChannel
  emoji: string
  color: ChannelColor
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  message: string
}
```

---

## Configuration

Environment variables:

- `PRETTY_LOGS` (`true`|`false`) — pretty terminal output (default `true`)
- `LOG_LEVEL` — base log level (default `info`)

> Fastify services should set `logger: false` and use this library instead.

---

## How it works

- **pino hooks:** Inject emoji and `[channel]:` prefix.
- **pino-pretty:** Compact single-line formatting.
- **Client buffer:** Mirrors reduced log events to UI (via WebSocket).

---

## Best practices

- Reuse **one shared buffer** per service.
- Always use **`logger: false`** in Fastify.
- Keep logs **one line** with key context inline.
- Add structured `extra` data for machine parsing.

---

## Common mistakes

| Symptom | Cause | Fix |
|----------|--------|-----|
| Some channels not visible in UI | Multiple `makeClientBuffer()` calls | Share a single buffer (`app.clientBuf`) |
| Fastify logs show `INFO:` lines | Built-in logger enabled | Use `Fastify({ logger: false })` |
| Channels filtered in WS | Missing `device` (etc.) in `LOG_CHANNEL_ALLOWLIST` | Add it in `.env` |

---

## License

Internal use within the AutoBench98 project.
