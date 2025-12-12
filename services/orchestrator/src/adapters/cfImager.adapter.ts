import {
    getSnapshot,
    updateCfImagerSnapshot,
} from '../core/state.js'
import type {
    CfImagerEvent,
    CfImagerCurrentOp,
    CfImagerFsState,
    CfImagerMediaStatus,
} from '../devices/cf-imager/types.js'

/**
 * CfImagerStateAdapter
 *
 * Mirrors CfImagerEvent objects into AppState.cfImager using updateCfImagerSnapshot.
 * Stateless by design; always trusts the latest event payload.
 */
export class CfImagerStateAdapter {
    handle(evt: CfImagerEvent): void {
        switch (evt.kind) {
            case 'cf-device-identified': {
                const media: CfImagerMediaStatus = 'unknown'
                updateCfImagerSnapshot({
                    phase: 'idle',
                    media,
                    message: 'CF reader connected (probing media…)',
                    device: evt.device,
                    currentOp: undefined,
                })
                return
            }

            case 'cf-device-disconnected': {
                const media: CfImagerMediaStatus = 'none'
                updateCfImagerSnapshot({
                    phase: 'disconnected',
                    media,
                    message: `Device disconnected (${evt.reason})`,
                    device: undefined,
                    currentOp: undefined,
                })
                return
            }

            case 'cf-media-updated': {
                const snap = getSnapshot()
                const prev = snap.cfImager

                const media: CfImagerMediaStatus = evt.media
                let message = evt.message

                if (!message) {
                    if (media === 'present') {
                        message = 'CF card detected'
                    } else if (media === 'none') {
                        message = 'No CF card in reader'
                    } else {
                        message = 'Checking CF media…'
                    }
                }

                updateCfImagerSnapshot({
                    media,
                    message,
                    device: evt.device ?? prev.device,
                })
                return
            }

            case 'cf-fs-updated': {
                const fs: CfImagerFsState = evt.fs
                updateCfImagerSnapshot({
                    fs,
                    diskFreeBytes: evt.diskFreeBytes,
                })
                return
            }

            case 'cf-op-started': {
                const op: CfImagerCurrentOp = evt.op
                updateCfImagerSnapshot({
                    phase: 'busy',
                    message: op.kind === 'read'
                        ? 'Reading CF card…'
                        : 'Writing CF card…',
                    currentOp: op,
                })
                return
            }

            case 'cf-op-progress': {
                const op: CfImagerCurrentOp = evt.op
                updateCfImagerSnapshot({
                    phase: 'busy',
                    currentOp: op,
                })
                return
            }

            case 'cf-op-completed': {
                const op: CfImagerCurrentOp = evt.op
                const snap = getSnapshot()
                const fs = snap.cfImager?.fs

                updateCfImagerSnapshot({
                    phase: 'idle',
                    message: op.kind === 'read' ? 'Image read complete' : 'Image write complete',
                    currentOp: undefined,
                    fs: fs ?? undefined,
                })
                return
            }

            case 'cf-op-error': {
                const msg = evt.error
                updateCfImagerSnapshot({
                    phase: 'error',
                    message: msg,
                    lastError: msg,
                    currentOp: evt.op,
                })
                return
            }

            case 'cf-error': {
                const msg = evt.error
                const snap = getSnapshot()
                const prevPhase = snap.cfImager?.phase ?? 'disconnected'

                updateCfImagerSnapshot({
                    phase: prevPhase === 'disconnected' ? 'disconnected' : 'error',
                    message: msg,
                    lastError: msg,
                })
                return
            }
        }
    }
}
