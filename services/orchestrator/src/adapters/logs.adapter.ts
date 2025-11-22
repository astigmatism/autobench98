// apps/orchestrator/src/core/logs.adapter.ts
import type {
    ClientLog,
    ClientLogBuffer,
    ClientLogListener
} from '@autobench98/logging'

/**
 * Thin adapter over @autobench98/logging's ClientLogBuffer.
 * - Late-binding: call `attachClientBuffer()` once you have the buffer instance.
 * - `getHistory(n)` → passthrough to buffer.getLatest(n)
 * - `onLog(listener)` → passthrough to buffer.subscribe(listener)
 *
 * This keeps all log retention policy inside the logging package (bounded history),
 * and lets WebSocket code stream:
 *   - initial history on connect
 *   - live appends for all clients
 */
let buf: ClientLogBuffer | null = null

export function attachClientBuffer(clientBuffer: ClientLogBuffer): void {
    buf = clientBuffer
}

/** Return the newest N logs (ascending order as returned by the buffer). */
export function getHistory(n: number): ClientLog[] {
    if (!buf) return []
    // Buffer returns newest N; keep as-is for now.
    return buf.getLatest(n)
}

/**
 * Subscribe to live logs. Returns an unsubscribe function.
 * If no buffer is attached yet, returns a no-op unsubscriber.
 */
export function onLog(listener: ClientLogListener): () => void {
    if (!buf) {
        // No buffer yet; return a stable no-op unsubscriber so callers can always call it.
        return () => { /* no-op */ }
    }
    return buf.subscribe(listener)
}