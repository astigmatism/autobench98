type Handler = (msg: any) => void

export class WSClient {
    private ws?: WebSocket
    private handlers: Record<string, Handler[]> = {}

    connect(url: string) {
        this.ws = new WebSocket(url)
        this.ws.onopen = () => this.emit('open', {})
        this.ws.onmessage = (e) => {
        try { this.emit('message', JSON.parse(e.data)) } catch {}
        }
        this.ws.onclose = () => this.emit('close', {})
        this.ws.onerror = (err) => this.emit('error', err as any)
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

    private emit(type: string, payload: any) {
        for (const fn of this.handlers[type] || []) fn(payload)
    }
}