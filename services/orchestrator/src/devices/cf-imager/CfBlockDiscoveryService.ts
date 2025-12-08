/* eslint-disable no-console */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'

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

// How often to re-probe media while a reader is attached (ms).
// This is intentionally modest to avoid log spam but keep UI responsive.
const MEDIA_POLL_INTERVAL_MS = 3000

export class CfBlockDiscoveryService {
    private readonly config: CfImagerConfig
    private readonly deps: CfImagerServiceDeps

    private state: CfImagerState
    private device: CfImagerDeviceInfo | null = null

    /** Current working directory (absolute path under root). */
    private cwdAbs: string

    /** Single in-flight child process for read/write (if any). */
    private child: ChildProcessWithoutNullStreams | null = null

    /** Periodic media probe timer while a reader is attached. */
    private mediaPollTimer: NodeJS.Timeout | null = null

    constructor(config: CfImagerConfig, deps: CfImagerServiceDeps) {
        this.config = config
        this.deps = deps

        const root = config.rootDir
        this.cwdAbs = root

        const fs: CfImagerFsState = listDirectoryState(
            root,
            this.cwdAbs,
            this.config.maxEntriesPerDir
        )

        this.state = {
            phase: 'disconnected',
            media: 'none',
            fs,
        }

        console.log(
            '[cf-imager] service constructed',
            JSON.stringify({
                rootDir: this.config.rootDir,
                maxEntriesPerDir: this.config.maxEntriesPerDir,
                readScriptPath: this.config.readScriptPath,
                writeScriptPath: this.config.writeScriptPath,
            })
        )
    }

    /* ---------------------------------------------------------------------- */
    /*  Public API                                                            */
    /* ---------------------------------------------------------------------- */

    public async start(): Promise<void> {
        console.log('[cf-imager] start() called (no-op; waiting for device discovery)')
        // No-op for now; device lifecycle is fully driven by discovery.
    }

    public async stop(): Promise<void> {
        console.log('[cf-imager] stop() called')
        await this.cancelCurrentChild('explicit-close')
        this.stopMediaPolling()

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

        // Reset any previous polling and start a fresh cycle for this device.
        this.stopMediaPolling()
        void this.refreshMediaStatus()
        this.startMediaPolling()
    }

    public async onDeviceLost(args: { id: string }): Promise<void> {
        console.log('[cf-imager] onDeviceLost', JSON.stringify({ id: args.id }))

        if (!this.device || this.device.id !== args.id) {
            console.log(
                '[cf-imager] onDeviceLost: ignoring, current device is',
                this.device ? this.device.id : 'none'
            )
            return
        }

        await this.cancelCurrentChild('device-lost')
        this.stopMediaPolling()

        const lostId = this.device.id
        this.device = null

        this.state.phase = 'disconnected'
        this.state.media = 'none'
        this.state.device = undefined
        this.state.message = 'Device lost'

        this.deps.events.publish({
            kind: 'cf-device-disconnected',
            at: Date.now(),
            deviceId: lostId,
            reason: 'device-lost',
        })

        // Also reflect media state explicitly for the adapter / pane.
        this.deps.events.publish({
            kind: 'cf-media-updated',
            at: Date.now(),
            media: 'none',
            device: undefined,
            sizeBytes: 0,
            message: 'CF reader disconnected',
        })
    }

    /* ---------------------------------------------------------------------- */
    /*  Filesystem API (used by commands / pane)                              */
    /* ---------------------------------------------------------------------- */

    public async listDirectory(relPath: string | undefined): Promise<void> {
        console.log('[cf-imager] listDirectory', { relPath })
        try {
            const abs = resolveUnderRoot(this.config.rootDir, relPath ?? '.')
            this.cwdAbs = abs
            this.emitFsUpdated()
        } catch (err) {
            this.emitError(`listDirectory failed: ${(err as Error).message}`)
        }
    }

    public async changeDirectory(newRel: string): Promise<void> {
        console.log('[cf-imager] changeDirectory', { newRel })
        await this.listDirectory(newRel)
    }

    public async createFolder(name: string): Promise<void> {
        console.log('[cf-imager] createFolder', { name })
        try {
            const safeName = sanitizeName(name)
            if (!safeName) {
                throw new Error('Folder name is required')
            }

            const target = resolveUnderRoot(this.config.rootDir, join(this.relCwd(), safeName))
            await fsp.mkdir(target, { recursive: false })

            this.emitFsUpdated()
        } catch (err) {
            this.emitError(`createFolder failed: ${(err as Error).message}`)
        }
    }

    public async renamePath(fromRel: string, toRel: string): Promise<void> {
        console.log('[cf-imager] renamePath', { fromRel, toRel })
        try {
            const fromAbs = resolveUnderRoot(this.config.rootDir, fromRel)
            const toAbs = resolveUnderRoot(this.config.rootDir, toRel)

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
        console.log('[cf-imager] deletePath', { relPath })
        try {
            const abs = resolveUnderRoot(this.config.rootDir, relPath)

            // If file looks like an .img, try to remove .part as well.
            const base = basename(abs)
            if (base.toLowerCase().endsWith('.img')) {
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
                await fsp.unlink(abs)
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
        console.log('[cf-imager] ensureDeviceAndMediaForOp', {
            opName,
            hasDevice: !!this.device,
            hasChild: !!this.child,
            media: this.state.media,
        })

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
        console.log('[cf-imager] writeImageToDevice requested', { imageRelPath })
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

        console.log('[cf-imager] writeImageToDevice stub completed')
    }

    public async readDeviceToImage(targetDirRel: string, imageName: string): Promise<void> {
        console.log('[cf-imager] readDeviceToImage requested', { targetDirRel, imageName })
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

        // TODO: replace this stub with spawn(this.config.readScriptPath, [...])
        this.deps.events.publish({
            kind: 'cf-op-error',
            at: Date.now(),
            op,
            error: 'readDeviceToImage not yet implemented',
        })

        this.state.phase = 'idle'
        this.state.currentOp = undefined
        this.state.message = 'Read not yet implemented'

        console.log('[cf-imager] readDeviceToImage stub completed')
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

        console.log('[cf-imager] cancelCurrentChild', { reason })

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
    /*  Media polling helpers                                                 */
    /* ---------------------------------------------------------------------- */

    private startMediaPolling(): void {
        if (this.mediaPollTimer) return
        // Only poll when we actually have a device; refreshMediaStatus()
        // already handles the no-device case defensively.
        this.mediaPollTimer = setInterval(() => {
            void this.refreshMediaStatus()
        }, MEDIA_POLL_INTERVAL_MS)
    }

    private stopMediaPolling(): void {
        if (this.mediaPollTimer) {
            clearInterval(this.mediaPollTimer)
            this.mediaPollTimer = null
        }
    }

    /* ---------------------------------------------------------------------- */
    /*  Media probing (macOS + Linux)                                         */
    /* ---------------------------------------------------------------------- */

    private async refreshMediaStatus(): Promise<void> {
        const prev = this.state.media

        if (!this.device) {
            this.state.media = 'none'
            if (prev !== this.state.media) {
                const message = '[cf-imager] media status -> none (no device)'
                console.log(message)
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
                const message = '[cf-imager] media status -> none (reader has no media path)'
                console.log(message)
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
                    const message =
                        `[cf-imager] media status -> unknown (unsupported platform=${process.platform})`
                    console.log(message)
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
                const message =
                    `[cf-imager] media status -> unknown (probe failed err="${(err as Error).message}")`
                console.log(message)
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

            console.log(logMsg)

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
     * Linux: use lsblk to get SIZE (bytes) for the given block device.
     */
    private async readLinuxBlockSize(devPath: string): Promise<number> {
        const out = await this.runCommand('lsblk', ['-bno', 'SIZE', devPath])
        const trimmed = out.trim()
        if (!trimmed) return 0
        const n = Number(trimmed)
        return Number.isFinite(n) && n > 0 ? n : 0
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
        const fs = listDirectoryState(this.config.rootDir, absPath, this.config.maxEntriesPerDir)
        return fs.cwd
    }

    private emitFsUpdated(): void {
        const fs = listDirectoryState(
            this.config.rootDir,
            this.cwdAbs,
            this.config.maxEntriesPerDir
        )
        this.state.fs = fs

        this.deps.events.publish({
            kind: 'cf-fs-updated',
            at: Date.now(),
            fs,
        })
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