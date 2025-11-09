// apps/web/src/bootstrap.ts
import { WSClient } from './lib/wsClient'
import { useMirror } from './stores/mirror'

export function startRealtime(wsUrl: string) {
    const ws = new WSClient()
    const mirror = useMirror()

    ws.on('open', () => {
        ws.send({ type: 'hello', payload: { capabilities: ['json-patch'] } })
        ws.send({ type: 'subscribe', payload: { topics: ['appState'], includeSnapshot: true } })
    })

    ws.on('message', (m: any) => {
        if (m.type === 'state.snapshot') {
        mirror.replaceSnapshot(m.stateVersion ?? m.payload?.stateVersion, m.data ?? m.payload?.data)
        } else if (m.type === 'state.patch') {
        mirror.applyPatch(
            m.fromVersion ?? m.payload?.fromVersion,
            m.toVersion ?? m.payload?.toVersion,
            m.patch ?? m.payload?.patch
        )
        }
    })

    ws.connect(wsUrl)
    return ws
}