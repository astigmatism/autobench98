// apps/web/src/lib/wsClient.ts
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

// Read Vite-provided env (must be prefixed with VITE_)
const ENV = import.meta.env as any
const V_HEARTBEAT_INTERVAL = Number(ENV.VITE_WS_HEARTBEAT_INTERVAL_MS ?? 10000)
const V_HEARTBEAT_TIMEOUT  = Number(ENV.VITE_WS_HEARTBEAT_TIMEOUT_MS  ?? 5000)
const V_RC_ENABLED         = String(ENV.VITE_WS_RECONNECT_ENABLED ?? 'true').toLowerCase() === 'true'
const V_RC_MIN             = Number(ENV.VITE_WS_RECONNECT_MIN_MS ?? 1000)
const V_RC_MAX             = Number(ENV.VITE_WS_RECONNECT_MAX_MS ?? 15000)
const V_RC_FACTOR          = Number(ENV.VITE_WS_RECONNECT_FACTOR ?? 1.8)
const V_RC_JITTER          = Number(ENV.VITE_WS_RECONNECT_JITTER ?? 0.2)

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

    constructor(opts: WSClientOptions = {}) {
        const hb = opts.heartbeat ?? {}
        const rc = opts.reconnect ?? {}

        this.hbIntervalMs    = hb.intervalMs ?? V_HEARTBEAT_INTERVAL
        this.hbTimeoutMs     = hb.timeoutMs  ?? V_HEARTBEAT_TIMEOUT

        this.reconnectEnabled = rc.enabled   ?? V_RC_ENABLED
        this.backoffMin       = rc.minDelayMs ?? V_RC_MIN
        this.backoffMax       = rc.maxDelayMs ?? V_RC_MAX
        this.backoffFactor    = rc.factor     ?? V_RC_FACTOR
        this.backoffJitter    = rc.jitter     ?? V_RC_JITTER
    }

    connect(url: string) {
        this.url = url
        this.openSocket()
    }

    send(obj: any) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(obj))
        }
    }

    on(type: string, fn: Handler) {
        (this.handlers[type] ||= []).push(fn)
        return () => (this.handlers[type] = (this.handlers[type] || []).filter(f => f !== fn))
    }

    /** Stop heartbeats and auto-reconnect; closes the socket. */
    shutdown() {
        this.shouldReconnect = false
        this.clearHeartbeat()
        this.clearReconnectTimer()
        try { this.ws?.close() } catch {}
    }

    // ---- internals ---------------------------------------------------------

    private openSocket() {
        if (!this.url) return
        try { this.ws?.close() } catch {}
        this.ws = new WebSocket(this.url)

        this.ws.onopen = () => {
            this.emit('open', {})
            this.emitStatus('connected')
            // reset backoff
            this.attempts = 0
            // start heartbeat
            this.scheduleHeartbeat()
        }

        this.ws.onmessage = (e) => {
            let msg: any
            try { msg = JSON.parse(e.data as string) } catch { return }

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
            this.emitStatus('disconnected')
            this.clearHeartbeat()
            this.maybeScheduleReconnect()
        }

        this.ws.onerror = (err) => {
            this.emit('error', err as any)
            // rely on onclose for reconnect
        }
    }

    private scheduleHeartbeat() {
        this.clearHeartbeat()
        this.hbTimer = window.setTimeout(() => this.doHeartbeat(), Math.min(1000, this.hbIntervalMs)) as unknown as number
    }

    private doHeartbeat() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
        // send ping
        this.safeSend({ type: 'ping', ts: Date.now() })
        // wait for pong
        this.clearPongTimeout()
        this.pongTimer = window.setTimeout(() => {
            // server did not respond in time -> force close, trigger reconnect
            try { this.ws?.close() } catch {}
        }, this.hbTimeoutMs) as unknown as number

        // schedule next ping
        this.hbTimer = window.setTimeout(() => this.doHeartbeat(), this.hbIntervalMs) as unknown as number
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
        this.emitStatus('reconnecting', { delayMs: delay, attempts: this.attempts + 1 })
        this.reconnectTimer = window.setTimeout(() => {
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
        const base = Math.min(this.backoffMax, this.backoffMin * Math.pow(this.backoffFactor, pow))
        const jitterRange = base * this.backoffJitter
        const jitter = (Math.random() * 2 - 1) * jitterRange // [-j, +j]
        const val = Math.max(this.backoffMin, Math.min(this.backoffMax, Math.round(base + jitter)))
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

    private emitStatus(state: 'connected' | 'reconnecting' | 'disconnected', extra: any = {}) {
        this.emit('status', { state, ...extra })
    }
}