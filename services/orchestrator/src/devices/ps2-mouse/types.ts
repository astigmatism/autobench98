// services/orchestrator/src/devices/ps2-mouse/types.ts

/* -------------------------------------------------------------------------- */
/*  Core config                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Host power state as interpreted by the orchestrator.
 * Spec requirement (v0.3):
 * - only exact 'on' and 'off' are treated as known values
 * - everything else maps to 'unknown'
 */
export type MousePowerState = 'on' | 'off' | 'unknown'

/**
 * Movement modes (spec v0.3 §7.4 / §8):
 * - absolute: normalized [0..1] mapped into a resolved grid
 * - relative-gain: raw deltas multiplied by a gain
 * - relative-accel: gain increases with velocity, bounded by config
 */
export type MouseMoveMode = 'absolute' | 'relative-gain' | 'relative-accel'

export type MouseButton = 'left' | 'right' | 'middle'

/**
 * Lightweight, serializable-ish error shape.
 * NOTE: real `Error` instances are structurally compatible with this type.
 */
export type ErrorLike = {
  message: string
  name?: string
  stack?: string
}

/**
 * Absolute mapping grid configuration (spec v0.3 §9).
 *
 * NOTE (IMPORTANT):
 * Previously this type was artificially restricted to a tiny set of resolutions.
 * That restriction prevents correct absolute mapping for common modes like 800x600,
 * 1280x1024, etc. The service already clamps safely, so we allow any positive integers.
 *
 * Validation of "reasonable" sizes should occur at config-build time and/or when applying patches.
 */
export type MouseAbsoluteGridConfig =
  | {
      mode: 'auto'
      fixed?: undefined
    }
  | {
      mode: 'fixed'
      fixed: { w: number; h: number }
    }

export type MouseAccelConfig = {
  enabled: boolean
  baseGain?: number
  maxGain?: number
  /**
   * Gain reaches maxGain when velocity >= this threshold (spec v0.3 §8.7).
   * Units are "px per second" as measured in the client delta coordinate space.
   */
  velocityPxPerSecForMax?: number
}

export type PS2MouseConfig = {
  serial: {
    /**
     * Optional explicit serial path (e.g. /dev/ttyACM2).
     * If omitted, discovery is expected to select the correct device.
     */
    path?: string
    baudRate: number
  }

  identify: {
    /**
     * Firmware identify token expected from the Arduino sketch,
     * e.g. "MS" (mouse) as an ASCII token on a dedicated identify line.
     */
    expectedToken: string

    /**
     * Identify request command sent to firmware.
     * PS2MouseService defaults to "identify" if omitted.
     */
    request?: string

    /**
     * Identify completion command sent to firmware after token is observed.
     * PS2MouseService defaults to "identify_complete" if omitted.
     */
    completion?: string

    /**
     * Line ending used when writing commands to the Arduino.
     * PS2MouseService defaults to "\n" if omitted.
     */
    writeLineEnding?: string

    timeoutMs: number
  }

  movement: {
    /**
     * Movement tick flush rate (spec v0.3 §8.3).
     * Movement MUST be coalesced and emitted at this bounded rate.
     */
    tickHz: number

    /**
     * Per-tick cap used by stepping logic (spec v0.3 §8.4).
     * Firmware clamps deltas to ±255; service must step correctly.
     */
    perTickMaxDelta: number

    /**
     * When absolute movement is used, input is normalized [0..1].
     * If true, service will clamp xNorm/yNorm to [0..1] for safety.
     */
    clampAbsoluteToUnit: boolean

    /**
     * Default movement mode when client does not specify (or when mode is set via config).
     */
    defaultMode: MouseMoveMode

    /**
     * Relative-gain configuration (spec v0.3 §8.6).
     */
    relativeGain: {
      /**
       * Default gain multiplier. Supported presets MUST include: 2, 5, 10, 20.
       * (Service may accept arbitrary values too.)
       */
      gain: number
    }

    /**
     * Relative acceleration configuration (spec v0.3 §8.7).
     */
    accel: {
      enabled: boolean
      baseGain: number
      maxGain: number
      velocityPxPerSecForMax: number
    }

    /**
     * Absolute mapping grid selection (spec v0.3 §9).
     */
    absoluteGrid: MouseAbsoluteGridConfig
  }

  /**
   * Attempt IntelliMouse extensions (wheel).
   * Spec v0.3: wheel is vertical-only; if host never negotiates IntelliMouse,
   * wheel may be inert and that is acceptable for v1.
   */
  attemptIntelliMouse: boolean
}

/* -------------------------------------------------------------------------- */
/*  Client/WS ingress commands (frontend -> orchestrator -> service)           */
/* -------------------------------------------------------------------------- */

/**
 * Spec v0.3 §7.1
 */
export type ClientMouseMoveAbsolute = {
  kind: 'mouse.move.absolute'
  xNorm: number // 0..1 (clamped by service)
  yNorm: number // 0..1 (clamped by service)
  requestedBy?: string
}

/**
 * Spec v0.3 §7.1
 */
export type ClientMouseMoveRelative = {
  kind: 'mouse.move.relative'
  dx: number
  dy: number
  requestedBy?: string
}

export type ClientMouseMove = ClientMouseMoveAbsolute | ClientMouseMoveRelative

/**
 * Spec v0.3 §7.2
 */
export type ClientMouseButtonDown = {
  kind: 'mouse.button.down'
  button: MouseButton
  requestedBy?: string
}

export type ClientMouseButtonUp = {
  kind: 'mouse.button.up'
  button: MouseButton
  requestedBy?: string
}

export type ClientMouseButtonClick = {
  kind: 'mouse.button.click'
  button: MouseButton
  requestedBy?: string
  holdMs?: number
}

export type ClientMouseButton =
  | ClientMouseButtonDown
  | ClientMouseButtonUp
  | ClientMouseButtonClick

/**
 * Spec v0.3 §7.3 (vertical only)
 */
export type ClientMouseWheel = {
  kind: 'mouse.wheel'
  dy: number
  requestedBy?: string
}

/**
 * Spec v0.3 §7.4
 *
 * Config updates are discrete operations (queued) and must be cancellable by host power off.
 */
export type ClientMouseConfig = {
  kind: 'mouse.config'
  mode?: MouseMoveMode
  /**
   * Used in relative-gain mode.
   */
  gain?: number
  accel?: MouseAccelConfig
  absoluteGrid?: MouseAbsoluteGridConfig
}

export type ClientMouseCancelAll = {
  kind: 'mouse.cancelAll'
  reason?: string
  requestedBy?: string
}

export type ClientMouseCommand =
  | ClientMouseMove
  | ClientMouseButton
  | ClientMouseWheel
  | ClientMouseConfig
  | ClientMouseCancelAll

/* -------------------------------------------------------------------------- */
/*  Discrete operations (queued, cancellable)                                 */
/* -------------------------------------------------------------------------- */

/**
 * Spec v0.3 §8:
 * - Movement MUST NOT be queued per mousemove (movement is coalesced + ticked).
 * Therefore, queued operations are limited to discrete actions:
 * - buttons
 * - wheel (discrete; may also be rate-limited)
 * - config changes
 */
export type MouseOperationKind = 'button' | 'wheel' | 'config'

export type MouseOperationBase = {
  id: string
  kind: MouseOperationKind
  requestedBy: string
  queuedAt: number
}

export type MouseOperationButton = MouseOperationBase & {
  kind: 'button'
  button: MouseButton
  action: 'down' | 'up' | 'click'
  holdMs?: number
}

export type MouseOperationWheel = MouseOperationBase & {
  kind: 'wheel'
  dy: number
}

export type MouseOperationConfig = MouseOperationBase & {
  kind: 'config'
  patch: {
    mode?: MouseMoveMode
    gain?: number
    accel?: MouseAccelConfig
    absoluteGrid?: MouseAbsoluteGridConfig
  }
}

export type MouseOperation =
  | MouseOperationButton
  | MouseOperationWheel
  | MouseOperationConfig

export type MouseOperationResult = {
  id: string
  kind: MouseOperationKind
  ok: boolean
  startedAt?: number
  finishedAt?: number
  error?: ErrorLike
}

/* -------------------------------------------------------------------------- */
/*  Events (service -> plugin sinks: logger + state adapter)                   */
/* -------------------------------------------------------------------------- */

export type MouseReportingState = 'unknown' | 'enabled' | 'disabled'
export type MouseProtocolMode = 'unknown' | 'standard' | 'intellimouse'

export type PS2MouseEvent =
  /* ---------------- Lifecycle / identification -------------------------- */
  | {
      kind: 'mouse-device-connected'
      id: string
      path: string
      baudRate: number
    }
  | {
      kind: 'mouse-device-identified'
      id: string
      path: string
      baudRate: number
      token: string
    }
  | {
      kind: 'mouse-device-disconnected'
      id: string
      path: string
      reason: string
    }
  | {
      kind: 'mouse-device-lost'
      id: string
    }
  | {
      kind: 'mouse-identify-start'
      path: string
    }
  | {
      kind: 'mouse-identify-success'
      token: string
    }
  | {
      kind: 'mouse-identify-failed'
      error?: ErrorLike
    }

  /* ---------------- Host power coordination ----------------------------- */
  | {
      kind: 'mouse-host-power-changed'
      power: MousePowerState
      prev: MousePowerState
      why: string
    }

  /* ---------------- Movement (rate-limited logs) ------------------------- */
  | {
      kind: 'mouse-move-tick'
      /**
       * Service-local virtual cursor position after tick flush (grid coords).
       */
      x: number
      y: number
      /**
       * Optional: include step delta if available.
       */
      dx?: number
      dy?: number
      mode: MouseMoveMode
    }

  /* ---------------- High-signal input ----------------------------------- */
  | {
      kind: 'mouse-button'
      button: MouseButton
      action: 'down' | 'up' | 'click'
      /**
       * For idempotency logging (spec v0.3 §7.2):
       * - duplicate DOWN while already down => no-op + log
       * - duplicate UP while already up => no-op + log
       */
      noOp?: boolean
      noOpReason?: 'already-down' | 'already-up'
    }
  | {
      kind: 'mouse-wheel'
      dy: number
    }
  | {
      kind: 'mouse-config-applied'
      /**
       * Echo the applied patch (post-validation) for verification.
       */
      patch: {
        mode?: MouseMoveMode
        gain?: number
        accel?: MouseAccelConfig
        absoluteGrid?: MouseAbsoluteGridConfig
      }
    }

  /* ---------------- Firmware / Arduino lines ---------------------------- */
  | {
      kind: 'mouse-debug-line'
      line: string
    }

  /* ---------------- Protocol / telemetry (verification-first) ------------ */
  | {
      kind: 'mouse-protocol-reporting'
      reporting: MouseReportingState
    }
  | {
      kind: 'mouse-protocol-mode'
      protocolMode: MouseProtocolMode
    }
  | {
      kind: 'mouse-host-command'
      at: number
      byte: number
      name?: string
    }
  | {
      kind: 'mouse-device-id'
      at: number
      id: number
    }

  /* ---------------- Queue / operations ---------------------------------- */
  | { kind: 'mouse-queue-depth'; depth: number }
  | { kind: 'mouse-operation-queued'; op: MouseOperation }
  | { kind: 'mouse-operation-started'; op: MouseOperation }
  | { kind: 'mouse-operation-completed'; result: MouseOperationResult }
  | { kind: 'mouse-operation-cancelled'; opId: string; reason: string }
  | { kind: 'mouse-operation-failed'; result?: MouseOperationResult }

  /* ---------------- Errors ---------------------------------------------- */
  | { kind: 'recoverable-error'; error?: ErrorLike }
  | { kind: 'fatal-error'; error?: ErrorLike }

/* -------------------------------------------------------------------------- */
/*  State snapshot (device slice for AppState)                                */
/* -------------------------------------------------------------------------- */

export type PS2MousePhase = 'disconnected' | 'connecting' | 'identifying' | 'ready' | 'error'

export type MouseErrorSnapshot = {
  at: number
  message: string
}

export type MouseOperationSnapshot = {
  id: string
  kind: MouseOperationKind
  requestedBy: string
  queuedAt: number
  startedAt?: number
}

export type MouseOperationHistoryItem = {
  id: string
  kind: MouseOperationKind
  requestedBy: string
  queuedAt: number
  startedAt?: number
  finishedAt?: number
  ok: boolean
  error?: string
}

/**
 * Spec v0.3 §9.3
 */
export type MouseMappingStatus = 'ok' | 'unknown-resolution'

export type PS2MouseStateSlice = {
  /* ---------------- Lifecycle / identity ------------------------------- */
  phase: PS2MousePhase
  identified: boolean

  deviceId: string | null
  devicePath: string | null
  baudRate: number | null

  /* ---------------- Host power ----------------------------------------- */
  hostPower: MousePowerState

  /* ---------------- Queue / operations --------------------------------- */
  busy: boolean
  queueDepth: number
  currentOp: MouseOperationSnapshot | null
  operationHistory: MouseOperationHistoryItem[]

  /* ---------------- Errors --------------------------------------------- */
  lastError: string | null
  errorHistory: MouseErrorSnapshot[]

  /* ---------------- Movement config + mapping --------------------------- */
  mode: MouseMoveMode
  gain: number
  accel: {
    enabled: boolean
    baseGain: number
    maxGain: number
    velocityPxPerSecForMax: number
  }
  absoluteGrid: {
    mode: 'auto' | 'fixed'
    fixed?: { w: number; h: number }
    resolved?: { w: number; h: number }
  }
  mappingStatus: MouseMappingStatus

  /* ---------------- Buttons -------------------------------------------- */
  buttonsDown: {
    left: boolean
    right: boolean
    middle: boolean
  }

  /* ---------------- Protocol state (verification-first) ---------------- */
  reporting: MouseReportingState
  protocolMode: MouseProtocolMode
  lastHostCommand: { at: number; byte: number; name?: string } | null
  lastDeviceId: { at: number; id: number } | null

  /* ---------------- Timestamps ----------------------------------------- */
  updatedAt: number
  lastMoveAt: number | null
  lastWheelAt: number | null
  lastButtonAt: number | null
}
