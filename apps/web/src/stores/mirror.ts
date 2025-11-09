// apps/web/src/stores/mirror.ts
import { defineStore } from 'pinia'
import type { Operation } from 'fast-json-patch'
import { applyPatch } from 'fast-json-patch'

export const useMirror = defineStore('mirror', {
    state: () => ({ version: 0, data: {} as Record<string, any> }),
    actions: {
        replaceSnapshot(version: number, data: any) {
        this.version = version
        this.data = data
        },
        applyPatch(from: number, to: number, patch: Operation[]) {
        if (from !== this.version) return false
        const res = applyPatch(this.data, patch, false, false)
        this.version = to
        this.data = res.newDocument
        return true
        }
    }
})