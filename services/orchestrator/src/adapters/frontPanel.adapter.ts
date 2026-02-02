// services/orchestrator/src/adapters/frontPanel.adapter.ts

import type {
  FrontPanelEvent,
  FrontPanelStateSlice,
  FrontPanelOperationSummary,
  FrontPanelError,
} from '../devices/front-panel/types'

export class FrontPanelStateAdapter {
  private state: FrontPanelStateSlice

  constructor() {
    this.state = this.initialState()
  }

  public handle(evt: FrontPanelEvent): void {
    switch (evt.kind) {
      /* ---------------- Device lifecycle -------------------------------- */
      case 'frontpanel-device-identified': {
        this.state.deviceId = evt.id
        this.state.devicePath = evt.path
        this.state.baudRate = evt.baudRate
        this.state.phase = 'connecting'
        this.touch()
        break
      }

      case 'frontpanel-device-connected': {
        this.state.phase = 'connecting'
        this.touch()
        break
      }

      case 'frontpanel-device-disconnected': {
        this.state.phase =
          evt.reason === 'device-lost' ? 'disconnected' : 'error'
        this.state.identified = false
        this.state.busy = false
        this.state.queueDepth = 0
        this.state.currentOp = null

        // fail-closed telemetry visibility
        this.state.powerSense = 'unknown'
        this.state.hddActive = false
        this.state.powerButtonHeld = false

        this.touch()
        break
      }

      case 'frontpanel-device-lost': {
        this.state.phase = 'disconnected'
        this.state.identified = false
        this.state.busy = false
        this.state.queueDepth = 0
        this.state.currentOp = null

        // fail-closed telemetry visibility
        this.state.powerSense = 'unknown'
        this.state.hddActive = false
        this.state.powerButtonHeld = false

        this.touch()
        break
      }

      /* ---------------- Identification ---------------------------------- */
      case 'frontpanel-identify-start': {
        this.state.phase = 'identifying'
        this.state.identified = false
        this.touch()
        break
      }

      case 'frontpanel-identify-success': {
        this.state.phase = 'ready'
        this.state.identified = true
        this.touch()
        break
      }

      case 'frontpanel-identify-failed': {
        this.state.phase = 'error'
        this.pushError(evt.error)
        this.touch()
        break
      }

      /* ---------------- Telemetry --------------------------------------- */
      case 'frontpanel-power-sense-changed': {
        this.state.powerSense = evt.powerSense
        this.touch()
        break
      }

      case 'frontpanel-hdd-activity-changed': {
        this.state.hddActive = evt.active
        this.touch()
        break
      }

      case 'frontpanel-power-button-held-changed': {
        this.state.powerButtonHeld = evt.held
        this.touch()
        break
      }

      /* ---------------- Queue + operations ------------------------------ */
      case 'frontpanel-operation-queued': {
        this.state.queueDepth += 1
        this.state.busy = true
        this.pushOperation(evt.op)
        this.touch()
        break
      }

      case 'frontpanel-operation-started': {
        const op = this.findOperation(evt.opId)
        if (op) {
          op.status = 'running'
          this.state.currentOp = { ...op }
        }
        this.state.busy = true
        this.touch()
        break
      }

      case 'frontpanel-operation-completed': {
        this.finalizeOperation(evt.result)
        this.state.queueDepth = Math.max(0, this.state.queueDepth - 1)
        this.state.busy = this.state.queueDepth > 0
        this.state.currentOp = null
        this.touch()
        break
      }

      case 'frontpanel-operation-cancelled': {
        const op = this.findOperation(evt.opId)
        if (op) op.status = 'cancelled'
        this.state.busy = false
        this.state.queueDepth = 0
        this.state.currentOp = null
        this.touch()
        break
      }

      case 'frontpanel-operation-failed': {
        this.finalizeOperation(evt.result)
        this.pushError(evt.result.error)
        this.state.queueDepth = Math.max(0, this.state.queueDepth - 1)
        this.state.busy = false
        this.state.currentOp = null
        this.touch()
        break
      }

      /* ---------------- Errors ------------------------------------------ */
      case 'recoverable-error': {
        this.pushError(evt.error)
        this.touch()
        break
      }

      case 'fatal-error': {
        this.pushError(evt.error)
        this.state.phase = 'error'
        this.touch()
        break
      }

      /* ---------------- Debug ------------------------------------------- */
      case 'frontpanel-debug-line': {
        // intentionally not reflected into state (logs only)
        break
      }

      default: {
        break
      }
    }
  }

  public getState(): FrontPanelStateSlice {
    return { ...this.state }
  }

  /* ---------------------------------------------------------------------- */
  /*  Internal helpers                                                      */
  /* ---------------------------------------------------------------------- */

  private initialState(): FrontPanelStateSlice {
    return {
      phase: 'disconnected',
      identified: false,

      deviceId: null,
      devicePath: null,
      baudRate: null,

      powerSense: 'unknown',
      hddActive: false,
      powerButtonHeld: false,

      busy: false,
      queueDepth: 0,
      currentOp: null,

      lastError: null,
      errorHistory: [],
      operationHistory: [],

      updatedAt: Date.now(),
    }
  }

  private touch(): void {
    this.state.updatedAt = Date.now()
  }

  private pushError(err?: FrontPanelError): void {
    if (!err) return
    this.state.lastError = err
    this.state.errorHistory.unshift(err)
    if (this.state.errorHistory.length > 50) {
      this.state.errorHistory.length = 50
    }
  }

  private pushOperation(op: FrontPanelOperationSummary): void {
    this.state.operationHistory.unshift(op)
    if (this.state.operationHistory.length > 100) {
      this.state.operationHistory.length = 100
    }
  }

  private findOperation(id: string): FrontPanelOperationSummary | undefined {
    return this.state.operationHistory.find((o) => o.id === id)
  }

  private finalizeOperation(result: { id: string; status: string }): void {
    const op = this.findOperation(result.id)
    if (op) op.status = result.status as any
  }
}
