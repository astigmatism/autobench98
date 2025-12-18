/* eslint-disable no-console */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import type {
    CfImagerConfig,
    CfImagerEventSink,
    CfImagerState,
    CfImagerFsState,
    CfImagerCurrentOp,
    CfImagerDeviceInfo,
} from './types.js'
import {
    resolveUnderRoot,
    listDirectoryState,
} from './utils.js'

interface CfImagerServiceDeps {
    events: CfImagerEventSink
}

/**
 * CfImagerService
 *
 * - Integrates with CfBlockDiscoveryService via onDeviceIdentified/onDeviceLost.
 * - Constrains all FS operations to a configured root directory.
 * - Exposes high-level operations for the frontend pane (list/create/rename/delete).
 * - Spawns external bash scripts to read/write CF images.
 *
 * NOTE: Only a single operation (read/write) is allowed at a time.
 */
export class CfImagerService {
    private readonly config: CfImagerConfig
    private readonly deps: CfImagerServiceDeps

    private state: CfImagerState
    private device: CfImagerDeviceInfo | null = null

    /** Current working directory (absolute path under root). */
    private cwdAbs: string

    /** Single in-flight child process for read/write (if any). */
    private child: ChildProcessWithoutNullStreams | null = null

    /** Optional periodic FS polling timer for out-of-band changes. */
    private fsPollTimer: NodeJS.Timeout | null = null

    /**
     * Recent progress samples for computing a moving-average transfer speed.
     * We store the last few (time, bytesDone) points.
     */
    private progressSamples: { t: number; bytes: number }[] = []

    constructor(config: CfImagerConfig, deps: CfImagerServiceDeps) {
        this.config = config
        this.deps = deps

        const root = config.rootDir
        this.cwdAbs = root

        const fs: CfImagerFsState = listDirectoryState(
            root,
            this.cwdAbs,
            this.config.maxEntriesPerDir,
            this.config.visibleExtensions
        )

        this.state = {
            phase: 'disconnected',
            media: 'none',
            fs,
            // diskFreeBytes will be populated on the first emitFsUpdated()
        }

        /*
        console.log(
            '[cf-imager] service constructed',
            JSON.stringify({
                rootDir: this.config.rootDir,
                maxEntriesPerDir: this.config.maxEntriesPerDir,
                readScriptPath: this.config.readScriptPath,
                writeScriptPath: this.config.writeScriptPath,
                visibleExtensions: this.config.visibleExtensions,
                fsPollIntervalMs: this.config.fsPollIntervalMs ?? 0,
            })
        )
        */
    }

    /* ---------------------------------------------------------------------- */
    /*  Public API                                                            */
    /* ---------------------------------------------------------------------- */

    public async start(): Promise<void> {
        // console.log('[cf-imager] start() called (initializing FS polling, waiting for device discovery)')

        // Initial FS snapshot is already in this.state from the constructor.
        // Start a lightweight polling watcher if configured.
        this.startFsPolling()
    }

    public async stop(): Promise<void> {
        // console.log('[cf-imager] stop() called')

        this.stopFsPolling()

        await this.cancelCurrentChild('explicit-close')
        this.device = null
        this.state.phase = 'disconnected'
        this.state.media = 'none'
        this.state.device = undefined
        this.state.message = 'Service stopped'
    }

    public getState(): CfImagerState {
        // Shallow clone to discourage mutation.
        return {
            ...this.state,
            fs: { ...this.state.fs, entries: [...this.state.fs.entries] },
        }
    }

    /* ---------------------------------------------------------------------- */
    /*  Discovery-driven lifecycle                                            */
    /* ---------------------------------------------------------------------- */

    public async onDeviceIdentified(args: {
        id: string
        path: string
        vendorId?: string
        productId?: string
        serialNumber?: string
    }): Promise<void> {

        this.device = {
            id: args.id,
            path: args.path,
            vendorId: args.vendorId,
            productId: args.productId,
            serialNumber: args.serialNumber,
        }

        // Reader present. Media status is initially unknown until we probe.
        this.state.phase = 'idle'
        this.state.media = 'unknown'
        this.state.device = this.device
        this.state.message = 'Reader connected (probing media…)'

        this.deps.events.publish({
            kind: 'cf-device-identified',
            at: Date.now(),
            device: this.device,
        })

        // Emit latest FS snapshot on device presence too (handy for first-open).
        await this.emitFsUpdated()

        // Kick off an async media probe specific to this device.
        void this.refreshMediaStatus()
    }

    public async onDeviceLost(args: { id: string }): Promise<void> {
        // console.log('[cf-imager] onDeviceLost', JSON.stringify({ id: args.id }))

        if (!this.device || this.device.id !== args.id) {
            // console.log(
            //    '[cf-imager] onDeviceLost: ignoring, current device is',
            //    this.device ? this.device.id : 'none'
            //)
            return
        }

        const wasUnmounted = this.device.path === 'unmounted'

        await this.cancelCurrentChild('device-lost')

        const lostId = this.device.id
        this.device = null

        this.state.phase = 'disconnected'
        this.state.media = 'none'
        this.state.device = undefined
        this.state.message = wasUnmounted
            ? 'CF reader media variant replaced'
            : 'Device lost'

        this.deps.events.publish({
            kind: 'cf-device-disconnected',
            at: Date.now(),
            deviceId: lostId,
            // keep the existing union value so we don’t break any consumers
            reason: 'device-lost',
        })

        this.deps.events.publish({
            kind: 'cf-media-updated',
            at: Date.now(),
            media: 'none',
            device: undefined,
            sizeBytes: 0,
            message: wasUnmounted
                ? 'CF reader media path replaced'
                : 'CF reader disconnected',
        })
    }

    /* ---------------------------------------------------------------------- */
    /*  Filesystem API (used by commands / pane)                              */
    /* ---------------------------------------------------------------------- */

    public async listDirectory(relPath: string | undefined): Promise<void> {
        // console.log('[cf-imager] listDirectory', { relPath })
        try {
            const abs = resolveUnderRoot(this.config.rootDir, relPath ?? '.')
            this.cwdAbs = abs
            await this.emitFsUpdated()
        } catch (err) {
            this.emitError(`listDirectory failed: ${(err as Error).message}`)
        }
    }

    public async changeDirectory(newRel: string): Promise<void> {
        // console.log('[cf-imager] changeDirectory', { newRel })
        await this.listDirectory(newRel)
    }

    public async createFolder(name: string): Promise<void> {
        // console.log('[cf-imager] createFolder', { name })
        try {
            const safeName = sanitizeName(name)
            if (!safeName) {
                // Treat empty/unsafe names as no-op, per UI contract.
                return
            }

            const target = resolveUnderRoot(this.config.rootDir, join(this.relCwd(), safeName))

            try {
                await fsp.mkdir(target, { recursive: false })
            } catch (err) {
                const e = err as NodeJS.ErrnoException
                // If the folder already exists, silently drop the request.
                // No overwrite, no rename, and no error surfaced to UI.
                if (e && e.code === 'EEXIST') {
                    return
                }
                throw err
            }

            // On successful creation, refresh FS snapshot so the UI shows the new folder
            // and the updated free space.
            await this.emitFsUpdated()
        } catch (err) {
            this.emitError(`createFolder failed: ${(err as Error).message}`)
        }
    }

    public async renamePath(fromRel: string, toRel: string): Promise<void> {
        // console.log('[cf-imager] renamePath', { fromRel, toRel })
        try {
            const fromAbs = resolveUnderRoot(this.config.rootDir, fromRel)
            const toAbs = resolveUnderRoot(this.config.rootDir, toRel)

            const fromDir = dirname(fromAbs)
            const toDir = dirname(toAbs)
            const fromBase = basename(fromAbs)
            const toBase = basename(toAbs)

            const isFromImgPath = fromBase.toLowerCase().endsWith('.img')
            const isToImgPath = toBase.toLowerCase().endsWith('.img')

            // Small helper: existence check without throwing
            const pathExists = async (p: string): Promise<boolean> => {
                try {
                    await fsp.stat(p)
                    return true
                } catch (err) {
                    const e = err as NodeJS.ErrnoException
                    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
                        return false
                    }
                    throw err
                }
            }

            // -------------------------------------------------------------------
            // Image-group aware branch:
            //
            // We want to treat "<name>.img" and "<name>.part" as a logical unit,
            // regardless of whether fromRel/toRel include ".img" explicitly or
            // are extensionless UI names.
            // -------------------------------------------------------------------

            // Candidates derived from the *base* name (handles extensionless UI).
            const imgFromBase = join(fromDir, `${fromBase}.img`)
            const partFromBase = join(fromDir, `${fromBase}.part`)

            const imgFromBaseExists = await pathExists(imgFromBase)
            const partFromBaseExists = await pathExists(partFromBase)

            // Decide what we’re actually renaming for the image payload:
            const fromImgAbs =
                isFromImgPath
                    ? fromAbs
                    : imgFromBaseExists
                    ? imgFromBase
                    : null

            const fromPartAbs =
                isFromImgPath
                    ? fromAbs.replace(/\.img$/i, '.part')
                    : partFromBaseExists
                    ? partFromBase
                    : null

            const toImgAbs =
                isToImgPath
                    ? toAbs
                    : join(toDir, `${toBase}.img`)

            const toPartAbs = toImgAbs.replace(/\.img$/i, '.part')

            const isImageGroupRename = !!fromImgAbs || !!fromPartAbs

            if (isImageGroupRename) {
                // Safeguard: do not overwrite existing targets for either .img or .part.
                if (fromImgAbs && toImgAbs !== fromImgAbs && (await pathExists(toImgAbs))) {
                    // Target .img already exists – silently no-op per UI contract.
                    return
                }
                if (fromPartAbs && toPartAbs !== fromPartAbs && (await pathExists(toPartAbs))) {
                    // Target .part already exists – silently no-op.
                    return
                }

                // Rename .img payload if present.
                if (fromImgAbs && (await pathExists(fromImgAbs))) {
                    await fsp.rename(fromImgAbs, toImgAbs)
                }

                // Rename .part sidecar if present.
                if (fromPartAbs && (await pathExists(fromPartAbs))) {
                    try {
                        await fsp.rename(fromPartAbs, toPartAbs)
                    } catch {
                        // If the .part rename fails, we don’t fail the entire op;
                        // worst case, the sidecar is left behind.
                    }
                }

                await this.emitFsUpdated()
                return
            }

            // -------------------------------------------------------------------
            // Generic fallback:
            // - Non-image files/folders.
            // - Behavior: do not overwrite existing targets, then rename.
            // -------------------------------------------------------------------

            // Silently reject if the target already exists (file or directory).
            // We do this before attempting the rename so we don't overwrite.
            try {
                await fsp.stat(toAbs)
                // If stat succeeded, something exists at toAbs -> no-op, no error.
                return
            } catch (err) {
                const e = err as NodeJS.ErrnoException
                // ENOENT / ENOTDIR => target does not exist; proceed with rename.
                if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) {
                    // Unexpected error looking up target; surface as a normal failure.
                    throw err
                }
            }

            // Simple rename (no image-group semantics)
            await fsp.rename(fromAbs, toAbs)

            await this.emitFsUpdated()
        } catch (err) {
            this.emitError(`renamePath failed: ${(err as Error).message}`)
        }
    }

    public async movePath(fromRel: string, destDirRel: string): Promise<void> {
        // console.log('[cf-imager] movePath', { fromRel, destDirRel })
        try {
            const fromAbs = resolveUnderRoot(this.config.rootDir, fromRel)
            const destDirAbs = resolveUnderRoot(this.config.rootDir, destDirRel || '.')

            // Ensure destination exists and is a directory.
            try {
                const destStat = await fsp.stat(destDirAbs)
                if (!destStat.isDirectory()) {
                    this.emitError('movePath failed: destination is not a directory')
                    return
                }
            } catch (err) {
                const e = err as NodeJS.ErrnoException
                if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
                    this.emitError('movePath failed: destination directory not found')
                    return
                }
                throw err
            }

            const fromDir = dirname(fromAbs)
            const fromBase = basename(fromAbs)

            const isFromImgPath = fromBase.toLowerCase().endsWith('.img')

            // Small helper: existence check without throwing
            const pathExists = async (p: string): Promise<boolean> => {
                try {
                    await fsp.stat(p)
                    return true
                } catch (err) {
                    const e = err as NodeJS.ErrnoException
                    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
                        return false
                    }
                    throw err
                }
            }

            // -------------------------------------------------------------------
            // Image-group aware branch:
            //
            // Treat "<name>.img" and "<name>.part" as a logical unit when moving,
            // regardless of whether fromRel is extensionless or includes ".img".
            // -------------------------------------------------------------------

            const imgFromBase = join(fromDir, `${fromBase}.img`)
            const partFromBase = join(fromDir, `${fromBase}.part`)

            const imgFromBaseExists = await pathExists(imgFromBase)
            const partFromBaseExists = await pathExists(partFromBase)

            const fromImgAbs =
                isFromImgPath
                    ? fromAbs
                    : imgFromBaseExists
                    ? imgFromBase
                    : null

            const fromPartAbs =
                isFromImgPath
                    ? fromAbs.replace(/\.img$/i, '.part')
                    : partFromBaseExists
                    ? partFromBase
                    : null

            const toImgAbs = fromImgAbs
                ? isFromImgPath
                    ? join(destDirAbs, fromBase)
                    : join(destDirAbs, `${fromBase}.img`)
                : null

            const toPartAbs =
                fromPartAbs && toImgAbs
                    ? toImgAbs.replace(/\.img$/i, '.part')
                    : fromPartAbs
                    ? join(destDirAbs, basename(fromPartAbs))
                    : null

            const isImageGroupMove = !!fromImgAbs || !!fromPartAbs

            if (isImageGroupMove) {
                // Do not overwrite existing image targets.
                if (fromImgAbs && toImgAbs && toImgAbs !== fromImgAbs && (await pathExists(toImgAbs))) {
                    // Target .img already exists – silently no-op per UI contract.
                    return
                }
                if (fromPartAbs && toPartAbs && toPartAbs !== fromPartAbs && (await pathExists(toPartAbs))) {
                    // Target .part already exists – silently no-op.
                    return
                }

                // Move .img payload if present.
                if (fromImgAbs && toImgAbs && (await pathExists(fromImgAbs))) {
                    await fsp.rename(fromImgAbs, toImgAbs)
                }

                // Move .part sidecar if present.
                if (fromPartAbs && toPartAbs && (await pathExists(fromPartAbs))) {
                    try {
                        await fsp.rename(fromPartAbs, toPartAbs)
                    } catch {
                        // If the .part move fails, we don’t fail the entire op;
                        // worst case, the sidecar is left behind.
                    }
                }

                await this.emitFsUpdated()
                return
            }

            // -------------------------------------------------------------------
            // Generic fallback:
            // - Non-image files/folders.
            // - Behavior: do not overwrite existing targets, then move.
            // -------------------------------------------------------------------

            const toAbs = join(destDirAbs, fromBase)

            // Silently reject if the target already exists (file or directory).
            try {
                await fsp.stat(toAbs)
                // Something exists at toAbs -> no-op, no error.
                return
            } catch (err) {
                const e = err as NodeJS.ErrnoException
                // ENOENT / ENOTDIR => target does not exist; proceed with move.
                if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) {
                    // Unexpected error looking up target; surface as a normal failure.
                    throw err
                }
            }

            await fsp.rename(fromAbs, toAbs)

            await this.emitFsUpdated()
        } catch (err) {
            this.emitError(`movePath failed: ${(err as Error).message}`)
        }
    }

    public async deletePath(relPath: string): Promise<void> {
        // console.log('[cf-imager] deletePath', { relPath })
        try {
            const abs = resolveUnderRoot(this.config.rootDir, relPath)
            const dirAbs = dirname(abs)
            const base = basename(abs)

            // -------------------------------------------------------------------
            // Case 1: UI hides extensions and sends just "foo", but the actual
            // files are "foo.img" and "foo.part" in the same directory.
            //
            // If either <base>.img or <base>.part exists, treat this as an image
            // delete and remove those files explicitly.
            // -------------------------------------------------------------------

            const imgFromBase = join(dirAbs, `${base}.img`)
            const partFromBase = join(dirAbs, `${base}.part`)

            const imgFromBaseExists = await fsp
                .stat(imgFromBase)
                .then(() => true)
                .catch(() => false)

            const partFromBaseExists = await fsp
                .stat(partFromBase)
                .then(() => true)
                .catch(() => false)

            if (imgFromBaseExists || partFromBaseExists) {
                // Delete the .img payload if present
                if (imgFromBaseExists) {
                    try {
                        await fsp.unlink(imgFromBase)
                    } catch {
                        // ignore unlink errors; we'll still try to clean up .part
                    }
                }

                // Delete the .part sidecar if present
                if (partFromBaseExists) {
                    try {
                        await fsp.unlink(partFromBase)
                    } catch {
                        // ignore unlink errors
                    }
                }

                await this.emitFsUpdated()
                return
            }

            // -------------------------------------------------------------------
            // Case 2: Fall back to existing behavior.
            // - relPath points to the actual file/folder.
            // - If it's an explicit .img path, also remove its .part companion.
            // -------------------------------------------------------------------

            const baseAbs = basename(abs)

            // If file looks like an .img, try to remove .part as well.
            if (baseAbs.toLowerCase().endsWith('.img')) {
                const part = abs.replace(/\.img$/i, '.part')
                try {
                    await fsp.unlink(part)
                } catch {
                    // ignore
                }
            }

            // Best-effort directory vs file removal.
            try {
                await fsp.rm(abs, { recursive: true, force: true })
            } catch {
                // If rm fails (e.g. not a directory), fall back to unlink.
                try {
                    await fsp.unlink(abs)
                } catch {
                    // If this also fails, surface as a single error below.
                    // We'll let emitError catch it via the outer try/catch.
                    throw new Error(`Failed to delete path "${relPath}"`)
                }
            }

            await this.emitFsUpdated()
        } catch (err) {
            this.emitError(`deletePath failed: ${(err as Error).message}`)
        }
    }


    /* ---------------------------------------------------------------------- */
    /*  Imaging operations (write now wired, read already wired)              */
    /* ---------------------------------------------------------------------- */

    private async ensureDeviceAndMediaForOp(opName: string): Promise<boolean> {
        /*
        console.log('[cf-imager] ensureDeviceAndMediaForOp', {
            opName,
            hasDevice: !!this.device,
            hasChild: !!this.child,
            media: this.state.media,
        })
        */

        if (!this.device) {
            this.emitError(`${opName}: device not connected`)
            return false
        }
        if (this.child) {
            this.emitError(`${opName}: operation already in progress`)
            return false
        }

        // Re-probe media right before we start the operation so we're aligned
        // with whatever the OS currently sees.
        await this.refreshMediaStatus()

        if (this.state.media === 'none') {
            this.emitError(`${opName}: no CF media detected in reader`)
            return false
        }

        if (this.state.media === 'unknown') {
            this.emitError(`${opName}: CF media status unknown; please refresh or reinsert card`)
            return false
        }

        // Reset progress samples for the new operation.
        this.progressSamples = []

        return true
    }

    public async writeImageToDevice(imageRelPath: string): Promise<void> {
        // console.log('[cf-imager] writeImageToDevice requested', { imageRelPath })
        if (!await this.ensureDeviceAndMediaForOp('writeImageToDevice')) return

        // UI sends an extensionless image name (e.g. "Shuttle-GeForce2")
        // relative to the current cwd. We must reconstruct "<cwd>/<name>.img"
        // under CF_IMAGER_ROOT and treat ONLY that as a valid image.
        const safeName = sanitizeName(imageRelPath)
        if (!safeName) {
            this.emitError('writeImageToDevice: image name is required')
            this.state.phase = 'idle'
            return
        }

        const relWithImg = join(this.relCwd(), `${safeName}.img`)

        let imgAbs: string
        try {
            imgAbs = resolveUnderRoot(this.config.rootDir, relWithImg)
        } catch (err) {
            this.emitError(
                `writeImageToDevice: invalid image name "${imageRelPath}": ${(err as Error).message}`
            )
            this.state.phase = 'idle'
            return
        }

        try {
            const st = await fsp.stat(imgAbs)
            if (!st.isFile()) {
                this.emitError(
                    `writeImageToDevice: image path is not a regular file: "${safeName}.img"`
                )
                this.state.phase = 'idle'
                return
            }
        } catch {
            this.emitError(
                `writeImageToDevice: image file not found: "${safeName}.img"`
            )
            this.state.phase = 'idle'
            return
        }

        const script = this.config.writeScriptPath
        if (!script) {
            this.emitError('writeImageToDevice: writeScriptPath is not configured')
            this.state.phase = 'idle'
            return
        }

        const imgRel = this.relFromRoot(imgAbs)
        const nowIso = new Date().toISOString()

        const op: CfImagerCurrentOp = {
            kind: 'write',
            source: imgRel,
            destination: this.device!.path,
            startedAt: nowIso,
            progressPct: 0,
        }

        this.state.phase = 'busy'
        this.state.currentOp = op
        this.state.message = undefined

        // Reset progress samples specifically for this op (seed at 0 bytes).
        this.progressSamples = [{ t: Date.now(), bytes: 0 }]

        this.deps.events.publish({
            kind: 'cf-op-started',
            at: Date.now(),
            op,
        })

        // ------------------------------------------------------------------
        // Spawn the platform-specific write script and capture PROGRESS lines
        // ------------------------------------------------------------------

        try {
            const child = spawn(script, [imgAbs, this.device!.path], {
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            this.child = child

            // Stream stdout line-by-line, looking for PROGRESS lines.
            child.stdout.setEncoding('utf8')
            let stdoutBuf = ''

            child.stdout.on('data', (chunk: string) => {
                stdoutBuf += chunk
                let idx: number
                while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
                    const line = stdoutBuf.slice(0, idx).trim()
                    stdoutBuf = stdoutBuf.slice(idx + 1)
                    if (!line) continue

                    if (line.startsWith('PROGRESS ')) {
                        const progress = parseProgressLine(line)
                        if (progress) {
                            const { bytes, total, pct } = progress

                            /*
                            console.log(
                                '[cf-imager] progress (write):',
                                `bytes=${bytes} total=${total} pct=${pct}`
                            )
                            */

                            // Update our moving progress window for speed calculation.
                            this.recordProgressSample(bytes)

                            const speedBps = this.computeAverageSpeedBps()
                            const mbPerSec =
                                speedBps > 0
                                    ? speedBps / (1024 * 1024)
                                    : 0

                            // Update current op (service-local) and emit a cf-op-progress
                            if (this.state.currentOp && this.state.currentOp.kind === 'write') {
                                const updatedOp: CfImagerCurrentOp = {
                                    ...this.state.currentOp,
                                    progressPct: pct,
                                    bytesDone: bytes,
                                    bytesTotal: total,
                                    bytesPerSec: speedBps,
                                    mbPerSec,
                                }

                                this.state.currentOp = updatedOp

                                this.deps.events.publish({
                                    kind: 'cf-op-progress',
                                    at: Date.now(),
                                    op: updatedOp,
                                })
                            }
                        }
                    }
                }
            })

            // Optional: stderr logging for debugging
            child.stderr.setEncoding('utf8')
            child.stderr.on('data', (chunk: string) => {
                const text = String(chunk).trim()
                if (text) {
                    console.error('[cf-imager] write-image stderr:', text)
                }
            })

            child.on('error', (err) => {
                console.error('[cf-imager] writeImageToDevice spawn error:', err)
                this.child = null
                this.emitError(`writeImageToDevice failed to start: ${(err as Error).message}`)
                this.state.phase = 'idle'
                this.state.currentOp = undefined

                // Ensure watchdog remains active.
                this.resumeFsWatchdogAfterOp({ refreshFs: false })
            })

            child.on('close', (code, signal) => {
                this.child = null

                if (code === 0) {
                    // Successful completion
                    this.state.phase = 'idle'
                    this.state.message = 'Write complete'

                    // Final progress snapshot for clients: force 100% and full bytes.
                    const finalOp: CfImagerCurrentOp = this.state.currentOp
                        ? {
                              ...this.state.currentOp,
                              progressPct: 100,
                              bytesDone:
                                  typeof this.state.currentOp.bytesDone === 'number'
                                      ? this.state.currentOp.bytesDone
                                      : this.state.currentOp.bytesTotal ?? 0,
                          }
                        : {
                              ...op,
                              progressPct: 100,
                          }

                    this.deps.events.publish({
                        kind: 'cf-op-completed',
                        at: Date.now(),
                        op: finalOp,
                    })

                    // Writes do not change CF_IMAGER_ROOT, so no FS refresh needed.
                    this.resumeFsWatchdogAfterOp({ refreshFs: false })
                } else {
                    const reason =
                        code !== null
                            ? `exit code ${code}`
                            : signal
                            ? `signal ${signal}`
                            : 'unknown failure'
                    this.emitError(`writeImageToDevice script failed (${reason})`)

                    // Even on failure, keep the FS watchdog healthy.
                    this.resumeFsWatchdogAfterOp({ refreshFs: false })
                }

                this.state.currentOp = undefined
                this.progressSamples = []
            })
        } catch (err) {
            this.child = null
            this.emitError(`writeImageToDevice: spawn failed: ${(err as Error).message}`)
            this.state.phase = 'idle'
            this.state.currentOp = undefined

            this.resumeFsWatchdogAfterOp({ refreshFs: false })
            this.progressSamples = []
        }
    }

    public async readDeviceToImage(targetDirRel: string, imageName: string): Promise<void> {
        // console.log('[cf-imager] readDeviceToImage requested', { targetDirRel, imageName })
        if (!await this.ensureDeviceAndMediaForOp('readDeviceToImage')) return

        const safeName = sanitizeName(imageName)
        if (!safeName) {
            this.emitError('readDeviceToImage: imageName is required')
            return
        }

        const targetDirAbs = resolveUnderRoot(this.config.rootDir, targetDirRel || '.')
        const imgPathAbs = join(targetDirAbs, `${safeName}.img`)

        const imgRel = this.relFromRoot(imgPathAbs)
        const nowIso = new Date().toISOString()

        const op: CfImagerCurrentOp = {
            kind: 'read',
            source: this.device!.path,
            destination: imgRel,
            startedAt: nowIso,
            progressPct: 0,
            // bytesDone/bytesTotal/bytesPerSec/mbPerSec will be filled in as
            // PROGRESS lines arrive.
        }

        this.state.phase = 'busy'
        this.state.currentOp = op
        this.state.message = undefined

        // Reset progress samples for this op specifically.
        this.progressSamples = [{ t: Date.now(), bytes: 0 }]

        this.deps.events.publish({
            kind: 'cf-op-started',
            at: Date.now(),
            op,
        })

        // ------------------------------------------------------------------
        // Spawn the platform-specific read script and capture PROGRESS lines
        // ------------------------------------------------------------------
        const script = this.config.readScriptPath
        if (!script) {
            this.emitError('readDeviceToImage: readScriptPath is not configured')
            this.state.phase = 'idle'
            this.state.currentOp = undefined
            return
        }

        try {
            const child = spawn(script, [this.device!.path, imgPathAbs], {
                // Use full pipes so this matches ChildProcessWithoutNullStreams
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            this.child = child

            // While the imaging operation is in progress, pause the FS watchdog
            // so it doesn't constantly rescan the directory and surface the
            // partially-written image.
            this.pauseFsWatchdogForOp()

            // Stream stdout line-by-line, looking for PROGRESS (and later, other) lines
            child.stdout.setEncoding('utf8')
            let stdoutBuf = ''

            child.stdout.on('data', (chunk: string) => {
                stdoutBuf += chunk
                let idx: number
                while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
                    const line = stdoutBuf.slice(0, idx).trim()
                    stdoutBuf = stdoutBuf.slice(idx + 1)
                    if (!line) continue

                    if (line.startsWith('PROGRESS ')) {
                        const progress = parseProgressLine(line)
                        if (progress) {
                            const { bytes, total, pct } = progress

                            // Debug logging so you can verify on macOS + Linux
                            /*
                            console.log(
                                '[cf-imager] progress (read):',
                                `bytes=${bytes} total=${total} pct=${pct}`
                            )
                            */

                            // Update our moving progress window for speed calculation.
                            this.recordProgressSample(bytes)

                            const speedBps = this.computeAverageSpeedBps()
                            const mbPerSec =
                                speedBps > 0
                                    ? speedBps / (1024 * 1024)
                                    : 0

                            // Update current op (service-local) and emit a cf-op-progress
                            if (this.state.currentOp && this.state.currentOp.kind === 'read') {
                                const updatedOp: CfImagerCurrentOp = {
                                    ...this.state.currentOp,
                                    progressPct: pct,
                                    bytesDone: bytes,
                                    bytesTotal: total,
                                    bytesPerSec: speedBps,
                                    mbPerSec,
                                }

                                this.state.currentOp = updatedOp

                                this.deps.events.publish({
                                    kind: 'cf-op-progress',
                                    at: Date.now(),
                                    op: updatedOp,
                                })
                            }
                        }
                    }
                }
            })

            // Optional: stderr logging for debugging
            child.stderr.setEncoding('utf8')
            child.stderr.on('data', (chunk: string) => {
                const text = String(chunk).trim()
                if (text) {
                    console.error('[cf-imager] read-image stderr:', text)
                }
            })

            child.on('error', (err) => {
                console.error('[cf-imager] readDeviceToImage spawn error:', err)
                this.child = null
                this.emitError(`readDeviceToImage failed to start: ${(err as Error).message}`)
                this.state.phase = 'idle'
                this.state.currentOp = undefined

                // Resume watchdog; the op has effectively terminated.
                this.resumeFsWatchdogAfterOp({ refreshFs: false })
            })

            child.on('close', (code, signal) => {
                this.child = null

                if (code === 0) {
                    // Successful completion
                    this.state.phase = 'idle'
                    this.state.message = 'Read complete'

                    // Final progress snapshot for clients: force 100% and full bytes.
                    const finalOp: CfImagerCurrentOp = this.state.currentOp
                        ? {
                              ...this.state.currentOp,
                              progressPct: 100,
                              // If bytes/total weren't set for some reason, fall back defensively.
                              bytesDone:
                                  typeof this.state.currentOp.bytesDone === 'number'
                                      ? this.state.currentOp.bytesDone
                                      : this.state.currentOp.bytesTotal ?? 0,
                          }
                        : {
                              ...op,
                              progressPct: 100,
                          }

                    // Emit cf-op-completed so the adapter can flip phase to idle
                    // and clear currentOp in AppState.
                    this.deps.events.publish({
                        kind: 'cf-op-completed',
                        at: Date.now(),
                        op: finalOp,
                    })

                    // After a successful read, refresh once so the new image
                    // shows up exactly when the operation has finished and the
                    // free-space value is updated too.
                    this.resumeFsWatchdogAfterOp({ refreshFs: true })
                } else {
                    const reason =
                        code !== null
                            ? `exit code ${code}`
                            : signal
                            ? `signal ${signal}`
                            : 'unknown failure'
                    this.emitError(`readDeviceToImage script failed (${reason})`)

                    // On failure, we still want to resume watchdog polling,
                    // and a full refresh is helpful to show whatever landed on disk
                    // and the corresponding free-space change.
                    this.resumeFsWatchdogAfterOp({ refreshFs: true })
                }

                this.state.currentOp = undefined
                // Reset progress samples for the next op.
                this.progressSamples = []
            })
        } catch (err) {
            this.child = null
            this.emitError(`readDeviceToImage: spawn failed: ${(err as Error).message}`)
            this.state.phase = 'idle'
            this.state.currentOp = undefined

            // Ensure watchdog is resumed even if spawn throws.
            this.resumeFsWatchdogAfterOp({ refreshFs: false })
            this.progressSamples = []
        }
    }

    /* ---------------------------------------------------------------------- */
    /*  Child-process management                                              */
    /* ---------------------------------------------------------------------- */

    private async cancelCurrentChild(
        reason: 'explicit-close' | 'device-lost' | 'io-error' | 'unknown'
    ): Promise<void> {
        const child = this.child
        this.child = null

        if (!child) return

        // console.log('[cf-imager] cancelCurrentChild', { reason })

        try {
            child.removeAllListeners()
            child.kill('SIGTERM')
        } catch {
            // ignore
        }

        // If we canceled an in-flight operation, make sure the watchdog can
        // resume. We don't force a refresh here; the caller can decide.
        this.resumeFsWatchdogAfterOp({ refreshFs: false })

        // Reset progress samples when an op is aborted.
        this.progressSamples = []

        if (this.device) {
            this.deps.events.publish({
                kind: 'cf-device-disconnected',
                at: Date.now(),
                deviceId: this.device.id,
                reason,
            })

            this.deps.events.publish({
                kind: 'cf-media-updated',
                at: Date.now(),
                media: 'none',
                device: undefined,
                sizeBytes: 0,
                message: 'CF reader disconnected (operation cancelled)',
            })
        }
    }

    /* ---------------------------------------------------------------------- */
    /*  Media probing (macOS + Linux)                                         */
    /* ---------------------------------------------------------------------- */

    /**
     * Refresh our understanding of whether a CF card is actually present in
     * the currently attached reader.
     *
     * We *only* look at the specific device path we got from discovery, so
     * other USB sticks / disks don’t confuse the picture.
     *
     * Logging policy:
     *   - Only log on state transitions:
     *       none -> present
     *       present -> none
     *       anything -> unknown
     *   - Single-line, no object dumping.
     */
    private async refreshMediaStatus(): Promise<void> {
        const prev = this.state.media

        if (!this.device) {
            this.state.media = 'none'
            if (prev !== this.state.media) {
                // const message = '[cf-imager] media status -> none (no device)'
                // console.log(message)
                this.deps.events.publish({
                    kind: 'cf-media-updated',
                    at: Date.now(),
                    media: this.state.media,
                    device: undefined,
                    sizeBytes: 0,
                    message: 'No CF reader attached',
                })
            }
            return
        }

        const devPath = this.device.path
        if (!devPath || devPath === 'unmounted') {
            this.state.media = 'none'
            if (prev !== this.state.media) {
                // const message = '[cf-imager] media status -> none (reader has no media path)'
                // console.log(message)
                this.deps.events.publish({
                    kind: 'cf-media-updated',
                    at: Date.now(),
                    media: this.state.media,
                    device: this.device ?? undefined,
                    sizeBytes: 0,
                    message: 'CF reader detected, no media path',
                })
            }
            return
        }

        let sizeBytes = 0

        try {
            if (process.platform === 'linux') {
                sizeBytes = await this.readLinuxBlockSize(devPath)
            } else if (process.platform === 'darwin') {
                sizeBytes = await this.readDarwinBlockSize(devPath)
            } else {
                this.state.media = 'unknown'
                if (prev !== this.state.media) {
                    // const message =
                    //     `[cf-imager] media status -> unknown (unsupported platform=${process.platform})`
                    // console.log(message)
                    this.deps.events.publish({
                        kind: 'cf-media-updated',
                        at: Date.now(),
                        media: this.state.media,
                        device: this.device ?? undefined,
                        sizeBytes: undefined,
                        message: 'CF media status unknown (unsupported platform)',
                    })
                }
                return
            }
        } catch (err) {
            this.state.media = 'unknown'
            if (prev !== this.state.media) {
                // const message =
                //     `[cf-imager] media status -> unknown (probe failed err="${(err as Error).message}")`
                // console.log(message)
                this.deps.events.publish({
                    kind: 'cf-media-updated',
                    at: Date.now(),
                    media: this.state.media,
                    device: this.device ?? undefined,
                    sizeBytes: undefined,
                    message: 'CF media status unknown (probe failed)',
                })
            }
            return
        }

        const next = sizeBytes > 0 ? 'present' : 'none'
        this.state.media = next

        if (prev !== next) {
            let logMsg: string
            let uiMsg: string

            if (next === 'present') {
                logMsg =
                    `[cf-imager] media status -> present sizeBytes=${sizeBytes} devicePath=${devPath}`
                uiMsg = 'CF card detected'
            } else if (prev === 'present' && next === 'none') {
                logMsg = '[cf-imager] media status -> none (media removed)'
                uiMsg = 'CF card removed from reader'
            } else {
                logMsg = `[cf-imager] media status -> ${next}`
                uiMsg = next === 'none'
                    ? 'No CF card detected in reader'
                    : 'CF media status changed'
            }

            // console.log(logMsg)

            this.deps.events.publish({
                kind: 'cf-media-updated',
                at: Date.now(),
                media: this.state.media,
                device: this.device ?? undefined,
                sizeBytes,
                message: uiMsg,
            })
        }
    }

    /**
     * Linux: read block size from /sys/block/<dev>/size (in 512-byte sectors)
     * and convert to bytes.
     *
     * This matches the discovery logic that already relies on /sys/block.
     */
    private async readLinuxBlockSize(devPath: string): Promise<number> {
        // devPath is usually like "/dev/sda"; strip the prefix if present.
        const name = devPath.startsWith('/dev/') ? devPath.slice('/dev/'.length) : devPath

        const script = `
    set -e
    blk="/sys/block/${name}"
    if [ ! -d "$blk" ]; then
    exit 0
    fi
    sizeFile="$blk/size"
    if [ ! -f "$sizeFile" ]; then
    exit 0
    fi
    size=$(cat "$sizeFile" 2>/dev/null || echo "0")
    echo "$size"
    `.trim()

        const out = await this.runShell(script)
        const trimmed = out.trim().split('\n').pop() ?? ''
        if (!trimmed) return 0

        const sectors = Number.parseInt(trimmed, 10)
        if (!Number.isFinite(sectors) || sectors <= 0) return 0

        const bytes = sectors * 512
        return bytes > 0 ? bytes : 0
    }

    /**
     * macOS: use diskutil + plutil to get a JSON plist and read TotalSize.
     *
     * NOTE: no logging here; all logging is done at the state-transition level
     * in refreshMediaStatus().
     */
    private async readDarwinBlockSize(devPath: string): Promise<number> {
        const script =
            `diskutil info -plist "${devPath}" ` +
            `| plutil -convert json -o - -`

        const out = await this.runShell(script)
        if (!out.trim()) return 0

        try {
            const parsed = JSON.parse(out) as any
            const sz =
                typeof parsed?.TotalSize === 'number'
                    ? parsed.TotalSize
                    : typeof parsed?.Size === 'number'
                    ? parsed.Size
                    : 0
            return typeof sz === 'number' && sz > 0 ? sz : 0
        } catch {
            // Parsing failed; treat as "no media".
            return 0
        }
    }

    /**
     * Run a single command and capture stdout as UTF-8 text.
     * Used for lsblk-style calls (no shell, no pipes).
     *
     * NOTE: no logging here; failures are surfaced via thrown errors.
     */
    private runCommand(cmd: string, args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })

            let stdout = ''
            let stderr = ''

            child.stdout.setEncoding('utf8')
            child.stdout.on('data', (chunk) => {
                stdout += String(chunk)
            })

            child.stderr.setEncoding('utf8')
            child.stderr.on('data', (chunk) => {
                stderr += String(chunk)
            })

            child.on('error', (err) => {
                reject(err)
            })

            child.on('close', (code) => {
                if (code === 0) resolve(stdout)
                else reject(new Error(`${cmd} exited with code ${code}: ${stderr}`))
            })
        })
    }

    /**
     * Run a small shell script (used on macOS for piped diskutil/plutil).
     *
     * NOTE: no logging here; failures are surfaced via thrown errors.
     */
    private runShell(script: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const child = spawn('sh', ['-c', script], {
                stdio: ['ignore', 'pipe', 'pipe'],
            })

            let stdout = ''
            let stderr = ''

            child.stdout.setEncoding('utf8')
            child.stdout.on('data', (chunk) => {
                stdout += String(chunk)
            })

            child.stderr.setEncoding('utf8')
            child.stderr.on('data', (chunk) => {
                stderr += String(chunk)
            })

            child.on('error', (err) => {
                reject(err)
            })

            child.on('close', (code) => {
                if (code === 0) resolve(stdout)
                else reject(new Error(`shell exited with code ${code}: ${stderr}`))
            })
        })
    }

    /* ---------------------------------------------------------------------- */
    /*  Internal helpers                                                       */
    /* ---------------------------------------------------------------------- */

    private relCwd(): string {
        return this.relFromRoot(this.cwdAbs)
    }

    private relFromRoot(absPath: string): string {
        const fs = listDirectoryState(
            this.config.rootDir,
            absPath,
            this.config.maxEntriesPerDir,
            this.config.visibleExtensions
        )
        return fs.cwd
    }

    /**
     * Compute the current available disk space (in bytes) on the filesystem
     * that backs the configured CF image root directory.
     *
     * This is intentionally conservative and shell-based so it behaves
     * consistently with the rest of the service's platform-specific probes.
     */
    private async getDiskFreeBytes(): Promise<number | undefined> {
        const root = this.config.rootDir

        try {
            if (process.platform === 'linux') {
                // df -B1 <path> => size in bytes; 4th column is "Available".
                const script = `
set -e
df -B1 "${root}" | awk 'NR==2 { print $4 }'
`.trim()

                const out = await this.runShell(script)
                const val = out.trim().split('\n').pop() ?? ''
                if (!val) return undefined

                const bytes = Number(val)
                return Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined
            }

            if (process.platform === 'darwin') {
                // df -k <path> => "Available" in KiB; multiply by 1024 to get bytes.
                const script = `
set -e
df -k "${root}" | awk 'NR==2 { print $4 }'
`.trim()

                const out = await this.runShell(script)
                const val = out.trim().split('\n').pop() ?? ''
                if (!val) return undefined

                const kbytes = Number(val)
                if (!Number.isFinite(kbytes) || kbytes < 0) return undefined
                return kbytes * 1024
            }

            // Unsupported platforms: we don't attempt to compute free space.
            return undefined
        } catch {
            // Treat any failure as "unknown"; callers decide how to expose it.
            return undefined
        }
    }

    /**
     * Emit a fresh FS snapshot unconditionally (used by direct FS APIs),
     * and compute the current available disk space on the same volume.
     */
    private async emitFsUpdated(): Promise<void> {
        const fs = listDirectoryState(
            this.config.rootDir,
            this.cwdAbs,
            this.config.maxEntriesPerDir,
            this.config.visibleExtensions
        )
        this.state.fs = fs

        const diskFreeBytes = await this.getDiskFreeBytes()
        this.state.diskFreeBytes = diskFreeBytes

        this.deps.events.publish({
            kind: 'cf-fs-updated',
            at: Date.now(),
            fs,
            diskFreeBytes,
        })
    }

    /**
     * Start the periodic FS watchdog if configured.
     */
    private startFsPolling(): void {
        const interval = this.config.fsPollIntervalMs ?? 0
        if (interval <= 0) {
            return
        }

        if (this.fsPollTimer) {
            // Already running
            return
        }

        // Immediate initial poll to sync any changes after process start.
        void this.pollFsOnce()

        this.fsPollTimer = setInterval(() => {
            void this.pollFsOnce()
        }, interval)
    }

    /**
     * Stop the periodic FS watchdog (used when the service stops or when
     * a long-running imaging operation is in progress).
     */
    private stopFsPolling(): void {
        if (this.fsPollTimer) {
            clearInterval(this.fsPollTimer)
            this.fsPollTimer = null
        }
    }

    /**
     * Pause watchdog specifically for a long-running imaging operation so
     * partial files (e.g., the image being written) don't surface mid-flight.
     */
    private pauseFsWatchdogForOp(): void {
        this.stopFsPolling()
    }

    /**
     * Resume the watchdog after an imaging operation has completed or failed.
     * Optionally emit a one-shot FS refresh so the UI sees the final state and
     * updated disk-free value.
     */
    private resumeFsWatchdogAfterOp(opts: { refreshFs: boolean }): void {
        if (opts.refreshFs) {
            void this.emitFsUpdated()
        }

        this.startFsPolling()
    }

    /**
     * Record a new (time, bytesDone) sample and keep only a small trailing window
     * so we can compute a moving-average transfer speed.
     */
    private recordProgressSample(bytes: number): void {
        const now = Date.now()
        this.progressSamples.push({ t: now, bytes })

        // Keep the last few samples (e.g., 5) so short bursts don't dominate.
        const MAX_SAMPLES = 5
        if (this.progressSamples.length > MAX_SAMPLES) {
            this.progressSamples.splice(0, this.progressSamples.length - MAX_SAMPLES)
        }
    }

    /**
     * Compute average bytes/sec over the current progress sample window.
     */
    private computeAverageSpeedBps(): number {
        if (this.progressSamples.length < 2) return 0

        const first = this.progressSamples[0]
        const last = this.progressSamples[this.progressSamples.length - 1]

        const dtMs = last.t - first.t
        if (dtMs <= 0) return 0

        const dBytes = last.bytes - first.bytes
        if (dBytes <= 0) return 0

        const dtSec = dtMs / 1000
        return dBytes / dtSec
    }

    /**
     * Poll the current cwd for changes and emit cf-fs-updated only when the
     * snapshot actually differs from the last known state.
     *
     * This is used by the optional periodic watcher so we don't spam clients
     * when nothing has changed.
     */
    private async pollFsOnce(): Promise<void> {
        try {
            // Explicitly check whether the current cwd still exists.
            try {
                await fsp.stat(this.cwdAbs)
            } catch (err) {
                const e = err as NodeJS.ErrnoException
                if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
                    /*
                    console.warn(
                        '[cf-imager] pollFsOnce: cwd no longer exists on disk, resetting to rootDir',
                        {
                            cwdAbs: this.cwdAbs,
                            rootDir: this.config.rootDir,
                            err: e.message,
                        }
                    )
                    */

                    // Hard reset to rootDir and emit a fresh snapshot.
                    this.cwdAbs = this.config.rootDir
                    await this.emitFsUpdated()
                    return
                }

                // Other stat errors: log and bail out of this poll cycle.
                console.warn(
                    '[cf-imager] pollFsOnce: stat failed for cwd',
                    { cwdAbs: this.cwdAbs, err: e?.message ?? String(err) }
                )
                return
            }

            const nextFs = listDirectoryState(
                this.config.rootDir,
                this.cwdAbs,
                this.config.maxEntriesPerDir,
                this.config.visibleExtensions
            )

            if (fsStateEquals(this.state.fs, nextFs)) {
                return
            }

            this.state.fs = nextFs

            const diskFreeBytes = await this.getDiskFreeBytes()
            this.state.diskFreeBytes = diskFreeBytes

            this.deps.events.publish({
                kind: 'cf-fs-updated',
                at: Date.now(),
                fs: nextFs,
                diskFreeBytes,
            })
        } catch (err) {
            const e = err as NodeJS.ErrnoException

            console.warn(
                '[cf-imager] pollFsOnce: failed to refresh directory state',
                { err: e?.message ?? String(err) }
            )
        }
    }

    private emitError(msg: string): void {
        console.error(
            `[cf-imager] emitError msg="${msg}" hasDevice=${this.device ? 'true' : 'false'}`
        )

        if (this.device) {
            this.state.phase = 'error'
        } else {
            this.state.phase = 'disconnected'
            this.state.media = 'none'
        }

        this.state.lastError = msg
        this.state.message = msg

        this.deps.events.publish({
            kind: 'cf-error',
            at: Date.now(),
            error: msg,
        })
    }
}

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function sanitizeName(name: string | undefined): string {
    if (!name) return ''
    const trimmed = name.trim()
    if (!trimmed) return ''

    // For v1: disallow path separators and "..".
    if (trimmed.includes('/') || trimmed.includes('\\')) return ''
    if (trimmed === '.' || trimmed === '..') return ''
    return trimmed
}

/**
 * Parse a PROGRESS line from the read/write image scripts.
 *
 * Expected formats (both platforms share the same keys):
 *   PROGRESS bytes=281018368 total=12572352512 pct=2.235 rate=46299681 elapsed=6.069553
 *   PROGRESS bytes=880925230 total=12584646144 pct=7
 */
function parseProgressLine(line: string): { bytes: number; total: number; pct: number } | null {
    // Strip leading "PROGRESS " and split into key=value tokens
    const rest = line.slice('PROGRESS'.length).trim()
    if (!rest) return null

    const parts = rest.split(/\s+/)
    const kv: Record<string, string> = {}

    for (const p of parts) {
        const eqIdx = p.indexOf('=')
        if (eqIdx === -1) continue
        const key = p.slice(0, eqIdx)
        const value = p.slice(eqIdx + 1)
        if (key && value !== undefined) {
            kv[key] = value
        }
    }

    const bytes = Number(kv.bytes)
    const total = Number(kv.total)
    const pct = Number(kv.pct)

    if (!Number.isFinite(bytes) || !Number.isFinite(total) || !Number.isFinite(pct)) {
        return null
    }

    return { bytes, total, pct }
}

/**
 * Cheap structural equality for FS snapshots so we avoid emitting identical
 * cf-fs-updated events on every poll.
 */
function fsStateEquals(a: CfImagerFsState, b: CfImagerFsState): boolean {
    if (a === b) return true
    if (!a || !b) return false

    if (a.rootPath !== b.rootPath) return false
    if (a.cwd !== b.cwd) return false

    const ea = a.entries
    const eb = b.entries

    if (ea.length !== eb.length) return false

    for (let i = 0; i < ea.length; i++) {
        const x = ea[i]
        const y = eb[i]
        if (!y) return false
        if (x.name !== y.name) return false
        if (x.kind !== y.kind) return false
        if (x.sizeBytes !== y.sizeBytes) return false
        if (x.modifiedAt !== y.modifiedAt) return false
    }

    return true
}
