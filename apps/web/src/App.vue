<!-- apps/web/src/App.vue -->
<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { startRealtime } from './bootstrap'
import { useMirror } from './stores/mirror'
import LogsPane from './components/LogsPane.vue'
import StateDebug from './components/StateDebug.vue'
import WsStatusBadge from './components/WsStatusBadge.vue'

const status = ref('booting…')
const mirror = useMirror()

// Access Pinia state via $state (store shape: { version, data })
const version = computed(() => mirror.$state.version)
const data = computed<Record<string, any>>(() => mirror.$state.data ?? {})

// Derived fields from the snapshot data
const rows = computed(() => data.value?.layout?.rows ?? 0)
const cols = computed(() => data.value?.layout?.cols ?? 0)
const message = computed(() => data.value?.message ?? '(no message yet)')

onMounted(() => {
    // Single WebSocket connection for the whole app
    startRealtime('/ws')
    status.value = 'connected (awaiting snapshot)'
})
</script>

<template>
    <div
        style="
            min-height: 100vh;
            padding: 1rem;
            font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        "
    >
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 1rem">
            <h1 style="margin: 0">AutoBench98 Studio</h1>
            <!-- 🔌 Live WS connection status -->
            <WsStatusBadge />
        </div>

        <!-- Top grid: Layout / Message / State Debug -->
        <div
            style="
                display: grid;
                grid-template-columns: repeat(3, minmax(0, 1fr));
                gap: 1rem;
                align-items: start;
                margin-top: 1rem;
            "
        >
            <div style="border: 1px solid #e5e7eb; border-radius: 0.75rem; padding: 1rem">
                <h3 style="margin: 0 0 0.5rem 0; font-size: 0.95rem; opacity: 0.8">Layout</h3>
                <div style="font-size: 0.95rem">
                    <div>
                        Rows: <strong>{{ rows }}</strong>
                    </div>
                    <div>
                        Cols: <strong>{{ cols }}</strong>
                    </div>
                </div>
            </div>

            <div style="border: 1px solid #e5e7eb; border-radius: 0.75rem; padding: 1rem">
                <h3 style="margin: 0 0 0.5rem 0; font-size: 0.95rem; opacity: 0.8">Message</h3>
                <div style="font-size: 1.05rem">{{ message }}</div>
            </div>

            <div style="border: 1px solid #e5e7eb; border-radius: 0.75rem; padding: 1rem">
                <h3 style="margin: 0 0 0.5rem 0; font-size: 0.95rem; opacity: 0.8">Snapshot</h3>
                <div style="font-size: 0.9rem; margin-bottom: 0.5rem">
                    Version: <strong>{{ version }}</strong>
                </div>
                <StateDebug />
            </div>
        </div>

        <!-- Full-width Logs below -->
        <div style="margin-top: 1rem">
            <LogsPane />
        </div>

        <p style="opacity: 0.7; font-size: 0.9rem; margin-top: 1rem">
            Open DevTools → Network → WS to confirm traffic.
        </p>
    </div>
</template>
