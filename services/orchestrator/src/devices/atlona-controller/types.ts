// services/orchestrator/src/core/devices/atlona-controller/types.ts

export type AtlonaSwitchId = 1 | 2 | 3

export type AtlonaSwitchName = 'menu' | 'minus' | 'plus'

export interface AtlonaControllerConfig {
    reconnect: {
        /** Whether to attempt automatic reconnect on IO/open errors. */
        enabled: boolean
        /** Base delay in ms used for backoff. */
        baseDelayMs: number
        /** Max delay in ms for backoff. */
        maxDelayMs: number
        /**
         * Maximum reconnect attempts. 0 or negative means "unbounded".
         * Note: discovery-driven device-lost events should still be respected.
         */
        maxAttempts: number
    }
}

/* -------------------------------------------------------------------------- */
/*  Event sink + event union                                                 */
/* -------------------------------------------------------------------------- */

export interface AtlonaControllerEventSink {
    publish(evt: AtlonaControllerEvent): void
}

/**
 * Normalized representation of switches internally.
 */
export interface AtlonaSwitchState {
    id: AtlonaSwitchId
    name: AtlonaSwitchName
    isHeld: boolean
}

/**
 * Events emitted by the AtlonaControllerService.
 */
export type AtlonaControllerEvent =
    | {
        kind: 'atlona-device-identified'
        at: number
        id: string
        path: string
        baudRate: number
    }
    | {
        kind: 'atlona-device-connected'
        at: number
        path: string
        baudRate: number
    }
    | {
        kind: 'atlona-device-disconnected'
        at: number
        path: string
        reason: 'io-error' | 'explicit-close' | 'unknown' | 'device-lost'
    }
    | {
        kind: 'atlona-device-lost'
        at: number
        id: string
    }
    | {
        kind: 'atlona-identified-complete'
        at: number
    }
    | {
        kind: 'atlona-switch-held'
        at: number
        switchId: AtlonaSwitchId
        switchName: AtlonaSwitchName
        requestedBy?: string
    }
    | {
        kind: 'atlona-switch-released'
        at: number
        switchId: AtlonaSwitchId
        switchName: AtlonaSwitchName
        requestedBy?: string
    }
    | {
        kind: 'atlona-debug-line'
        at: number
        line: string
    }
    | {
        kind: 'recoverable-error'
        at: number
        error: string
    }
    | {
        kind: 'fatal-error'
        at: number
        error: string
    }