<template>
    <div class="p-4 space-y-2">
        <div class="text-sm text-gray-500">Version: {{ mirror.version }}</div>
        <pre
            class="text-xs bg-gray-900 text-gray-100 p-3 rounded overflow-auto"
            style="max-height: 40vh"
            >{{ pretty }}
        </pre>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useMirror } from '@/stores/mirror'

const mirror = useMirror()
const pretty = computed(() => JSON.stringify(mirror.data, null, 2))
</script>

<style scoped>
pre {
    tab-size: 2;
}
</style>
