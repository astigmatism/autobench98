<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { startRealtime } from './bootstrap'
import { useMirror } from './stores/mirror'

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
    try {
        startRealtime('/ws')
        status.value = 'connected (awaiting snapshot)'
    } catch {
        status.value = 'failed to connect'
    }
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
        <h1 style="margin: 0 0 0.5rem 0">AutoBench98 Studio</h1>
        <p style="margin: 0 0 1rem 0; opacity: 0.8">Status: {{ status }}</p>

        <div
            style="
                display: grid;
                grid-template-columns: repeat(3, minmax(0, 1fr));
                gap: 1rem;
                align-items: start;
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
                <pre style="margin: 0; white-space: pre-wrap">{{
                    JSON.stringify(data, null, 2)
                }}</pre>
            </div>
        </div>

        <p style="opacity: 0.7; font-size: 0.9rem; margin-top: 1rem">
            Open DevTools → Network → WS to confirm traffic.
        </p>
    </div>
</template>
