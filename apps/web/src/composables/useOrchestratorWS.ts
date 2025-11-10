// apps/web/src/composables/useOrchestratorWS.ts
import { onMounted, onBeforeUnmount } from 'vue'
import { WSClient } from '@/lib/wsClient'
import { useMirror } from '@/stores/mirror'
import { useLogs } from '@/stores/logs'

export function useOrchestratorWS(url: string) {
    const mirror = useMirror()
    const logs = useLogs()
    const ws = new WSClient()

    const off: Array<() => void> = []

    onMounted(() => {
        off.push(
            ws.on('open', () => {
                // Ask server to include state snapshot immediately
                ws.send({ type: 'subscribe', payload: { includeSnapshot: true } })
            })
        )

        off.push(
            ws.on('message', (msg: any) => {
                // --- application state snapshot ---
                if (msg?.type === 'state.snapshot' && msg?.data && typeof msg.stateVersion === 'number') {
                    mirror.replaceSnapshot(msg.stateVersion, msg.data)
                    return
                }

                // --- logs payloads ---
                if (msg?.type === 'logs.history' && Array.isArray(msg.entries)) {
                    logs.replaceHistory(msg.entries)
                    return
                }
                if (msg?.type === 'logs.append' && Array.isArray(msg.entries) && msg.entries.length > 0) {
                    for (const entry of msg.entries) {
                        logs.append(entry)
                    }
                    return
                }

                // Future: handle state.patch and other channels here
            })
        )

        ws.connect(url)
    })

    onBeforeUnmount(() => {
        off.forEach((fn) => fn())
    })

    return { send: (obj: any) => ws.send(obj) }
}