/* eslint-disable no-console */

import { spawn } from 'node:child_process'

export interface CfBlockDiscoveryConfig {
    /** Hex VID, e.g. "05e3" (case-insensitive, with or without 0x). */
    vendorId?: string
    /** Hex PID, e.g. "0748". */
    productId?: string
    /** Optional USB serial number, e.g. "000000001209". */
    serialNumber?: string
    /** Poll cadence in ms. Reasonable default: 3000–5000. */
    pollIntervalMs: number
}

/**
 * Info passed to CfImagerService.onDeviceIdentified/onDeviceLost.
 */
export interface CfBlockDeviceInfo {
    id: string
    path: string
    vendorId?: string
    productId?: string
    serialNumber?: string
}

/**
 * Simple polling-based discovery for a *USB block device* CF reader.
 *
 * Platform behavior:
 *   - macOS: uses `system_profiler SPUSBDataType -json` to find the USB device
 *            by VID/PID/serial, and `diskutil` to find the matching disk node.
 *   - Linux: uses /sys/bus/usb/devices to find the USB reader by VID/PID/serial,
 *            then `lsblk -J` to find a matching USB disk block device.
 *
 * Notes:
 *   - This is intentionally conservative: we never try to be "smart" about
 *     other disks. We only ever look for the one reader configured in env.
 *   - If we can’t confidently determine a /dev path, we log and return null.
 */
export class CfBlockDiscoveryService {
    private readonly cfg: CfBlockDiscoveryConfig
    private readonly onPresent: (info: CfBlockDeviceInfo) => void | Promise<void>
    private readonly onLost: (info: { id: string }) => void | Promise<void>
    private readonly log: (
        level: 'debug' | 'info' | 'warn' | 'error',
        msg: string,
        meta?: Record<string, unknown>
    ) => void

    private timer: NodeJS.Timeout | null = null
    private lastDevice: CfBlockDeviceInfo | null = null
    private running = false

    constructor(
        cfg: CfBlockDiscoveryConfig,
        opts: {
            onPresent: (info: CfBlockDeviceInfo) => void | Promise<void>
            onLost: (info: { id: string }) => void | Promise<void>
            log?: (
                level: 'debug' | 'info' | 'warn' | 'error',
                msg: string,
                meta?: Record<string, unknown>
            ) => void
        }
    ) {
        this.cfg = {
            ...cfg,
            pollIntervalMs: Math.max(1000, cfg.pollIntervalMs || 3000),
            vendorId: normalizeHex(cfg.vendorId),
            productId: normalizeHex(cfg.productId),
            serialNumber: cfg.serialNumber?.toString() ?? undefined,
        }
        this.onPresent = opts.onPresent
        this.onLost = opts.onLost
        this.log = opts.log ?? (() => {})
    }

    public start(): void {
        if (this.running) return
        this.running = true

        this.log('info', 'CF block discovery start', {
            platform: process.platform,
            vendorId: this.cfg.vendorId ?? null,
            productId: this.cfg.productId ?? null,
            serialNumber: this.cfg.serialNumber ?? null,
            pollIntervalMs: this.cfg.pollIntervalMs,
        })

        // Immediate first check, then interval.
        void this.pollOnce().catch((err) => {
            this.log('warn', 'initial CF block discovery poll failed', {
                err: (err as Error).message,
            })
        })

        this.timer = setInterval(() => {
            void this.pollOnce().catch((err) => {
                this.log('debug', 'CF block discovery poll failed', {
                    err: (err as Error).message,
                })
            })
        }, this.cfg.pollIntervalMs)
    }

    public async stop(): Promise<void> {
        this.running = false
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }

        if (this.lastDevice) {
            const lost = this.lastDevice
            this.lastDevice = null
            this.log('info', 'CF reader considered lost on stop', {
                id: lost.id,
                path: lost.path,
            })
            try {
                await this.onLost({ id: lost.id })
            } catch (err) {
                this.log('warn', 'onLost callback failed during stop', {
                    err: (err as Error).message,
                })
            }
        }

        this.log('info', 'CF block discovery stopped')
    }

    /* ---------------------------------------------------------------------- */
    /*  Core polling loop                                                     */
    /* ---------------------------------------------------------------------- */

    private async pollOnce(): Promise<void> {
        if (!this.running) return

        const dev = await this.findDeviceForPlatform()

        if (!dev && this.lastDevice) {
            // Was present, now gone.
            const lost = this.lastDevice
            this.lastDevice = null
            this.log('info', 'CF reader lost', { id: lost.id, path: lost.path })
            await this.safeOnLost(lost.id)
            return
        }

        if (!dev && !this.lastDevice) {
            // Nothing matched this cycle; warn so we can see that we're polling and not finding.
            this.log('warn', 'CF discovery poll: no matching reader found', {
                platform: process.platform,
            })
            return
        }

        if (dev && !this.lastDevice) {
            // Newly present.
            this.lastDevice = dev
            this.log('info', 'CF reader detected', {
                id: dev.id,
                path: dev.path,
                vendorId: dev.vendorId ?? null,
                productId: dev.productId ?? null,
                serialNumber: dev.serialNumber ?? null,
            })
            await this.safeOnPresent(dev)
            return
        }

        if (dev && this.lastDevice) {
            // Still present; if path changed, treat as reattach.
            if (dev.path !== this.lastDevice.path) {
                const old = this.lastDevice
                this.lastDevice = dev
                this.log('info', 'CF reader reattached with new path', {
                    oldPath: old.path,
                    newPath: dev.path,
                    id: dev.id,
                })
                await this.safeOnLost(old.id)
                await this.safeOnPresent(dev)
            }
        }
    }

    private async safeOnPresent(info: CfBlockDeviceInfo): Promise<void> {
        try {
            await this.onPresent(info)
        } catch (err) {
            this.log('warn', 'onPresent callback failed', {
                err: (err as Error).message,
            })
        }
    }

    private async safeOnLost(id: string): Promise<void> {
        try {
            await this.onLost({ id })
        } catch (err) {
            this.log('warn', 'onLost callback failed', {
                err: (err as Error).message,
            })
        }
    }

    /* ---------------------------------------------------------------------- */
    /*  Platform-specific discovery                                           */
    /* ---------------------------------------------------------------------- */

    private async findDeviceForPlatform(): Promise<CfBlockDeviceInfo | null> {
        if (!this.cfg.vendorId && !this.cfg.productId && !this.cfg.serialNumber) {
            // Misconfiguration: nothing to match on.
            this.log('debug', 'CF discovery disabled: no VID/PID/serial configured', {})
            return null
        }

        if (process.platform === 'darwin') {
            return this.findOnDarwin()
        }

        if (process.platform === 'linux') {
            return this.findOnLinux()
        }

        this.log('debug', 'CF block discovery unsupported platform', {
            platform: process.platform,
        })
        return null
    }

    /**
     * macOS: two-phase:
     *   1) Use `system_profiler SPUSBDataType -json` to find the USB READER
     *      with matching VID/PID/serial.
     *   2) Use `diskutil` to find the USB block device that corresponds to
     *      the media (if inserted).
     *
     * For now, we assume that when the card is inserted, there is a single
     * USB whole disk that represents it (e.g., /dev/disk4).
     */
    private async findOnDarwin(): Promise<CfBlockDeviceInfo | null> {
        // 1) Confirm the USB reader exists at all
        const readerPresent = await this.findDarwinUsbReader()
        if (!readerPresent) {
            /*
            this.log('debug', 'darwin: USB reader not found by VID/PID/serial', {
                vendorId: this.cfg.vendorId ?? null,
                productId: this.cfg.productId ?? null,
                serialNumber: this.cfg.serialNumber ?? null,
            })
            */
            return null
        }

        // 2) If reader exists, try to locate the block device representing the media
        const diskPath = await this.findDarwinUsbMediaDisk()
        if (!diskPath) {
            // Reader present but no media. We still surface a "device" with a
            // synthetic path so CfImagerService knows the reader exists; it can
            // separately probe for media.
            const id = makeDeviceId({
                kind: 'block.cfreader',
                path: 'unmounted',
                vendorId: this.cfg.vendorId,
                productId: this.cfg.productId,
            })

            return {
                id,
                path: 'unmounted',
                vendorId: this.cfg.vendorId,
                productId: this.cfg.productId,
                serialNumber: this.cfg.serialNumber,
            }
        }

        const id = makeDeviceId({
            kind: 'block.cfreader',
            path: diskPath,
            vendorId: this.cfg.vendorId,
            productId: this.cfg.productId,
        })

        return {
            id,
            path: diskPath,
            vendorId: this.cfg.vendorId,
            productId: this.cfg.productId,
            serialNumber: this.cfg.serialNumber,
        }
    }

    /**
     * Phase 1 (darwin): verify the CF USB reader exists using system_profiler JSON.
     */
    private async findDarwinUsbReader(): Promise<boolean> {
        const rawJson = await this.runCommand('system_profiler', ['SPUSBDataType', '-json'])
        if (!rawJson.trim()) {
            this.log('debug', 'darwin: system_profiler returned empty output', {})
            return false
        }

        let parsed: any
        try {
            parsed = JSON.parse(rawJson)
        } catch (err) {
            this.log('warn', 'darwin: failed to parse system_profiler JSON', {
                err: (err as Error).message,
            })
            return false
        }

        const roots: any[] = Array.isArray(parsed?.SPUSBDataType)
            ? parsed.SPUSBDataType
            : []

        const matchVendor = this.cfg.vendorId
        const matchProduct = this.cfg.productId
        const matchSerial = this.cfg.serialNumber

        let found = false

        const visit = (node: any): void => {
            if (!node || typeof node !== 'object') return

            const vendorIdStr = node.vendor_id ?? node.vendorID
            const productIdStr = node.product_id ?? node.productID
            const serial = node.serial_num ? String(node.serial_num) : undefined

            const vid = extractHexId(
                typeof vendorIdStr === 'string' ? vendorIdStr : String(vendorIdStr ?? '')
            )
            const pid = extractHexId(
                typeof productIdStr === 'string' ? productIdStr : String(productIdStr ?? '')
            )

            const vidOk = matchVendor ? vid === matchVendor : true
            const pidOk = matchProduct ? pid === matchProduct : true
            const serialOk = matchSerial ? serial === matchSerial : true

            if (vidOk && pidOk && serialOk) {
                found = true
                return
            }

            const kids: any[] = []
            if (Array.isArray(node._items)) kids.push(...node._items)
            if (Array.isArray(node.hub_port)) kids.push(...node.hub_port)
            if (Array.isArray(node.children)) kids.push(...node.children)
            for (const child of kids) visit(child)
        }

        for (const root of roots) {
            if (found) break
            visit(root)
        }

        return found
    }

    /**
     * Phase 2 (darwin): if the reader exists, attempt to find the /dev/diskX
     * that represents the media (if any) via diskutil.
     *
     * We:
     *   - Call `diskutil list -plist | plutil -convert json -o - -` to
     *     enumerate disks (JSON).
     *   - Filter disks that are:
     *       * External/removable
     *       * WholeDisk == true
     *       * BusProtocol == "USB"
     */
    private async findDarwinUsbMediaDisk(): Promise<string | null> {
        const out = await this.runShell('diskutil list -plist | plutil -convert json -o - -')
        if (!out.trim()) {
            this.log('debug', 'darwin: diskutil list -plist returned empty output', {})
            return null
        }

        let parsed: any
        try {
            parsed = JSON.parse(out)
        } catch (err) {
            this.log('warn', 'darwin: failed to parse diskutil list JSON', {
                err: (err as Error).message,
            })
            return null
        }

        const disks: any[] = Array.isArray(parsed?.AllDisksAndPartitions)
            ? parsed.AllDisksAndPartitions
            : []

        let bestPath: string | null = null

        for (const disk of disks) {
            if (!disk || typeof disk !== 'object') continue

            const ident = typeof disk.DeviceIdentifier === 'string' ? disk.DeviceIdentifier : undefined
            if (!ident) continue

            const infoJson = await this.safeDiskutilInfo(ident)
            if (!infoJson) continue

            let info: any
            try {
                info = JSON.parse(infoJson)
            } catch (err) {
                this.log('warn', 'darwin: failed to parse diskutil info JSON', {
                    identifier: ident,
                    err: (err as Error).message,
                })
                continue
            }

            const busProtocol = typeof info.BusProtocol === 'string' ? info.BusProtocol : undefined
            const wholeDisk = info.WholeDisk === true
            const external =
                info.RemovableMediaOrExternalDevice === true || info.Internal === false
            const isUsb = busProtocol === 'USB'

            const node = typeof info.DeviceNode === 'string' ? info.DeviceNode : `/dev/${ident}`

            if (isUsb && wholeDisk && external) {
                bestPath = node
                break
            }
        }

        if (!bestPath) {
            return null
        }

        return bestPath
    }

    /**
     * Linux: two-phase, mirroring Darwin semantics:
     *
     *   1) Use /sys/bus/usb/devices to locate the USB reader by VID/PID/serial.
     *   2) Use `lsblk -J -o NAME,TRAN,SERIAL,PATH,RM,TYPE` to locate a USB disk
     *      whose serial (if available) matches the reader, or otherwise take the
     *      first USB disk as a fallback.
     *
     * If the reader exists but there is no matching USB disk, we treat this as
     * "reader present, no media" and surface an "unmounted" synthetic path.
     */
    private async findOnLinux(): Promise<CfBlockDeviceInfo | null> {
        const reader = await this.findLinuxUsbReader()
        if (!reader) {
            this.log('debug', 'linux: USB reader not found by VID/PID/serial', {
                vendorId: this.cfg.vendorId ?? null,
                productId: this.cfg.productId ?? null,
                serialNumber: this.cfg.serialNumber ?? null,
            })
            return null
        }

        const blockPath = await this.findLinuxUsbMediaDisk(reader.serial)

        if (!blockPath) {
            // Reader present but no media. Mirror Darwin: synthetic "unmounted" path.
            const id = makeDeviceId({
                kind: 'block.cfreader',
                path: 'unmounted',
                vendorId: this.cfg.vendorId,
                productId: this.cfg.productId,
            })

            this.log('debug', 'linux: USB reader present but no matching USB disk (no media)', {
                sysPath: reader.sysPath,
                serial: reader.serial ?? null,
                id,
            })

            return {
                id,
                path: 'unmounted',
                vendorId: this.cfg.vendorId,
                productId: this.cfg.productId,
                serialNumber: reader.serial ?? this.cfg.serialNumber,
            }
        }

        const id = makeDeviceId({
            kind: 'block.cfreader',
            path: blockPath,
            vendorId: this.cfg.vendorId,
            productId: this.cfg.productId,
        })

        this.log('info', 'linux: selected CF reader block device', {
            path: blockPath,
            sysPath: reader.sysPath,
            serial: reader.serial ?? null,
            vendorId: this.cfg.vendorId ?? null,
            productId: this.cfg.productId ?? null,
        })

        return {
            id,
            path: blockPath,
            vendorId: this.cfg.vendorId,
            productId: this.cfg.productId,
            serialNumber: reader.serial ?? this.cfg.serialNumber,
        }
    }

    /**
     * Phase 1 (linux): locate the USB reader using /sys/bus/usb/devices and
     * the configured VID/PID/serial.
     *
     * Returns the sysfs path and discovered serial (if present).
     */
    private async findLinuxUsbReader(): Promise<{ sysPath: string; serial?: string } | null> {
        const script = `
set -e
for dev in /sys/bus/usb/devices/*; do
  if [ -f "$dev/idVendor" ] && [ -f "$dev/idProduct" ]; then
    vid=$(cat "$dev/idVendor" 2>/dev/null || echo "")
    pid=$(cat "$dev/idProduct" 2>/dev/null || echo "")
    serial=""
    if [ -f "$dev/serial" ]; then
      serial=$(cat "$dev/serial" 2>/dev/null || echo "")
    fi
    echo "$dev $vid $pid $serial"
  fi
done
`.trim()

        let out: string
        try {
            out = await this.runShell(script)
        } catch (err) {
            this.log('warn', 'linux: failed to enumerate USB devices from sysfs', {
                err: (err as Error).message,
            })
            return null
        }

        if (!out.trim()) {
            this.log('debug', 'linux: no USB devices found under /sys/bus/usb/devices', {})
            return null
        }

        const matchVendor = this.cfg.vendorId
        const matchProduct = this.cfg.productId
        const matchSerial = this.cfg.serialNumber

        const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)

        for (const line of lines) {
            const parts = line.split(' ').filter(Boolean)
            if (parts.length < 3) continue

            const sysPath = parts[0]
            const vidRaw = parts[1]
            const pidRaw = parts[2]
            const serialRaw = parts.slice(3).join(' ') || undefined

            const vid = normalizeHex(vidRaw)
            const pid = normalizeHex(pidRaw)
            const serial = serialRaw ? String(serialRaw) : undefined

            const vidOk = matchVendor ? vid === matchVendor : true
            const pidOk = matchProduct ? pid === matchProduct : true
            const serialOk = matchSerial ? serial === matchSerial : true

            if (vidOk && pidOk && serialOk) {
                this.log('debug', 'linux: matched CF USB reader in sysfs', {
                    sysPath,
                    vid,
                    pid,
                    serial: serial ?? null,
                })
                return { sysPath, serial }
            }
        }

        return null
    }

    /**
     * Phase 2 (linux): given the reader serial (if any), use `lsblk -J` to
     * find a USB disk representing the CF media.
     *
     * Preference order:
     *   - USB disk whose SERIAL matches readerSerial (if known).
     *   - Otherwise, USB disk whose SERIAL matches configured cfg.serialNumber.
     *   - Otherwise, first USB disk (fallback).
     */
    private async findLinuxUsbMediaDisk(readerSerial?: string): Promise<string | null> {
        const out = await this.runCommand('lsblk', ['-J', '-o', 'NAME,TRAN,SERIAL,PATH,RM,TYPE'])
        if (!out.trim()) {
            this.log('debug', 'linux: lsblk returned empty output', {})
            return null
        }

        let parsed: any
        try {
            parsed = JSON.parse(out)
        } catch (err) {
            this.log('warn', 'linux: failed to parse lsblk JSON', {
                err: (err as Error).message,
            })
            return null
        }

        const devices: any[] = Array.isArray(parsed?.blockdevices)
            ? parsed.blockdevices
            : []

        this.log('debug', 'linux CF discovery: inspecting lsblk devices', {
            count: devices.length,
        })

        const desiredSerial = readerSerial ?? this.cfg.serialNumber ?? undefined

        type Candidate = { path: string; serial?: string }
        const candidates: Candidate[] = []

        const visit = (node: any): void => {
            if (!node || typeof node !== 'object') return

            const path = typeof node.path === 'string' ? node.path : undefined
            const serial = node.serial ? String(node.serial) : undefined
            const tran = node.tran ? String(node.tran).toLowerCase() : undefined
            const type = node.type ? String(node.type).toLowerCase() : undefined

            const isUsb = tran === 'usb'
            const isDisk = type === 'disk'

            if (path && isUsb && isDisk) {
                this.log('debug', 'linux: inspecting USB disk node from lsblk', {
                    path,
                    serial: serial ?? null,
                    tran,
                    type,
                })
                candidates.push({ path, serial })
            }

            if (Array.isArray(node.children)) {
                for (const child of node.children) visit(child)
            }
        }

        for (const dev of devices) visit(dev)

        if (candidates.length === 0) {
            this.log('debug', 'linux: no USB disk candidates found in lsblk', {})
            return null
        }

        // 1) Prefer exact serial match to readerSerial / cfg.serialNumber.
        if (desiredSerial) {
            const bySerial = candidates.find((c) => c.serial === desiredSerial)
            if (bySerial) {
                this.log('debug', 'linux: selected USB disk by serial match', {
                    path: bySerial.path,
                    serial: bySerial.serial ?? null,
                    desiredSerial,
                })
                return bySerial.path
            }
        }

        // 2) Fallback: first USB disk.
        const first = candidates[0]
        this.log(
            'debug',
            'linux: taking first USB disk candidate as CF media fallback',
            {
                path: first.path,
                serial: first.serial ?? null,
            }
        )
        return first.path
    }

    /* ---------------------------------------------------------------------- */
    /*  Small command helpers                                                 */
    /* ---------------------------------------------------------------------- */

    private runCommand(cmd: string, args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const child = spawn(cmd, args, {
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
                else reject(new Error(`${cmd} exited with code ${code}: ${stderr}`))
            })
        })
    }

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

    private async safeDiskutilInfo(identifier: string): Promise<string | null> {
        try {
            // identifier is like "disk4"
            const script =
                `diskutil info -plist "${identifier}" ` +
                `| plutil -convert json -o - -`
            return await this.runShell(script)
        } catch (err) {
            this.log('debug', 'darwin: diskutil info failed', {
                identifier,
                err: (err as Error).message,
            })
            return null
        }
    }
}

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function normalizeHex(v?: string): string | undefined {
    if (!v) return undefined
    return v.toString().replace(/^0x/i, '').toLowerCase()
}

/** Extract 0x1234 → 1234 from system_profiler strings. */
function extractHexId(s: string): string | undefined {
    const m = /0x([0-9a-fA-F]+)/.exec(s)
    return m ? m[1].toLowerCase() : undefined
}

function makeDeviceId(args: {
    kind: string
    path: string
    vendorId?: string
    productId?: string
}): string {
    const vid = args.vendorId ?? 'unknown'
    const pid = args.productId ?? 'unknown'
    return `usb:${vid}:${pid}:${args.kind}:${args.path}`
}