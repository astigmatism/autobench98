/**
 * AutoBench98 Orchestrator — core/state types
 *
 * Safety-critical note:
 * - AppState should remain a plain JSON-serializable object (no functions, no class instances).
 * - For safety-relevant truth signals, prefer explicit 'unknown' states over implicit defaults.
 */

export type Version = number

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonArray
export type JsonObject = { [k: string]: JsonValue }
export type JsonArray = JsonValue[]

/**
 * Minimal RFC 6902 JSON Patch operation set used by this project.
 * Extend only if you have a concrete need.
 */
export type JsonPatchOp =
  | { op: 'add'; path: string; value: JsonValue }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: JsonValue }

/**
 * Patch notification payload (matches websocket-pane guide style).
 */
export type StatePatch = {
  from: Version
  to: Version
  patch: JsonPatchOp[]
}

/**
 * Server-driven client configuration distributed with state snapshots.
 * From orchestrator_state_plan_final.md
 */
export type ServerConfig = {
  logs: {
    snapshot: number // how many logs sent on connect
    capacity: number // suggested client ring size
    allowedChannels: string[] // WS-visible channels
    minLevel: 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  }
  ws: {
    heartbeatIntervalMs: number
    heartbeatTimeoutMs: number
    reconnectEnabled: boolean
    reconnectMinMs: number
    reconnectMaxMs: number
    reconnectFactor: number
    reconnectJitter: number
  }
}

/**
 * Example truth model for PC power.
 * 'unknown' MUST remain distinct from 'off' inside AppState.
 */
export type PcPowerValue = 'unknown' | 'on' | 'off'

export type PcPowerTruth = {
  value: PcPowerValue
  changedAt?: number // epoch ms
  source?: string // provenance (adapter/service name)
}

/**
 * AppState shape: follows orchestrator_state_plan_final.md illustration,
 * with an added `power` domain for the power truth use case.
 *
 * If your repo already defines AppState elsewhere, treat this file as
 * the canonical schema and reconcile differences deliberately.
 */
export type AppState = {
  version: Version

  meta: {
    startedAt: string
    build: string
    status: 'booting' | 'ready' | 'error'
  }

  config: {
    requestSample: number
    features: Record<string, boolean>
  }

  devices: Record<
    string,
    {
      type: string
      status: string
      lastSeen?: string
    }
  >

  streams: Record<
    string,
    {
      status: string
      url?: string
    }
  >

  jobs: {
    queue: unknown[]
    running: unknown[]
    lastCompleted?: unknown
  }

  pno: {
    status: string
    progress?: number
    lastRunAt?: string
    summary?: unknown
  }

  logs: {
    nextSeq: number
    capacity: number
    size: number
    head: number
  }

  serverConfig: ServerConfig

  power: {
    pc: PcPowerTruth
  }
}

/**
 * Slice keys are hierarchical dot-separated identifiers used for internal state-change pub/sub.
 * Example: "power", "power.pc", "devices", "streams.sidecar"
 */
export type SliceKey = string

export type SliceChangeMeta = {
  toVersion: Version
  changedSliceKeys: SliceKey[]
}
