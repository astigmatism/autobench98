import {
    type ClientLog,
    type ClientLogBuffer,
    type ClientLogListener
} from './types.js'

export function makeClientBuffer(limit: number = Number(process.env.CLIENT_LOGS_TO_KEEP ?? 500)): ClientLogBuffer {
    const buf: ClientLog[] = []
    const listeners = new Set<ClientLogListener>()

    const push = (log: ClientLog): void => {
        buf.push(log)
        if (buf.length > limit) buf.shift()
        // notify subscribers
        for (const l of listeners) {
            l(log)
        }
    }

    const getLatest = (n: number): ClientLog[] => {
        return buf.slice(-n)
    }

    const subscribe = (listener: ClientLogListener): () => void => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
    }

    return { push, getLatest, subscribe }
}
