<!-- apps/web/src/components/WsStatusBadge.vue -->
<template>
    <div class="ws-status-badge" :data-tone="tone">
        <span ref="dot" class="dot" :title="label"></span>
        <span class="label">{{ label }}</span>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useWsStatusBridge } from '@/composables/useWsStatusBridge'
import { startRealtime } from '@/bootstrap'

// Automatically starts the bridge and listens for status updates
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'
const { label, tone } = useWsStatusBridge(WS_URL)

// Access the existing WSClient singleton
const ws = startRealtime(WS_URL)

const dot = ref<HTMLSpanElement | null>(null)
const disposers: Array<() => void> = []

onMounted(() => {
    // Animate pulse on each real pong message
    disposers.push(
        ws.on('message', (msg: any) => {
            if (msg?.type === 'pong') {
                const el = dot.value
                if (!el) return
                el.classList.remove('pulse')
                void el.offsetWidth // force reflow
                el.classList.add('pulse')
            }
        })
    )
})

onBeforeUnmount(() => {
    for (const off of disposers) {
        try {
            off()
        } catch {}
    }
})
</script>

<style scoped>
.ws-status-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85rem;
    font-family: system-ui, sans-serif;
    opacity: 0.85;
    user-select: none;
}

.dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
    transition: background-color 0.3s ease;
}

/* tone colors */
[data-tone='good'] .dot {
    background-color: #22c55e; /* green */
}
[data-tone='warn'] .dot {
    background-color: #facc15; /* yellow */
}
[data-tone='bad'] .dot {
    background-color: #ef4444; /* red */
}

.label {
    color: #e6e6e6;
    font-weight: 500;
    text-transform: capitalize;
}

/* Pulse animation */
.pulse {
    animation: pulseBeat 0.8s ease-in-out;
}

@keyframes pulseBeat {
    0% {
        transform: scale(1);
        opacity: 1;
    }
    25% {
        transform: scale(1.4);
        opacity: 0.85;
    }
    50% {
        transform: scale(1.1);
        opacity: 1;
    }
    100% {
        transform: scale(1);
        opacity: 1;
    }
}
</style>
