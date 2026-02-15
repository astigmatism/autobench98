// services/orchestrator/src/devices/ps2-mouse/utils.ts

import type {
  PS2MouseConfig,
  MouseMoveMode,
  MouseAbsoluteGridConfig,
} from './types.js'

/* -------------------------------------------------------------------------- */
/*  Env parsing helpers (safety-first)                                        */
/* -------------------------------------------------------------------------- */

function num(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key]
  if (raw == null) return def
  const n = Number(raw)
  return Number.isFinite(n) ? n : def
}

function int(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const n = num(env, key, def)
  return Number.isFinite(n) ? Math.trunc(n) : def
}

function bool(env: NodeJS.ProcessEnv, key: string, def: boolean): boolean {
  const raw = env[key]
  if (raw == null) return def
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase()
    if (s === 'true') return true
    if (s === 'false') return false
    if (s === '1') return true
    if (s === '0') return false
  }
  return def
}

function str(env: NodeJS.ProcessEnv, key: string, def: string): string {
  const raw = env[key]
  if (typeof raw !== 'string') return def
  const t = raw.trim()
  return t.length ? t : def
}

function optStr(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key]
  if (typeof raw !== 'string') return undefined
  const t = raw.trim()
  return t.length ? t : undefined
}

/* -------------------------------------------------------------------------- */
/*  Mode parsing                                                              */
/* -------------------------------------------------------------------------- */

function parseMoveMode(raw: string | undefined, def: MouseMoveMode): MouseMoveMode {
  const s = (raw ?? '').trim().toLowerCase()
  if (s === 'absolute') return 'absolute'
  if (s === 'relative-gain' || s === 'relative' || s === 'gain') return 'relative-gain'
  if (s === 'relative-accel' || s === 'accel' || s === 'accelerated') return 'relative-accel'
  return def
}

/* -------------------------------------------------------------------------- */
/*  Absolute grid parsing (spec v0.3 §9)                                      */
/* -------------------------------------------------------------------------- */

type FixedW = 640 | 1024
type FixedH = 480 | 768

function parseFixedGrid(w: number, h: number): { w: FixedW; h: FixedH } | null {
  // Only accept the two supported pairs.
  if (w === 640 && h === 480) return { w: 640, h: 480 }
  if (w === 1024 && h === 768) return { w: 1024, h: 768 }
  return null
}

function parseAbsoluteGrid(env: NodeJS.ProcessEnv): MouseAbsoluteGridConfig {
  const mode = str(env, 'PS2_MOUSE_ABS_GRID_MODE', 'auto').toLowerCase()
  if (mode !== 'fixed') return { mode: 'auto' }

  const w = int(env, 'PS2_MOUSE_ABS_GRID_W', 1024)
  const h = int(env, 'PS2_MOUSE_ABS_GRID_H', 768)
  const fixed = parseFixedGrid(w, h)
  if (!fixed) {
    // Safety: if invalid fixed dims are provided, fall back to auto.
    return { mode: 'auto' }
  }

  return { mode: 'fixed', fixed }
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build PS2 mouse configuration from environment.
 *
 * Mirrors the keyboard pattern: buildPS2MouseConfigFromEnv(env).
 *
 * ENV (all optional):
 * - PS2_MOUSE_BAUD                         (default: 9600)
 * - PS2_MOUSE_PATH                         (default: unset; discovery will be used)
 *
 * - PS2_MOUSE_EXPECT_TOKEN                 (default: "MS")
 * - PS2_MOUSE_IDENTIFY_TIMEOUT_MS          (default: 2500)
 *
 * Movement / tick (spec v0.3 §8):
 * - PS2_MOUSE_TICK_HZ                      (default: 60)
 * - PS2_MOUSE_PER_TICK_MAX_DELTA           (default: 255)  // must be <= 255
 * - PS2_MOUSE_CLAMP_ABS_TO_UNIT            (default: true)
 *
 * Precision-first defaults (IMPORTANT):
 * Your Stream pane uses pointer-lock RELATIVE moves (mouse.move.relative), so defaulting to
 * amplified motion (gain=10 / accel baseGain=5) causes visible “grid snapping” even at slow speeds.
 *
 * - PS2_MOUSE_DEFAULT_MODE                 (default: "relative-gain")  // absolute|relative-gain|relative-accel
 *
 * Relative-gain:
 * - PS2_MOUSE_GAIN                         (default: 1)
 *
 * Relative-accel (opt-in):
 * - PS2_MOUSE_ACCEL_ENABLED                (default: false)
 * - PS2_MOUSE_ACCEL_BASE_GAIN              (default: 1)
 * - PS2_MOUSE_ACCEL_MAX_GAIN               (default: 1)
 * - PS2_MOUSE_ACCEL_VEL_PX_PER_SEC_FOR_MAX (default: 1500)
 *
 * Absolute grid (spec v0.3 §9):
 * - PS2_MOUSE_ABS_GRID_MODE                (default: "auto")  // auto|fixed
 * - PS2_MOUSE_ABS_GRID_W                   (default: 1024)    // only used if fixed
 * - PS2_MOUSE_ABS_GRID_H                   (default: 768)     // only used if fixed
 *
 * IntelliMouse (wheel):
 * - PS2_MOUSE_ATTEMPT_INTELLIMOUSE         (default: true)
 */
export function buildPS2MouseConfigFromEnv(env: NodeJS.ProcessEnv): PS2MouseConfig {
  const baudRate = clampInt(int(env, 'PS2_MOUSE_BAUD', 9600), 300, 2_000_000)

  const expectedToken = str(env, 'PS2_MOUSE_EXPECT_TOKEN', 'MS')
  const identifyTimeoutMs = clampInt(int(env, 'PS2_MOUSE_IDENTIFY_TIMEOUT_MS', 2500), 250, 60_000)

  const tickHz = clampInt(int(env, 'PS2_MOUSE_TICK_HZ', 60), 1, 240)

  // Firmware clamps deltas to ±255; service must step accordingly.
  const perTickMaxDelta = clampInt(int(env, 'PS2_MOUSE_PER_TICK_MAX_DELTA', 255), 1, 255)

  const clampAbs = bool(env, 'PS2_MOUSE_CLAMP_ABS_TO_UNIT', true)

  // Precision-first default: 1:1 relative motion unless user explicitly configures otherwise.
  const defaultMode = parseMoveMode(optStr(env, 'PS2_MOUSE_DEFAULT_MODE'), 'relative-gain')

  // Gain default: 1 (no amplification).
  const gain = Math.max(1, int(env, 'PS2_MOUSE_GAIN', 1))

  // Accel defaults: disabled (opt-in), with benign gains.
  const accelEnabled = bool(env, 'PS2_MOUSE_ACCEL_ENABLED', false)
  const accelBaseGain = Math.max(1, int(env, 'PS2_MOUSE_ACCEL_BASE_GAIN', 1))
  const accelMaxGain = Math.max(accelBaseGain, int(env, 'PS2_MOUSE_ACCEL_MAX_GAIN', 1))
  const velForMax = Math.max(1, int(env, 'PS2_MOUSE_ACCEL_VEL_PX_PER_SEC_FOR_MAX', 1500))

  const absoluteGrid = parseAbsoluteGrid(env)

  const attemptIntelliMouse = bool(env, 'PS2_MOUSE_ATTEMPT_INTELLIMOUSE', true)

  const cfg: PS2MouseConfig = {
    serial: {
      baudRate,
      path: optStr(env, 'PS2_MOUSE_PATH'),
    },
    identify: {
      expectedToken,
      timeoutMs: identifyTimeoutMs,
    },
    movement: {
      tickHz,
      perTickMaxDelta,
      clampAbsoluteToUnit: clampAbs,
      defaultMode,
      relativeGain: {
        gain,
      },
      accel: {
        enabled: accelEnabled,
        baseGain: accelBaseGain,
        maxGain: accelMaxGain,
        velocityPxPerSecForMax: velForMax,
      },
      absoluteGrid,
    },
    attemptIntelliMouse,
  }

  return cfg
}

/* -------------------------------------------------------------------------- */
/*  Small math utilities (used by the service)                                */
/* -------------------------------------------------------------------------- */

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

export function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  const i = Math.trunc(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

export function safeNow(): number {
  return Date.now()
}
