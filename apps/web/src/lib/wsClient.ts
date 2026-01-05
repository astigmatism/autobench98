type Handler = (msg: any) => void

type ReconnectOptions = {
    enabled?: boolean
    minDelayMs?: number
    maxDelayMs?: number
    factor?: number
    jitter?: number
}

type HeartbeatOptions = {
    intervalMs?: number
    timeoutMs?: number
}

type WSClientOptions = {
    heartbeat?: HeartbeatOptions
    reconnect?: ReconnectOptions
}

// ----------------------------
// PS/2 Keyboard WS message types
// ----------------------------

// Matches orchestrator ws.ts contract:
// msg.type === 'ps2-keyboard.command'
// payload.kind === 'key' | 'power' | 'cancelAll'
export type PS2KeyboardKeyAction = 'press' | 'hold' | 'release'

export type PS2KeyboardCommandPayload =
    | {
          kind: 'key'
          action: PS2KeyboardKeyAction
          /**
           * Prefer KeyboardEvent.code (e.g. "KeyA", "Enter", "ArrowLeft").
           * Service resolves scan codes primarily via `code`.
           */
          code?: string
          /** Optional fallback (not guaranteed to work unless service supports it). */
          key?: string
          requestedBy?: string
          overrides?: any
      }
    | {
          kind: 'power'
          state: 'on' | 'off'
          requestedBy?: string
      }
    | {
          kind: 'cancelAll'
          reason?: string
          requestedBy?: string
      }

export type PS2KeyboardCommandMessage = {
    type: 'ps2-keyboard.command'
    payload: PS2KeyboardCommandPayload
}

// ----------------------------

// Read Vite-provided env (must be prefixed with VITE_)
const ENV = import.meta.env as any
const V_HEARTBEAT_INTERVAL = Number(ENV.VITE_WS_HEARTBEAT_INTERVAL_MS ?? 10000)
const V_HEARTBEAT_TIMEOUT = Number(ENV.VITE_WS_HEARTBEAT_TIMEOUT_MS ?? 5000)
const V_RC_ENABLED =
    String(ENV.VITE_WS_RECONNECT_ENABLED ?? 'true').toLowerCase() === 'true'
const V_RC_MIN = Number(ENV.VITE_WS_RECONNECT_MIN_MS ?? 1000)
const V_RC_MAX = Number(ENV.VITE_WS_RECONNECT_MAX_MS ?? 15000)
const V_RC_FACTOR = Number(ENV.VITE_WS_RECONNECT_FACTOR ?? 1.8)
const V_RC_JITTER = Number(ENV.VITE_WS_RECONNECT_JITTER ?? 0.2)

type WSStatusState = 'connected' | 'reconnecting' | 'disconnected'
type CloseIntent = 'none' | 'reopen' | 'shutdown'

export class WSClient {
    private ws?: WebSocket
    private url?: string
    private handlers: Record<string, Handler[]> = {}

    // heartbeat
    private hbTimer: number | null = null
    private pongTimer: number | null = null
    private hbIntervalMs: number
    private hbTimeoutMs: number

    // reconnect
    private reconnectEnabled: boolean
    private reconnectTimer: number | null = null
    private backoffMin: number
    private backoffMax: number
    private backoffFactor: number
    private backoffJitter: number
    private attempts = 0
    private shouldReconnect = true

    // internal close intent guard (prevents reconnect/status flicker on intentional close)
    private closeIntent: CloseIntent = 'none'

    constructor(opts: WSClientOptions = {}) {
        const hb = opts.heartbeat ?? {}
        const rc = opts.reconnect ?? {}

        this.hbIntervalMs = hb.intervalMs ?? V_HEARTBEAT_INTERVAL
        this.hbTimeoutMs = hb.timeoutMs ?? V_HEARTBEAT_TIMEOUT

        this.reconnectEnabled = rc.enabled ?? V_RC_ENABLED
        this.backoffMin = rc.minDelayMs ?? V_RC_MIN
        this.backoffMax = rc.maxDelayMs ?? V_RC_MAX
        this.backoffFactor = rc.factor ?? V_RC_FACTOR
        this.backoffJitter = rc.jitter ?? V_RC_JITTER
    }

    connect(url: string) {
        this.url = url
        this.shouldReconnect = true
        this.openSocket()
    }

    send(obj: any) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(obj))
        }
    }

    // ----------------------------
    // PS/2 keyboard helpers
    // ----------------------------

    /** Low-level typed sender for PS/2 keyboard commands. */
    sendPs2KeyboardCommand(payload: PS2KeyboardCommandPayload) {
        const msg: PS2KeyboardCommandMessage = {
            type: 'ps2-keyboard.command',
            payload
        }
        this.send(msg)
    }

    /** Convenience: send a single key action (press/hold/release). Prefer `code` (KeyboardEvent.code). */
    sendPs2KeyAction(args: {
        action: PS2KeyboardKeyAction
        code?: string
        key?: string
        requestedBy?: string
        overrides?: any
    }) {
        const code = typeof args.code === 'string' ? args.code.trim() : ''
        const key = typeof args.key === 'string' ? args.key.trim() : ''

        // Service resolves primarily via `code`; allow `key` for forward compatibility.
        if (!code && !key) return

        this.sendPs2KeyboardCommand({
            kind: 'key',
            action: args.action,
            code: code || undefined,
            key: key || undefined,
            requestedBy: args.requestedBy,
            overrides: args.overrides
        })
    }

    /** Convenience: power control. */
    sendPs2Power(state: 'on' | 'off', requestedBy?: string) {
        this.sendPs2KeyboardCommand({
            kind: 'power',
            state,
            requestedBy
        })
    }

    /** Convenience: cancel queued ops (best-effort). */
    sendPs2CancelAll(reason?: string, requestedBy?: string) {
        this.sendPs2KeyboardCommand({
            kind: 'cancelAll',
            reason,
            requestedBy
        })
    }

    // ----------------------------

    on(type: string, fn: Handler) {
        ;(this.handlers[type] ||= []).push(fn)
        return () =>
            (this.handlers[type] = (this.handlers[type] || []).filter(
                (f) => f !== fn
            ))
    }

    /** Stop heartbeats and auto-reconnect; closes the socket. */
    shutdown() {
        this.shouldReconnect = false
        this.closeIntent = 'shutdown'
        this.clearHeartbeat()
        this.clearReconnectTimer()
        try {
            this.ws?.close()
        } catch {
            // ignore
        }
        this.emitStatus('disconnected')
    }

    // ---- internals ---------------------------------------------------------

    private openSocket() {
        if (!this.url) return

        // If we're replacing an existing socket (new connect or reconnect attempt),
        // close it intentionally so onclose doesn't schedule another reconnect.
        if (this.ws) {
            this.closeIntent = 'reopen'
            try {
                this.ws.close()
            } catch {
                // ignore
            }
        }

        this.ws = new WebSocket(this.url)

        this.ws.onopen = () => {
            // If we reached onopen, we are connected; clear any pending reconnect timer.
            this.clearReconnectTimer()

            this.emit('open', {})
            this.emitStatus('connected')

            // reset backoff
            this.attempts = 0

            // start heartbeat
            this.scheduleHeartbeat()
        }

        this.ws.onmessage = (e) => {
            let msg: any
            try {
                msg = JSON.parse(e.data as string)
            } catch {
                return
            }

            // respond to server ping (if any)
            if (msg?.type === 'ping') {
                this.safeSend({ type: 'pong', ts: Date.now() })
                return
            }

            // handle pong for our heartbeat
            if (msg?.type === 'pong') {
                this.clearPongTimeout()
                return
            }

            this.emit('message', msg)
        }

        this.ws.onclose = () => {
            this.emit('close', {})

            // If we intentionally closed to reopen, don't spam "disconnected" or reconnect logic.
            const intent = this.closeIntent
            this.closeIntent = 'none'

            this.clearHeartbeat()

            if (intent !== 'reopen') {
                this.emitStatus('disconnected')
                this.maybeScheduleReconnect()
            }
        }

        this.ws.onerror = (err) => {
            this.emit('error', err as any)
            // rely on onclose for reconnect
        }
    }

    private scheduleHeartbeat() {
        this.clearHeartbeat()
        this.hbTimer = window.setTimeout(
            () => this.doHeartbeat(),
            Math.min(1000, this.hbIntervalMs)
        ) as unknown as number
    }

    private doHeartbeat() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

        // send ping
        this.safeSend({ type: 'ping', ts: Date.now() })

        // wait for pong
        this.clearPongTimeout()
        this.pongTimer = window.setTimeout(() => {
            // server did not respond in time -> force close, trigger reconnect
            try {
                this.ws?.close()
            } catch {
                // ignore
            }
        }, this.hbTimeoutMs) as unknown as number

        // schedule next ping
        this.hbTimer = window.setTimeout(
            () => this.doHeartbeat(),
            this.hbIntervalMs
        ) as unknown as number
    }

    private clearHeartbeat() {
        if (this.hbTimer !== null) {
            clearTimeout(this.hbTimer)
            this.hbTimer = null
        }
        this.clearPongTimeout()
    }

    private clearPongTimeout() {
        if (this.pongTimer !== null) {
            clearTimeout(this.pongTimer)
            this.pongTimer = null
        }
    }

    private maybeScheduleReconnect() {
        if (!this.reconnectEnabled || !this.shouldReconnect || !this.url) return

        this.clearReconnectTimer()

        const delay = this.nextBackoffDelay()
        this.emitStatus('reconnecting', {
            delayMs: delay,
            attempts: this.attempts + 1
        })

        this.reconnectTimer = window.setTimeout(() => {
            // IMPORTANT: clear timer id before attempting to open
            this.reconnectTimer = null
            this.attempts += 1
            this.openSocket()
        }, delay) as unknown as number
    }

    private clearReconnectTimer() {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
    }

    private nextBackoffDelay(): number {
        const pow = Math.max(0, this.attempts)
        const base = Math.min(
            this.backoffMax,
            this.backoffMin * Math.pow(this.backoffFactor, pow)
        )
        const jitterRange = base * this.backoffJitter
        const jitter = (Math.random() * 2 - 1) * jitterRange // [-j, +j]
        const val = Math.max(
            this.backoffMin,
            Math.min(this.backoffMax, Math.round(base + jitter))
        )
        return val
    }

    private safeSend(obj: any) {
        try {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify(obj))
            }
        } catch {
            // ignore
        }
    }

    private emit(type: string, payload: any) {
        for (const fn of this.handlers[type] || []) fn(payload)
    }

    private emitStatus(state: WSStatusState, extra: any = {}) {
        this.emit('status', { state, ...extra })
    }
}
