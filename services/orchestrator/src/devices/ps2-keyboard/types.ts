// services/orchestrator/src/devices/ps2-keyboard/types.ts

/* -------------------------------------------------------------------------- */
/*  High-level goals for this file                                             */
/*  - Define the PS/2 keyboard service public contracts (types only).          */
/*  - Keep it consistent with other device services (Atlona/PowerMeter).       */
/*  - No implementation logic here.                                            */
/* -------------------------------------------------------------------------- */

/**
 * Device lifecycle phase from the orchestrator's perspective.
 * - discovery-driven (SerialDiscoveryService) calls onDeviceIdentified / onDeviceLost
 * - service owns port and the identification handshake with the Arduino sketch
 */
export type KeyboardDevicePhase =
  | 'disconnected'
  | 'connecting'
  | 'identifying'
  | 'ready'
  | 'error'

/** Power state as understood by the keyboard service (not necessarily the PC PSU). */
export type KeyboardPowerState = 'unknown' | 'off' | 'on'

/** A compact error shape suitable for state + logs. */
export interface KeyboardError {
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
/*  Scan code model                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A PS/2 "set 2" style scan code as used by your Arduino sketch command format:
 *   "<action> <prefix>:<code>" (both hex bytes)
 *
 * The sketch treats prefix 0x00 as "no prefix".
 */
export interface PS2ScanCode {
  /** Optional prefix byte (e.g., 0xE0). Use 0x00 for none on the wire. */
  prefix?: number
  /** The scan code byte (0x00-0xFF). */
  code: number
}

/**
 * Identifies a key in a browser/native-ish way.
 * Prefer KeyboardEvent.code because it is layout-stable.
 */
export interface KeyIdentity {
  /** e.g. "KeyA", "Enter", "Escape", "ArrowUp", "Digit1" */
  code?: string
  /** e.g. "a", "A", "!" (layout-dependent) */
  key?: string
}

/* -------------------------------------------------------------------------- */
/*  WebSocket command payloads (pane -> orchestrator)                           */
/* -------------------------------------------------------------------------- */

/**
 * Minimal payload for real-time key events from a pane.
 * The WS plugin will receive this and forward to the keyboard service.
 *
 * NOTE: The actual WS channel names live in websocket.interfaces.ts.
 * This type is referenced there (or re-exported from there).
 */
export interface ClientKeyboardEvent {
  /** Mirrors KeyboardEvent.code where possible (preferred). */
  code?: string
  /** Mirrors KeyboardEvent.key (optional/fallback). */
  key?: string
  /**
   * Action requested at the keyboard simulator layer.
   * - hold   => keydown semantics (key stays down)
   * - release=> keyup semantics
   * - press  => press+release (higher-level; may be used for synthesized events)
   */
  action: KeyboardAction
  /**
   * Optional: identify who/what originated the command (pane name, automation id, etc.)
   * Used for observability only.
   */
  requestedBy?: string
  /**
   * Optional: per-command overrides (delays, etc.) for flexibility.
   * Service may ignore unsupported overrides.
   */
  overrides?: Partial<KeyboardInvokeTuning>
}

/* -------------------------------------------------------------------------- */
/*  Service API surface                                                        */
/* -------------------------------------------------------------------------- */

export type KeyboardAction = 'press' | 'hold' | 'release'

/** Higher-level “combo” modifiers the service can synthesize around key presses. */
export type KeyboardCombo = 'shift' | 'ctrl' | 'alt' | 'meta'

/** Operation kinds (for state visibility + cancellation). */
export type KeyboardOperationKind =
  | 'press'
  | 'hold'
  | 'release'
  | 'type'
  | 'sequence'
  | 'releaseAll'
  | 'powerOn'
  | 'powerOff'

export type KeyboardOperationStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'

/**
 * Handle returned to callers for an enqueued operation.
 * - id can be used for cancellation
 * - done resolves when the operation terminal state is reached
 */
export interface KeyboardOperationHandle<T = void> {
  id: string
  kind: KeyboardOperationKind
  createdAt: number
  done: Promise<KeyboardOperationResult<T>>
}

export interface KeyboardOperationResult<T = void> {
  id: string
  kind: KeyboardOperationKind
  status: KeyboardOperationStatus
  startedAt?: number
  endedAt?: number
  error?: KeyboardError
  value?: T
}

/**
 * Per-operation tuning overrides (in addition to env defaults).
 * This is intentionally permissive; unsupported fields can be ignored safely.
 */
export interface KeyboardInvokeTuning {
  /**
   * Delay between “press” down/up if service is responsible for press timing.
   * (Arduino sketch already uses delay(100) for press; service may still add pacing.)
   */
  pressHoldMs?: number
  /** Delay after a successful command before next command is issued. */
  interCommandDelayMs?: number
  /** Additional per-character delay factor for type() (like your old waitBetweenKeysFactor). */
  waitBetweenKeysFactor?: number
  /** If set, bounds how long we're willing to wait for ready/identify before failing. */
  readyTimeoutMs?: number
}

/* -------------------------------------------------------------------------- */
/*  Environment-driven config                                                  */
/* -------------------------------------------------------------------------- */

export interface PS2KeyboardReconnectConfig {
  enabled: boolean
  baseDelayMs: number
  maxDelayMs: number
  /**
   * 0 = unlimited attempts (service keeps trying, but operations may time out).
   * >0 = cap reconnect attempts (service may enter error phase).
   */
  maxAttempts: number
}

export interface PS2KeyboardIdentifyConfig {
  /** Sent to Arduino, expects ID token response (e.g. "KB"). */
  request: string
  /** Sent after token matches to switch device into command-ready mode. */
  completion: string
  /** Identify response timeout. */
  timeoutMs: number
  /** Identify retries for a single connection attempt. */
  retries: number
  /** Line endings used for writes (Arduino reads until '\n'). */
  writeLineEnding: '\n' | '\r\n'
}

export interface PS2KeyboardQueueConfig {
  /** Maximum queued operations before rejecting new ones. */
  maxDepth: number
  /** Whether queued operations remain queued across reconnect. */
  retainAcrossReconnect: boolean
}

/**
 * Primary service configuration. Built from env by utils.ts,
 * passed into PS2KeyboardService by the Fastify plugin.
 */
export interface PS2KeyboardConfig {
  /** Logically identifies this device kind in discovery + wiring. */
  kind: 'arduino.ps2.keyboard'
  /** Expected identify token from the Arduino sketch (default "KB"). */
  expectedIdToken: string

  /** Default baud rate (should match sketch: 9600). */
  baudRate: number

  /** Identify handshake behavior. */
  identify: PS2KeyboardIdentifyConfig

  /** Retry behavior when port errors / disconnects occur. */
  reconnect: PS2KeyboardReconnectConfig

  /** Queue + interrupt semantics. */
  queue: PS2KeyboardQueueConfig

  /** Default pacing/tuning for operations. */
  tuning: Required<Pick<KeyboardInvokeTuning, 'interCommandDelayMs' | 'waitBetweenKeysFactor'>> & {
    /** Optional extra hold time at service-level for synthesized press actions. */
    pressHoldMs: number
  }

  /** Bounded state visibility knobs. */
  state: {
    /** Keep last N errors for UI inspection (adapter can bound). */
    maxErrorHistory: number
    /** Keep last N operation summaries for UI inspection (adapter can bound). */
    maxOperationHistory: number
  }
}

/* -------------------------------------------------------------------------- */
/*  Service -> plugin observability events                                     */
/* -------------------------------------------------------------------------- */

/**
 * Event sink interface for the keyboard service.
 * Plugins will typically fan out to:
 *  - logger sink (LogChannel.keyboard or similar)
 *  - state adapter sink (updates AppState)
 */
export interface PS2KeyboardEventSink {
  publish(evt: PS2KeyboardEvent): void
}

export type PS2KeyboardEvent =
  | {
      kind: 'keyboard-device-identified'
      at: number
      id: string
      path: string
      baudRate: number
    }
  | {
      kind: 'keyboard-device-lost'
      at: number
      id: string
    }
  | {
      kind: 'keyboard-device-connected'
      at: number
      path: string
      baudRate: number
    }
  | {
      kind: 'keyboard-device-disconnected'
      at: number
      path: string
      reason: 'io-error' | 'explicit-close' | 'unknown' | 'device-lost'
    }
  | {
      kind: 'keyboard-identify-start'
      at: number
      path: string
    }
  | {
      kind: 'keyboard-identify-success'
      at: number
      token: string
    }
  | {
      kind: 'keyboard-identify-failed'
      at: number
      error: KeyboardError
    }
  | {
      kind: 'keyboard-power-changed'
      at: number
      power: KeyboardPowerState
      requestedBy?: string
    }
  | {
      kind: 'keyboard-queue-depth'
      at: number
      depth: number
    }
  | {
      kind: 'keyboard-operation-queued'
      at: number
      op: KeyboardOperationSummary
    }
  | {
      kind: 'keyboard-operation-started'
      at: number
      opId: string
    }
  | {
      kind: 'keyboard-operation-progress'
      at: number
      opId: string
      /** Optional progress counters for type()/sequence. */
      progress?: {
        done: number
        total: number
      }
    }
  | {
      kind: 'keyboard-operation-completed'
      at: number
      result: KeyboardOperationResult
    }
  | {
      kind: 'keyboard-operation-cancelled'
      at: number
      opId: string
      reason: string
    }
  | {
      kind: 'keyboard-operation-failed'
      at: number
      result: KeyboardOperationResult
    }
  | {
      kind: 'keyboard-debug-line'
      at: number
      line: string
    }
  | {
      kind: 'recoverable-error'
      at: number
      error: KeyboardError
    }
  | {
      kind: 'fatal-error'
      at: number
      error: KeyboardError
    }

/** Minimal operation summary to store in bounded histories and show in UI. */
export interface KeyboardOperationSummary {
  id: string
  kind: KeyboardOperationKind
  status: KeyboardOperationStatus
  createdAt: number
  requestedBy?: string

  /** Best-effort human hint, safe to show in UI. */
  label?: string

  /** Optional: for visibility; avoid storing full text payloads unbounded. */
  meta?: Record<string, unknown>
}

/* -------------------------------------------------------------------------- */
/*  AppState slice shape (adapter writes this into state.ts)                   */
/* -------------------------------------------------------------------------- */

export interface KeyboardStateSlice {
  phase: KeyboardDevicePhase
  power: KeyboardPowerState

  /** Whether the Arduino identification handshake is complete. */
  identified: boolean

  /** Serial discovery device id/path (for UI visibility only). */
  deviceId: string | null
  devicePath: string | null
  baudRate: number | null

  /** Queue visibility. */
  busy: boolean
  queueDepth: number

  /** Current running operation (if any). */
  currentOp: KeyboardOperationSummary | null

  /** Last error summary (for quick UI display). */
  lastError: KeyboardError | null

  /** Bounded histories (adapter must enforce caps). */
  errorHistory: KeyboardError[]
  operationHistory: KeyboardOperationSummary[]

  /** Last update time (ms since epoch). */
  updatedAt: number
}
