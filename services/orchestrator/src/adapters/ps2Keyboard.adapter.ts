// services/orchestrator/src/adapters/ps2Keyboard.adapter.ts

/* -------------------------------------------------------------------------- */
/*  PS2KeyboardStateAdapter                                                   */
/*                                                                            */
/*  Responsibilities:                                                         */
/*  - Map PS2KeyboardService domain events to AppState updates                 */
/*  - Enforce bounded histories (errors / operations)                          */
/*  - Maintain derived state (busy, queueDepth, phase, etc.)                   */
/*                                                                            */
/*  Non-responsibilities:                                                     */
/*  - No serial access                                                        */
/*  - No logging                                                              */
/*  - No WebSocket interaction                                                */
/* -------------------------------------------------------------------------- */

import type {
  PS2KeyboardEvent,
  KeyboardStateSlice,
  KeyboardOperationSummary,
  KeyboardError,
} from '../devices/ps2-keyboard/types'

export class PS2KeyboardStateAdapter {
  private state: KeyboardStateSlice

  constructor() {
    this.state = this.initialState()
  }

  /* ---------------------------------------------------------------------- */
  /*  Public API                                                            */
  /* ---------------------------------------------------------------------- */

  public handle(evt: PS2KeyboardEvent): void {
    switch (evt.kind) {
      /* ---------------- Device lifecycle -------------------------------- */
      case 'keyboard-device-identified': {
        this.state.deviceId = evt.id
        this.state.devicePath = evt.path
        this.state.baudRate = evt.baudRate
        this.state.phase = 'connecting'
        this.touch()
        break
      }

      case 'keyboard-device-connected': {
        this.state.phase = 'connecting'
        this.touch()
        break
      }

      case 'keyboard-device-disconnected': {
        this.state.phase =
          evt.reason === 'device-lost' ? 'disconnected' : 'error'
        this.state.identified = false
        this.state.busy = false
        this.state.queueDepth = 0
        this.state.currentOp = null
        this.touch()
        break
      }

      case 'keyboard-device-lost': {
        // NOTE: KeyboardDevicePhase does not include "lost".
        // Treat lost as disconnected at the state level; the event itself
        // remains the semantic indicator that the device disappeared.
        this.state.phase = 'disconnected'
        this.state.identified = false
        this.state.busy = false
        this.state.queueDepth = 0
        this.state.currentOp = null
        this.touch()
        break
      }

      /* ---------------- Identification ---------------------------------- */
      case 'keyboard-identify-start': {
        this.state.phase = 'identifying'
        this.state.identified = false
        this.touch()
        break
      }

      case 'keyboard-identify-success': {
        this.state.phase = 'ready'
        this.state.identified = true
        this.touch()
        break
      }

      case 'keyboard-identify-failed': {
        this.state.phase = 'error'
        this.pushError(evt.error)
        this.touch()
        break
      }

      /* ---------------- Power -------------------------------------------- */
      case 'keyboard-power-changed': {
        this.state.power = evt.power
        this.touch()
        break
      }

      /* ---------------- Queue + operations ------------------------------- */
      case 'keyboard-queue-depth': {
        this.state.queueDepth = evt.depth
        this.state.busy = evt.depth > 0 || !!this.state.currentOp
        this.touch()
        break
      }

      case 'keyboard-operation-queued': {
        this.state.queueDepth += 1
        this.state.busy = true
        this.pushOperation(evt.op)
        this.touch()
        break
      }

      case 'keyboard-operation-started': {
        const op = this.findOperation(evt.opId)
        if (op) {
          op.status = 'running'
          this.state.currentOp = { ...op }
        }
        this.state.busy = true
        this.touch()
        break
      }

      case 'keyboard-operation-progress': {
        // Progress is intentionally not materialized into state by default.
        // If needed later, we can extend KeyboardOperationSummary.
        this.touch()
        break
      }

      case 'keyboard-operation-completed': {
        this.finalizeOperation(evt.result)
        this.state.queueDepth = Math.max(0, this.state.queueDepth - 1)
        this.state.busy = this.state.queueDepth > 0
        this.state.currentOp = null
        this.touch()
        break
      }

      case 'keyboard-operation-cancelled': {
        const op = this.findOperation(evt.opId)
        if (op) {
          op.status = 'cancelled'
        }
        this.state.busy = false
        this.state.queueDepth = 0
        this.state.currentOp = null
        this.touch()
        break
      }

      case 'keyboard-operation-failed': {
        this.finalizeOperation(evt.result)
        this.pushError(evt.result.error)
        this.state.queueDepth = Math.max(0, this.state.queueDepth - 1)
        this.state.busy = false
        this.state.currentOp = null
        this.touch()
        break
      }

      /* ---------------- High-signal key activity ------------------------- */
      case 'keyboard-key-action': {
        // Intentionally not reflected into AppState by default.
        // The UI should observe device phase/power/queue + last errors via state,
        // and use logs for detailed input activity.
        break
      }

      /* ---------------- Errors ------------------------------------------- */
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

      /* ---------------- Debug -------------------------------------------- */
      case 'keyboard-debug-line': {
        // Debug lines are intentionally not reflected into state.
        // They are available through logs only.
        break
      }

      default: {
        // Exhaustive guard: ignore unknown events safely.
        break
      }
    }
  }

  public getState(): KeyboardStateSlice {
    return { ...this.state }
  }

  /* ---------------------------------------------------------------------- */
  /*  Internal helpers                                                      */
  /* ---------------------------------------------------------------------- */

  private initialState(): KeyboardStateSlice {
    return {
      phase: 'disconnected',
      power: 'unknown',

      identified: false,

      deviceId: null,
      devicePath: null,
      baudRate: null,

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

  private pushError(err?: KeyboardError): void {
    if (!err) return

    this.state.lastError = err
    this.state.errorHistory.unshift(err)

    // Bounded history (defensive default: 50)
    if (this.state.errorHistory.length > 50) {
      this.state.errorHistory.length = 50
    }
  }

  private pushOperation(op: KeyboardOperationSummary): void {
    this.state.operationHistory.unshift(op)

    // Bounded history (defensive default: 100)
    if (this.state.operationHistory.length > 100) {
      this.state.operationHistory.length = 100
    }
  }

  private findOperation(id: string): KeyboardOperationSummary | undefined {
    return this.state.operationHistory.find((o) => o.id === id)
  }

  private finalizeOperation(result: {
    id: string
    status: string
  }): void {
    const op = this.findOperation(result.id)
    if (op) {
      op.status = result.status as any
    }
  }
}
