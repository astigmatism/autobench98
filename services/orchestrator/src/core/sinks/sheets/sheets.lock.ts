/**
 * Async primitives for Sheets publish scheduling.
 *
 * Purpose:
 * - Provide a "barrier" so blocking publishes can run exclusively
 *   (and optionally wait for background work to drain).
 */

export class Mutex {
  private locked = false
  private readonly waiters: Array<(release: () => void) => void> = []

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true
      return () => this.release()
    }

    return await new Promise<() => void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  private release() {
    const next = this.waiters.shift()
    if (next) {
      // still locked, transfer ownership
      next(() => this.release())
      return
    }
    this.locked = false
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

/**
 * Barrier used to pause background dispatch while a blocking task is active.
 */
export class Barrier {
  private active = false
  private readonly waiters: Array<() => void> = []

  isActive(): boolean {
    return this.active
  }

  activate(): void {
    this.active = true
  }

  deactivate(): void {
    this.active = false
    while (this.waiters.length) {
      const w = this.waiters.shift()
      if (w) w()
    }
  }

  async waitIfActive(): Promise<void> {
    if (!this.active) return
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }
}
