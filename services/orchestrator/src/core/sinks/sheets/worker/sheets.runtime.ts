import type { SheetsConfig } from '../sheets.config.js'
import type { RunEnvelope } from '../sheets.envelope.js'
import type { PublishReceiptWorker, WorkerHealth } from '../sheets.protocol.js'
import { SheetsService } from './sheets.service.js'

export class SheetsRuntime {
  private cfg: SheetsConfig | null = null
  private svc: SheetsService | null = null

  async init(cfg: SheetsConfig): Promise<void> {
    this.cfg = cfg
    this.svc = new SheetsService(cfg)
    await this.svc.init()
  }

  async healthcheck(): Promise<WorkerHealth> {
    const at = new Date().toISOString()
    if (!this.cfg) return { status: 'error', at, details: { reason: 'not initialized' } }
    if (!this.svc) return { status: 'error', at, details: { reason: 'service missing' } }
    return { status: 'ok', at, details: { dryRun: this.cfg.dryRun } }
  }

  async publishRun(envelope: RunEnvelope): Promise<PublishReceiptWorker> {
    if (!this.svc) throw new Error('SheetsRuntime not initialized')
    return await this.svc.publishRun(envelope)
  }
}
