// apps/web/src/composables/useWsStatusBridge.ts
import { onMounted, onBeforeUnmount, computed } from 'vue'
import { startRealtime } from '@/bootstrap'
import { useWsStatus } from '@/stores/wsStatus'

/**
 * Bridge WSClient status events into the wsStatus Pinia store.
 * Call from a top-level component (e.g., App.vue layout/header) once.
 *
 * @param wsUrl e.g., '/ws' (proxied) or absolute ws://... URL
 */
export function useWsStatusBridge(wsUrl: string) {
    const statusStore = useWsStatus()
    const disposers: Array<() => void> = []

    onMounted(() => {
        const ws = startRealtime(wsUrl)

        // Ensure the store reflects current lifecycle immediately
        disposers.push(
            ws.on('open', () => statusStore.setStatus({ state: 'connected' })),
        )
        disposers.push(
            ws.on('close', () => statusStore.setStatus({ state: 'disconnected' })),
        )
        disposers.push(
            ws.on('status', (p: any) => {
                // payload: { state: 'connected'|'reconnecting'|'disconnected', attempts?, delayMs? }
                statusStore.setStatus({
                    state: p?.state ?? 'disconnected',
                    attempts: typeof p?.attempts === 'number' ? p.attempts : undefined,
                    delayMs: typeof p?.delayMs === 'number' ? p.delayMs : undefined
                })
            }),
        )
    })

    onBeforeUnmount(() => {
        for (const off of disposers) {
            try { off() } catch {}
        }
    })

    // Expose convenient computed props for templates
    const state = computed(() => statusStore.state)
    const label = computed(() => statusStore.label)
    const tone = computed(() => statusStore.tone)
    const attempts = computed(() => statusStore.attempts)
    const delayMs = computed(() => statusStore.delayMs)

    return { state, label, tone, attempts, delayMs }
}