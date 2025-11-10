// apps/web/src/bootstrap.ts
import { WSClient } from '@/lib/wsClient'
import { useMirror } from '@/stores/mirror'
import { useLogs } from '@/stores/logs'

let wsInstance: WSClient | null = null
let listenerDisposers: Array<() => void> = []

export function startRealtime(wsUrl: string): WSClient {
    if (wsInstance) return wsInstance

    const ws = new WSClient()
    wsInstance = ws

    const mirror = useMirror()
    const logs = useLogs()

    listenerDisposers.push(
        ws.on('open', () => {
            ws.send({ type: 'hello', payload: { capabilities: ['json-patch'] } })
            ws.send({ type: 'subscribe', payload: { includeSnapshot: true } })
        })
    )

    listenerDisposers.push(
        ws.on('message', (m: any) => {
            // --- adopt server-driven config, if present ---
            if (m?.type === 'state.snapshot' && m?.data) {
                if (m.data.serverConfig) {
                    logs.adoptServerConfig(m.data.serverConfig)
                }
                if (typeof m.stateVersion === 'number') {
                    mirror.replaceSnapshot(m.stateVersion, m.data)
                }
                return
            }

            if (m?.type === 'state.patch') {
                const from = m.fromVersion ?? m.payload?.fromVersion
                const to = m.toVersion ?? m.payload?.toVersion
                const patch = m.patch ?? m.payload?.patch
                if (typeof from === 'number' && typeof to === 'number' && Array.isArray(patch)) {
                    mirror.applyPatch(from, to, patch)
                }
                return
            }

            // --- logs (history + live append) ---
            if (m?.type === 'logs.history' && Array.isArray(m.entries)) {
                logs.replaceHistory(m.entries)
                return
            }
            if (m?.type === 'logs.append' && Array.isArray(m.entries) && m.entries.length > 0) {
                for (const e of m.entries) logs.append(e)
                return
            }
        })
    )

    listenerDisposers.push(ws.on('close', () => { /* no-op */ }))
    listenerDisposers.push(ws.on('error', () => { /* no-op */ }))

    ws.connect(wsUrl)
    return ws
}

export function stopRealtime(): void {
    for (const off of listenerDisposers) {
        try { off() } catch {}
    }
    listenerDisposers = []
}