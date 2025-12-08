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
 *            then walks /sys/block to find block devices owned by that reader
 *            and inspects their size to detect inserted media.
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
            // tiny version tag so we can prove this code is what’s running
            implVersion: 'linux-size-aware-v1',
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

    /* ------------------------------- Darwin -------------------------------- */

    private async findOnDarwin(): Promise<CfBlockDeviceInfo | null> {
        const readerPresent = await this.findDarwinUsbReader()
        if (!readerPresent) {
            return null
        }

        const diskPath = await this.findDarwinUsbMediaDisk()
        if (!diskPath) {
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

    /* ------------------------------- Linux --------------------------------- */

    /**
     * Linux: two-phase, mirroring Darwin semantics:
     *
     *   1) Use /sys/bus/usb/devices to locate the USB reader by VID/PID/serial.
     *   2) Walk /sys/block/* and pick block devices whose `/device` realpath
     *      is under that USB device's sysfs path, **then** filter by size:
     *         - size == 0 → slot exists but no media
     *         - size > 0  → media present in that slot
     *
     * If the reader exists but there is no such block device with size > 0,
     * we treat this as "reader present, no media" and surface an "unmounted"
     * synthetic path.
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

        const blockPath = await this.findLinuxUsbMediaDisk(reader.sysPath)

        if (!blockPath) {
            // Reader present but no media. Mirror Darwin: synthetic "unmounted" path.
            const id = makeDeviceId({
                kind: 'block.cfreader',
                path: 'unmounted',
                vendorId: this.cfg.vendorId,
                productId: this.cfg.productId,
            })

            /*
            this.log('debug', 'linux: USB reader present but no block device with media under it', {
                sysPath: reader.sysPath,
                serial: reader.serial ?? null,
                id,
            })
            */

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

        /*
        this.log('info', 'linux: selected CF reader block device (via sysfs + size)', {
            path: blockPath,
            sysPath: reader.sysPath,
            serial: reader.serial ?? null,
            vendorId: this.cfg.vendorId ?? null,
            productId: this.cfg.productId ?? null,
        })
        */

        return {
            id,
            path: blockPath,
            vendorId: this.cfg.vendorId,
            productId: this.cfg.productId,
            serialNumber: reader.serial ?? this.cfg.serialNumber,
        }
    }

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
                /*
                this.log('debug', 'linux: matched CF USB reader in sysfs', {
                    sysPath,
                    vid,
                    pid,
                    serial: serial ?? null,
                })
                */
                return { sysPath, serial }
            }
        }

        return null
    }

    private async findLinuxUsbMediaDisk(readerSysPath: string): Promise<string | null> {
        const script = `
set -e
reader="$(readlink -f "${readerSysPath}")"
if [ ! -d "$reader" ]; then
  exit 0
fi
# Emit: "<devname> <size>"
for blk in /sys/block/*; do
  [ -d "$blk" ] || continue
  devname="$(basename "$blk")"
  devlink="$(readlink -f "$blk/device" 2>/dev/null || echo "")"
  if [ -z "$devlink" ]; then
    continue
  fi
  case "$devlink" in
    "$reader"/*)
      sizeFile="$blk/size"
      size="0"
      if [ -f "$sizeFile" ]; then
        size=$(cat "$sizeFile" 2>/dev/null || echo "0")
      fi
      echo "$devname $size"
    ;;
  esac
done
`.trim()

        let out: string
        try {
            out = await this.runShell(script)
        } catch (err) {
            this.log('warn', 'linux: failed to map USB reader to block devices via sysfs', {
                readerSysPath,
                err: (err as Error).message,
            })
            return null
        }

        const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
        if (lines.length === 0) {
            // No block devices at all under this reader (very odd, but treat as no media)
            this.log('debug', 'linux: no block devices under reader sysfs path', {
                readerSysPath,
            })
            return null
        }

        const candidates: { dev: string; size: number }[] = []
        for (const line of lines) {
            const [dev, sizeStr] = line.split(' ').filter(Boolean)
            if (!dev) continue
            const size = Number.parseInt(sizeStr ?? '0', 10)
            if (Number.isNaN(size)) continue
            candidates.push({ dev, size })
        }

        /*
        this.log('debug', 'linux: block device candidates under reader', {
            readerSysPath,
            candidates: candidates.map((c) => ({ dev: c.dev, size: c.size })),
        })
        */

        if (candidates.length === 0) {
            return null
        }

        const withMedia = candidates.filter((c) => c.size > 0)

        if (withMedia.length === 0) {
            /*
            this.log('debug', 'linux: block devices under reader but all report size 0 (no media)', {
                readerSysPath,
                candidates: candidates.map((c) => ({ dev: c.dev, size: c.size })),
            })
            */
            return null
        }

        if (withMedia.length > 1) {
            this.log(
                'debug',
                'linux: multiple block devices with media under CF reader, taking first',
                {
                    readerSysPath,
                    candidates: withMedia.map((c) => ({ dev: c.dev, size: c.size })),
                }
            )
        }

        const chosen = withMedia[0]
        const path = `/dev/${chosen.dev}`

        return path
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