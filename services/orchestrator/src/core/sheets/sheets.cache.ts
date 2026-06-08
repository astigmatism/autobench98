// services/orchestrator/src/core/sheets/sheets.cache.ts

export type CacheEntry<T> = {
  value: T
  expiresAt: number // epoch ms
}

/**
 * Simple in-memory TTL cache with a max size cap.
 *
 * SAFETY NOTES:
 * - This cache lives in the orchestrator process memory (Fastify main thread).
 * - It stores ONLY derived data (e.g., key maps, value ranges), not secrets.
 * - Eviction policy is FIFO by insertion order (Map iteration order).
 *   This is good enough for scaffolding; consider LRU later.
 */
export class TtlCache<T> {
  private readonly maxEntries: number
  private readonly map = new Map<string, CacheEntry<T>>()

  constructor(opts: { maxEntries: number }) {
    this.maxEntries = Math.max(0, opts.maxEntries)
  }

  get(key: string, now = Date.now()): T | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    if (e.expiresAt <= now) {
      this.map.delete(key)
      return undefined
    }
    return e.value
  }

  set(key: string, value: T, ttlMs: number, now = Date.now()): void {
    if (this.maxEntries === 0) return
    const expiresAt = ttlMs <= 0 ? now : now + ttlMs
    this.map.set(key, { value, expiresAt })

    // FIFO eviction
    while (this.map.size > this.maxEntries) {
      const first = this.map.keys().next().value as string | undefined
      if (!first) break
      this.map.delete(first)
    }
  }

  delete(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  size(): number {
    return this.map.size
  }
}
