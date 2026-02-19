// services/orchestrator/src/core/sinks/sheets/sheets.lock.ts
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

  async waitIfActive(): Promise<void> {
    if (!this.active) return
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
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
