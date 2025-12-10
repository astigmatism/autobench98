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
 * - Spawns external bash scripts to read/write CF images (stubbed initially).
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
        const interval = this.config.fsPollIntervalMs ?? 0
        if (interval > 0) {
            if (this.fsPollTimer) {
                clearInterval(this.fsPollTimer)
                this.fsPollTimer = null
            }

            // Immediate initial poll to sync any changes after process start.
            void this.pollFsOnce()

            this.fsPollTimer = setInterval(() => {
                void this.pollFsOnce()
            }, interval)
        }
    }

    public async stop(): Promise<void> {
        // console.log('[cf-imager] stop() called')

        if (this.fsPollTimer) {
            clearInterval(this.fsPollTimer)
            this.fsPollTimer = null
        }

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
        this.emitFsUpdated()

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
            this.emitFsUpdated()
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

            // On successful creation, refresh FS snapshot so the UI shows the new folder.
            this.emitFsUpdated()
        } catch (err) {
            this.emitError(`createFolder failed: ${(err as Error).message}`)
        }
    }

    public async renamePath(fromRel: string, toRel: string): Promise<void> {
        // console.log('[cf-imager] renamePath', { fromRel, toRel })
        try {
            const fromAbs = resolveUnderRoot(this.config.rootDir, fromRel)
            const toAbs = resolveUnderRoot(this.config.rootDir, toRel)

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

            // Rename main path
            await fsp.rename(fromAbs, toAbs)

            // If this is a .img rename, also handle .part companion.
            const fromBase = basename(fromAbs)
            const toBase = basename(toAbs)

            if (fromBase.toLowerCase().endsWith('.img')) {
                const fromPart = fromAbs.replace(/\.img$/i, '.part')
                const toPart = toAbs.replace(/\.img$/i, '.part')
                try {
                    await fsp.rename(fromPart, toPart)
                } catch {
                    // .part may not exist; silently ignore.
                }
            }

            this.emitFsUpdated()
        } catch (err) {
            this.emitError(`renamePath failed: ${(err as Error).message}`)
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

                this.emitFsUpdated()
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

            this.emitFsUpdated()
        } catch (err) {
            this.emitError(`deletePath failed: ${(err as Error).message}`)
        }
    }

    /* ---------------------------------------------------------------------- */
    /*  Imaging operations (still stubbed, but media-aware)                   */
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

        return true
    }

    public async writeImageToDevice(imageRelPath: string): Promise<void> {
        // console.log('[cf-imager] writeImageToDevice requested', { imageRelPath })
        if (!await this.ensureDeviceAndMediaForOp('writeImageToDevice')) return

        const now = new Date().toISOString()
        const op: CfImagerCurrentOp = {
            kind: 'write',
            source: imageRelPath,
            destination: this.device!.path,
            startedAt: now,
            progressPct: 0,
        }

        this.state.phase = 'busy'
        this.state.currentOp = op
        this.state.message = undefined

        this.deps.events.publish({
            kind: 'cf-op-started',
            at: Date.now(),
            op,
        })

        // TODO: replace this stub with spawn(this.config.writeScriptPath, [...])
        this.deps.events.publish({
            kind: 'cf-op-error',
            at: Date.now(),
            op,
            error: 'writeImageToDevice not yet implemented',
        })

        this.state.phase = 'idle'
        this.state.currentOp = undefined
        this.state.message = 'Write not yet implemented'

        // console.log('[cf-imager] writeImageToDevice stub completed')
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
        const now = new Date().toISOString()

        const op: CfImagerCurrentOp = {
            kind: 'read',
            source: this.device!.path,
            destination: imgRel,
            startedAt: now,
            progressPct: 0,
        }

        this.state.phase = 'busy'
        this.state.currentOp = op
        this.state.message = undefined

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

            // Stream stdout line-by-line, looking for PROGRESS lines
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
                            console.log(
                                '[cf-imager] progress (read):',
                                `bytes=${bytes} total=${total} pct=${pct}`
                            )

                            // Update current op for future UI wiring
                            if (this.state.currentOp && this.state.currentOp.kind === 'read') {
                                this.state.currentOp.progressPct = pct
                                // We can extend CfImagerCurrentOp later to store bytes/total if desired.
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
            })

            child.on('close', (code, signal) => {
                this.child = null

                if (code === 0) {
                    // Successful completion
                    this.state.phase = 'idle'
                    this.state.message = 'Read complete'
                    // Optionally emit a cf-op-completed event later
                } else {
                    const reason =
                        code !== null
                            ? `exit code ${code}`
                            : signal
                            ? `signal ${signal}`
                            : 'unknown failure'
                    this.emitError(`readDeviceToImage script failed (${reason})`)
                }

                this.state.currentOp = undefined
            })
        } catch (err) {
            this.child = null
            this.emitError(`readDeviceToImage: spawn failed: ${(err as Error).message}`)
            this.state.phase = 'idle'
            this.state.currentOp = undefined
        }
    }

    /* ---------------------------------------------------------------------- */
    /*  Child-process management (future wiring)                               */
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
                 //    `[cf-imager] media status -> unknown (probe failed err="${(err as Error).message}")`
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
     * Emit a fresh FS snapshot unconditionally (used by direct FS APIs).
     */
    private emitFsUpdated(): void {
        const fs = listDirectoryState(
            this.config.rootDir,
            this.cwdAbs,
            this.config.maxEntriesPerDir,
            this.config.visibleExtensions
        )
        this.state.fs = fs

        this.deps.events.publish({
            kind: 'cf-fs-updated',
            at: Date.now(),
            fs,
        })
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
                    this.emitFsUpdated()
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

            this.deps.events.publish({
                kind: 'cf-fs-updated',
                at: Date.now(),
                fs: nextFs,
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
 * Parse a PROGRESS line from the read-image scripts.
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