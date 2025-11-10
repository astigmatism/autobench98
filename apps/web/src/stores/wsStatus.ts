// apps/web/src/stores/wsStatus.ts
import { defineStore } from 'pinia'

export type WSConnectionState = 'connected' | 'reconnecting' | 'disconnected'

type StatusPayload = {
    state: WSConnectionState
    attempts?: number
    delayMs?: number
}

export const useWsStatus = defineStore('wsStatus', {
    state: () => ({
        state: 'disconnected' as WSConnectionState,
        attempts: 0,
        delayMs: 0,
        lastChangeTs: Date.now()
    }),
    getters: {
        label(s): string {
            switch (s.state) {
                case 'connected': return 'Connected'
                case 'reconnecting': return 'Reconnecting…'
                default: return 'Disconnected'
            }
        },
        // minimal CSS-friendly status classification if you want it
        tone(s): 'good' | 'warn' | 'bad' {
            if (s.state === 'connected') return 'good'
            if (s.state === 'reconnecting') return 'warn'
            return 'bad'
        }
    },
    actions: {
        setStatus(payload: StatusPayload) {
            this.state = payload.state
            this.attempts = typeof payload.attempts === 'number' ? payload.attempts : this.attempts
            this.delayMs = typeof payload.delayMs === 'number' ? payload.delayMs : 0
            this.lastChangeTs = Date.now()
        }
    }
})