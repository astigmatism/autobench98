/**
 * A simple barrier + mutex used to enforce the "blocking publish waits for background" policy.
 *
 * This is intentionally minimal; consider replacing with a proper async RW lock later.
 */

export class Barrier {
  private active = false
  private waiters: Array<() => void> = []

  activate(): void {
    this.active = true
  }

  deactivate(): void {
    this.active = false
    const w = this.waiters
    this.waiters = []
    for (const fn of w) fn()
  }

  /**
   * Wait while the barrier is active.
   *
   * Semantics:
   * - If inactive: resolves immediately.
   * - If active: resolves when deactivate() is called.
   */
  async waitIfActive(): Promise<void> {
    if (!this.active) return
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  /**
   * Compatibility alias (SheetsHost expects wait()).
   * Kept as a thin wrapper to preserve the existing policy semantics.
   */
  async wait(): Promise<void> {
    return await this.waitIfActive()
  }

  /**
   * Run a function exclusively while the barrier is active.
   *
   * This matches the intended "exclusiveBarrier" policy:
   * - callers activate the barrier to prevent new background tasks from starting
   * - callers must still drain in-flight background work separately if needed
   *   (SheetsHost does this via background.drain()).
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.activate()
    try {
      return await fn()
    } finally {
      this.deactivate()
    }
  }
}

export class Mutex {
  private locked = false
  private q: Array<() => void> = []

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.lock()
    try {
      return await fn()
    } finally {
      this.unlock()
    }
  }

  private async lock(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return
    }
    await new Promise<void>((resolve) => this.q.push(resolve))
    this.locked = true
  }

  private unlock(): void {
    this.locked = false
    const next = this.q.shift()
    if (next) next()
  }
}
