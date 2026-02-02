/* -------------------------------------------------------------------------- */
/*  FrontPanelService                                                         */
/*                                                                            */
/*  Responsibilities:                                                         */
/*  - Own the serial port for the front panel Arduino (ID: "FP")              */
/*  - Manage identification + reconnect lifecycle                              */
/*  - Provide an interruptible operation queue for power/reset commands        */
/*  - Parse telemetry lines emitted by firmware                                */
/*  - Emit domain events for logging + AppState adapters                       */
/*                                                                            */
/*  Non-responsibilities:                                                     */
/*  - No AppState mutation                                                     */
/*  - No WebSocket handling                                                    */
/*  - No pane knowledge                                                        */
/* -------------------------------------------------------------------------- */

export type FrontPanelDevicePhase =
  | 'disconnected'
  | 'connecting'
  | 'identifying'
  | 'ready'
  | 'error'

export type FrontPanelPowerSense = 'unknown' | 'off' | 'on'

export interface FrontPanelError {
  at: number
  scope:
    | 'discovery'
    | 'open'
    | 'identify'
    | 'write'
    | 'read'
    | 'protocol'
    | 'queue'
    | 'cancel'
    | 'unknown'
  message: string
  detail?: string
  retryable?: boolean
}

/* -------------------------------------------------------------------------- */
/*  Operation model                                                            */
/* -------------------------------------------------------------------------- */

export type FrontPanelOperationKind =
  | 'powerHold'
  | 'powerRelease'
  | 'powerPress'
  | 'resetPress'

export type FrontPanelOperationStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface FrontPanelInvokeTuning {
  /** How long to hold POWER_HOLD before POWER_RELEASE for a press. */
  powerPressHoldMs?: number
  /** Delay after a successful command before next command is issued. */
  interCommandDelayMs?: number
  /** If set, bounds how long we're willing to wait for ready/identify before failing. */
  readyTimeoutMs?: number
}

export interface FrontPanelOperationHandle<T = void> {
  id: string
  kind: FrontPanelOperationKind
  createdAt: number
  done: Promise<FrontPanelOperationResult<T>>
}

export interface FrontPanelOperationResult<T = void> {
  id: string
  kind: FrontPanelOperationKind
  status: FrontPanelOperationStatus
  startedAt?: number
  endedAt?: number
  error?: FrontPanelError
  value?: T
}

export interface FrontPanelOperationSummary {
  id: string
  kind: FrontPanelOperationKind
  status: FrontPanelOperationStatus
  createdAt: number
  requestedBy?: string
  label?: string
  meta?: Record<string, unknown>
}

/* -------------------------------------------------------------------------- */
/*  Environment-driven config                                                  */
/* -------------------------------------------------------------------------- */

export interface FrontPanelReconnectConfig {
  enabled: boolean
  baseDelayMs: number
  maxDelayMs: number
  /** 0 = unlimited attempts */
  maxAttempts: number
}

export interface FrontPanelIdentifyConfig {
  request: string
  completion: string
  timeoutMs: number
  retries: number
  writeLineEnding: '\n' | '\r\n'
}

export interface FrontPanelQueueConfig {
  maxDepth: number
  retainAcrossReconnect: boolean
}

export interface FrontPanelConfig {
  kind: 'arduino.frontpanel'
  expectedIdToken: string
  baudRate: number
  identify: FrontPanelIdentifyConfig
  reconnect: FrontPanelReconnectConfig
  queue: FrontPanelQueueConfig
  tuning: Required<Pick<FrontPanelInvokeTuning, 'interCommandDelayMs'>> & {
    powerPressHoldMs: number
  }
  state: {
    maxErrorHistory: number
    maxOperationHistory: number
  }
}

/* -------------------------------------------------------------------------- */
/*  Service -> plugin observability events                                     */
/* -------------------------------------------------------------------------- */

export interface FrontPanelEventSink {
  publish(evt: FrontPanelEvent): void
}

export type FrontPanelEvent =
  | {
      kind: 'frontpanel-device-identified'
      at: number
      id: string
      path: string
      baudRate: number
    }
  | {
      kind: 'frontpanel-device-lost'
      at: number
      id: string
    }
  | {
      kind: 'frontpanel-device-connected'
      at: number
      path: string
      baudRate: number
    }
  | {
      kind: 'frontpanel-device-disconnected'
      at: number
      path: string
      reason: 'io-error' | 'explicit-close' | 'unknown' | 'device-lost'
    }
  | {
      kind: 'frontpanel-identify-start'
      at: number
      path: string
    }
  | {
      kind: 'frontpanel-identify-success'
      at: number
      token: string
    }
  | {
      kind: 'frontpanel-identify-failed'
      at: number
      error: FrontPanelError
    }
  | {
      kind: 'frontpanel-power-sense-changed'
      at: number
      powerSense: FrontPanelPowerSense
      /** Source is always firmware telemetry. */
      source: 'firmware'
    }
  | {
      kind: 'frontpanel-hdd-activity-changed'
      at: number
      active: boolean
      source: 'firmware'
    }
  | {
      kind: 'frontpanel-power-button-held-changed'
      at: number
      held: boolean
      requestedBy?: string
    }
  | {
      kind: 'frontpanel-operation-queued'
      at: number
      op: FrontPanelOperationSummary
    }
  | {
      kind: 'frontpanel-operation-started'
      at: number
      opId: string
    }
  | {
      kind: 'frontpanel-operation-completed'
      at: number
      result: FrontPanelOperationResult
    }
  | {
      kind: 'frontpanel-operation-cancelled'
      at: number
      opId: string
      reason: string
    }
  | {
      kind: 'frontpanel-operation-failed'
      at: number
      result: FrontPanelOperationResult
    }
  | {
      kind: 'frontpanel-debug-line'
      at: number
      line: string
    }
  | {
      kind: 'recoverable-error'
      at: number
      error: FrontPanelError
    }
  | {
      kind: 'fatal-error'
      at: number
      error: FrontPanelError
    }

/* -------------------------------------------------------------------------- */
/*  AppState slice shape (adapter writes this into core/state.ts)              */
/* -------------------------------------------------------------------------- */

export interface FrontPanelStateSlice {
  phase: FrontPanelDevicePhase
  identified: boolean

  deviceId: string | null
  devicePath: string | null
  baudRate: number | null

  powerSense: FrontPanelPowerSense
  hddActive: boolean
  powerButtonHeld: boolean

  busy: boolean
  queueDepth: number
  currentOp: FrontPanelOperationSummary | null

  lastError: FrontPanelError | null
  errorHistory: FrontPanelError[]
  operationHistory: FrontPanelOperationSummary[]

  updatedAt: number
}
