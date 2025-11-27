import {
    getSnapshot,
    updateAtlonaControllerSnapshot,
} from '../core/state.js'
import { AtlonaControllerEvent } from '../devices/atlona-controller/types.js'

/**
 * AtlonaControllerStateAdapter
 *
 * Listens to AtlonaControllerEvent objects and translates them
 * into AppState.atlonaController changes.
 *
 * Stateless: always trusts the events and the current snapshot.
 */
export class AtlonaControllerStateAdapter {
    handle(evt: AtlonaControllerEvent): void {
        switch (evt.kind) {
            /* ------------------------------------------------------------------ */
            /*  DEVICE LIFECYCLE                                                  */
            /* ------------------------------------------------------------------ */

            case 'atlona-device-identified': {
                updateAtlonaControllerSnapshot({
                    phase: 'connecting',
                    message: undefined,
                })
                return
            }

            case 'atlona-device-connected': {
                updateAtlonaControllerSnapshot({
                    phase: 'connecting',
                    message: undefined,
                })
                return
            }

            case 'atlona-identified-complete': {
                updateAtlonaControllerSnapshot({
                    phase: 'ready',
                    message: undefined,
                    identified: true,
                })
                return
            }

            case 'atlona-device-disconnected': {
                updateAtlonaControllerSnapshot({
                    phase: 'disconnected',
                    message: `Disconnected (${evt.reason})`,
                    identified: false,
                    switches: {
                        1: { isHeld: false },
                        2: { isHeld: false },
                        3: { isHeld: false },
                    },
                })
                return
            }

            case 'atlona-device-lost': {
                updateAtlonaControllerSnapshot({
                    phase: 'disconnected',
                    message: 'Device lost',
                    identified: false,
                    switches: {
                        1: { isHeld: false },
                        2: { isHeld: false },
                        3: { isHeld: false },
                    },
                })
                return
            }

            /* ------------------------------------------------------------------ */
            /*  SWITCH EVENTS                                                     */
            /* ------------------------------------------------------------------ */

            case 'atlona-switch-held': {
                // Only send a delta for the specific switch; the helper
                // preserves names and other switches.
                updateAtlonaControllerSnapshot({
                    phase: 'ready',
                    message: undefined,
                    switches: {
                        [evt.switchId]: { isHeld: true },
                    } as any, // TS: indexed by 1|2|3; helper narrows correctly
                })
                return
            }

            case 'atlona-switch-released': {
                updateAtlonaControllerSnapshot({
                    phase: 'ready',
                    message: undefined,
                    switches: {
                        [evt.switchId]: { isHeld: false },
                    } as any,
                })
                return
            }

            /* ------------------------------------------------------------------ */
            /*  ERRORS                                                            */
            /* ------------------------------------------------------------------ */

            case 'recoverable-error': {
                const snap = getSnapshot()
                const prev = snap.atlonaController

                // If we were ever identified / ready, a recoverable error should
                // put us into a "connecting" / "reconnecting" phase so the UI
                // can surface that instead of a hard "disconnected" state.
                const nextPhase =
                    prev.identified || prev.phase === 'ready'
                        ? 'connecting'
                        : prev.phase === 'disconnected'
                            ? 'connecting'
                            : prev.phase

                updateAtlonaControllerSnapshot({
                    phase: nextPhase,
                    message: evt.error,
                    identified: prev.identified && prev.phase !== 'disconnected',
                })
                return
            }

            case 'fatal-error': {
                const snap = getSnapshot()
                const prev = snap.atlonaController

                updateAtlonaControllerSnapshot({
                    phase: 'error',
                    message: evt.error,
                    identified: prev.identified && prev.phase !== 'disconnected',
                })
                return
            }

            /* ------------------------------------------------------------------ */
            /*  DEBUG LINES (no state impact)                                     */
            /* ------------------------------------------------------------------ */

            case 'atlona-debug-line': {
                return
            }
        }
    }
}