/* eslint-disable no-console */

import { SerialPort } from 'serialport'
import type {
    AtlonaControllerConfig,
    AtlonaControllerEventSink,
    AtlonaSwitchId,
} from './types.js'
import { computeReconnectDelay, mapSwitchIdToName } from './utils.js'

interface AtlonaControllerServiceDeps {
    events: AtlonaControllerEventSink
}

// ---------------------------------------------------------------------------
// Env-driven tunables
// ---------------------------------------------------------------------------

const ATLONA_IDENTIFY_TIMEOUT_MS = parseEnvInt(process.env.ATLONA_IDENTIFY_TIMEOUT_MS, 3000)
const ATLONA_PRESS_HOLD_MS = parseEnvInt(process.env.ATLONA_PRESS_HOLD_MS, 200)

/**
 * AtlonaControllerService
 *
 * - Attaches to an Arduino Pro Micro running the Atlona Controller sketch.
 * - Performs the identification handshake:
 *      1) send "identify"
 *      2) expect "AC"
 *      3) send "identify_complete"
 * - Exposes methods to hold / release the three front-panel buttons:
 *      - Menu   (switch 1)
 *      - Minus  (switch 2)
 *      - Plus   (switch 3)
 *
 * Discovery is handled externally via SerialDiscoveryService. The orchestrator
 * is expected to:
 *   - Call onDeviceIdentified(...) when the controller is detected.
 *   - Call onDeviceLost(...) when that device disappears.
 */
export class AtlonaControllerService {
    private readonly config: AtlonaControllerConfig
    private readonly deps: AtlonaControllerServiceDeps

    private deviceId: string | null = null
    private devicePath: string | null = null
    private deviceBaudRate = 9600

    private port: SerialPort | null = null
    private identified = false

    private reconnectAttempts = 0
    private reconnectTimer: NodeJS.Timeout | null = null

    private readBuffer = ''

    // Local view of switch states; updated optimistically on commands.
    private switchState: Record<AtlonaSwitchId, boolean> = {
        1: false,
        2: false,
        3: false,
    }

    constructor(config: AtlonaControllerConfig, deps: AtlonaControllerServiceDeps) {
        this.config = config
        this.deps = deps
    }

    /* ---------------------------------------------------------------------- */
    /*  Public API                                                            */
    /* ---------------------------------------------------------------------- */

    public async start(): Promise<void> {
        // No-op for now; lifecycle is discovery-driven.
    }

    public async stop(): Promise<void> {
        this.clearReconnectTimer()
        await this.closePort('explicit-close')
        this.deviceId = null
        this.devicePath = null
        this.identified = false
        this.switchState = { 1: false, 2: false, 3: false }
    }

    public getIsIdentified(): boolean {
        return this.identified
    }

    public getSwitchState(): Record<AtlonaSwitchId, boolean> {
        return { ...this.switchState }
    }

    /* ---------------------------------------------------------------------- */
    /*  Discovery-driven lifecycle                                            */
    /* ---------------------------------------------------------------------- */

    public async onDeviceIdentified(args: {
        id: string
        path: string
        baudRate?: number
    }): Promise<void> {
        this.deviceId = args.id

        // 🔧 IMPORTANT CHANGE:
        // Do *not* rewrite /dev/tty.* → /dev/cu.* here.
        // SerialDiscoveryService already chose a working path; we trust it.
        this.devicePath = args.path
        this.deviceBaudRate = args.baudRate ?? 9600

        this.deps.events.publish({
            kind: 'atlona-device-identified',
            at: Date.now(),
            id: args.id,
            path: this.devicePath,
            baudRate: this.deviceBaudRate,
        })

        // If we are already connected to this exact path, do nothing.
        if (
            this.port &&
            this.port.isOpen &&
            this.devicePath === args.path &&
            this.identified
        ) {
            return
        }

        await this.openPort()
    }

    public async onDeviceLost(args: { id: string }): Promise<void> {
        if (this.deviceId !== args.id) {
            // Not our device; ignore.
            return
        }

        this.clearReconnectTimer()
        await this.closePort('device-lost')

        this.deps.events.publish({
            kind: 'atlona-device-lost',
            at: Date.now(),
            id: args.id,
        })
    }

    /* ---------------------------------------------------------------------- */
    /*  High-level button API                                                 */
    /* ---------------------------------------------------------------------- */

    /**
     * Hold a switch (1 = Menu, 2 = Minus, 3 = Plus) until released.
     */
    public async holdSwitch(switchId: AtlonaSwitchId, requestedBy?: string): Promise<void> {
        await this.ensureReady()

        const cmd = `hold ${switchId}`
        await this.writeCommand(cmd)

        const now = Date.now()
        this.switchState[switchId] = true

        this.deps.events.publish({
            kind: 'atlona-switch-held',
            at: now,
            switchId,
            switchName: mapSwitchIdToName(switchId),
            requestedBy,
        })
    }

    /**
     * Release a previously held switch.
     */
    public async releaseSwitch(switchId: AtlonaSwitchId, requestedBy?: string): Promise<void> {
        await this.ensureReady()

        const cmd = `release ${switchId}`
        await this.writeCommand(cmd)

        const now = Date.now()
        this.switchState[switchId] = false

        this.deps.events.publish({
            kind: 'atlona-switch-released',
            at: now,
            switchId,
            switchName: mapSwitchIdToName(switchId),
            requestedBy,
        })
    }

    /**
     * Convenience: press-and-release with a small hold duration.
     */
    public async pressSwitch(
        switchId: AtlonaSwitchId,
        holdMs = ATLONA_PRESS_HOLD_MS,
        requestedBy?: string
    ): Promise<void> {
        await this.holdSwitch(switchId, requestedBy)
        await this.sleep(holdMs)
        await this.releaseSwitch(switchId, requestedBy)
    }

    /* ---------------------------------------------------------------------- */
    /*  SerialPort wiring                                                     */
    /* ---------------------------------------------------------------------- */

    private async openPort(): Promise<void> {
        if (!this.devicePath) {
            this.deps.events.publish({
                kind: 'recoverable-error',
                at: Date.now(),
                error: 'openPort called without devicePath',
            })
            return
        }

        const path = this.devicePath
        const baudRate = this.deviceBaudRate

        this.identified = false

        return new Promise<void>((resolve, reject) => {
            const port = new SerialPort({
                path,
                baudRate,
                autoOpen: false,
                dataBits: 8,
                parity: 'none',
                stopBits: 1,
            })

            const onOpen = async () => {
                this.port = port
                this.reconnectAttempts = 0

                this.deps.events.publish({
                    kind: 'atlona-device-connected',
                    at: Date.now(),
                    path,
                    baudRate,
                })

                port.on('data', (chunk: Buffer) => {
                    this.handleData(chunk.toString('utf8'))
                })

                port.on('error', (err: Error) => {
                    void this.handlePortError(err)
                })

                port.on('close', () => {
                    void this.handlePortClose()
                })

                try {
                    await this.runIdentificationHandshake()
                    resolve()
                } catch (err: any) {
                    await this.handlePortError(err instanceof Error ? err : new Error(String(err)))
                    reject(err)
                }
            }

            const onError = async (err: Error) => {
                port.off('open', onOpen)
                port.off('error', onError)
                await this.handlePortOpenError(err)
                reject(err)
            }

            port.once('open', onOpen)
            port.once('error', onError)

            port.open()
        })
    }

    private async closePort(
        reason: 'io-error' | 'explicit-close' | 'unknown' | 'device-lost'
    ): Promise<void> {
        const port = this.port
        this.port = null

        const hadPort = !!port

        if (port && port.isOpen) {
            await new Promise<void>((resolve) => {
                port.close(() => resolve())
            })
        }

        this.identified = false
        this.switchState = { 1: false, 2: false, 3: false }

        if (hadPort) {
            this.deps.events.publish({
                kind: 'atlona-device-disconnected',
                at: Date.now(),
                path: this.devicePath ?? 'unknown',
                reason,
            })
        }
    }

    private async runIdentificationHandshake(): Promise<void> {
        // From the sketch:
        // - Send "identify"
        // - Device replies with "AC"
        // - Then send "identify_complete"
        // - Device prints a debug confirmation and starts accepting commands.

        await this.writeCommand('identify')

        const ok = await this.waitForIdResponse('AC', ATLONA_IDENTIFY_TIMEOUT_MS)
        if (!ok) {
            throw new Error('Atlona controller failed to respond with AC during identify')
        }

        await this.writeCommand('identify_complete')
        this.identified = true

        this.deps.events.publish({
            kind: 'atlona-identified-complete',
            at: Date.now(),
        })
    }

    private async writeCommand(cmd: string): Promise<void> {
        const port = this.port
        if (!port || !port.isOpen) {
            throw new Error('writeCommand: port not open')
        }

        const wire = cmd + '\n'

        await new Promise<void>((resolve, reject) => {
            port.write(wire, (err) => {
                if (err) {
                    reject(err)
                } else {
                    resolve()
                }
            })
        })
    }

    /* ---------------------------------------------------------------------- */
    /*  Data handling                                                         */
    /* ---------------------------------------------------------------------- */

    private handleData(chunk: string): void {
        this.readBuffer += chunk

        const lines = this.readBuffer.split(/\r?\n/)
        this.readBuffer = lines.pop() ?? ''

        for (const rawLine of lines) {
            const line = rawLine.trim()
            if (!line) continue

            this.deps.events.publish({
                kind: 'atlona-debug-line',
                at: Date.now(),
                line,
            })
        }
    }

    private async waitForIdResponse(expected: string, timeoutMs: number): Promise<boolean> {
        const start = Date.now()
        let buffered = ''

        return new Promise<boolean>((resolve) => {
            const port = this.port
            if (!port || !port.isOpen) {
                return resolve(false)
            }

            const onData = (chunk: Buffer) => {
                buffered += chunk.toString('utf8')
                if (buffered.includes(expected)) {
                    cleanup()
                    resolve(true)
                }
            }

            const onError = () => {
                cleanup()
                resolve(false)
            }

            const cleanup = () => {
                if (!port) return
                port.off('data', onData)
                port.off('error', onError)
            }

            port.on('data', onData)
            port.on('error', onError)

            const checkTimeout = () => {
                if (Date.now() - start >= timeoutMs) {
                    cleanup()
                    resolve(false)
                } else {
                    setTimeout(checkTimeout, 50)
                }
            }

            setTimeout(checkTimeout, 50)
        })
    }

    /* ---------------------------------------------------------------------- */
    /*  Error + reconnect handling                                            */
    /* ---------------------------------------------------------------------- */

    private async handlePortError(err: Error): Promise<void> {
        this.deps.events.publish({
            kind: 'recoverable-error',
            at: Date.now(),
            error: `Atlona controller port error: ${err.message}`,
        })

        await this.closePort('io-error')

        if (this.config.reconnect.enabled) {
            this.scheduleReconnect()
        } else {
            this.deps.events.publish({
                kind: 'fatal-error',
                at: Date.now(),
                error: 'Atlona controller error and reconnect disabled',
            })
        }
    }

    private async handlePortClose(): Promise<void> {
        await this.closePort('io-error')

        if (this.config.reconnect.enabled) {
            this.scheduleReconnect()
        } else {
            this.deps.events.publish({
                kind: 'fatal-error',
                at: Date.now(),
                error: 'Atlona controller port closed and reconnect disabled',
            })
        }
    }

    private async handlePortOpenError(err: Error): Promise<void> {
        this.deps.events.publish({
            kind: 'recoverable-error',
            at: Date.now(),
            error: `Failed to open Atlona controller port: ${err.message}`,
        })

        if (this.config.reconnect.enabled) {
            this.scheduleReconnect()
        } else {
            this.deps.events.publish({
                kind: 'fatal-error',
                at: Date.now(),
                error: 'Failed to open Atlona controller port and reconnect disabled',
            })
        }
    }

    private scheduleReconnect(): void {
        this.clearReconnectTimer()

        const { baseDelayMs, maxDelayMs, maxAttempts } = this.config.reconnect

        this.reconnectAttempts += 1

        // If maxAttempts > 0, we can still keep going "forever" but this value is
        // useful for logging or if you later decide to hard-stop.
        if (maxAttempts > 0 && this.reconnectAttempts > maxAttempts) {
            // For now we still keep trying; we just emit a stronger log signal.
            this.deps.events.publish({
                kind: 'recoverable-error',
                at: Date.now(),
                error: `Atlona reconnect attempt ${this.reconnectAttempts} (maxAttempts=${maxAttempts})`,
            })
        }

        const delay = computeReconnectDelay(baseDelayMs, maxDelayMs, this.reconnectAttempts)

        this.reconnectTimer = setTimeout(() => {
            void this.tryReconnect()
        }, delay)
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
    }

    private async tryReconnect(): Promise<void> {
        if (!this.devicePath) return

        try {
            await this.openPort()
        } catch {
            // Errors already logged; scheduleReconnect will decide further retries.
        }
    }

    /* ---------------------------------------------------------------------- */
    /*  Helpers                                                                */
    /* ---------------------------------------------------------------------- */

    private async ensureReady(): Promise<void> {
        if (!this.port || !this.port.isOpen) {
            throw new Error('Atlona controller: port not open')
        }
        if (!this.identified) {
            throw new Error('Atlona controller: device not identified')
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}

/* -------------------------------------------------------------------------- */
/*  Local env helpers                                                         */
/* -------------------------------------------------------------------------- */

function parseEnvInt(value: string | undefined, fallback: number): number {
    if (!value) return fallback
    const n = Number.parseInt(value, 10)
    return Number.isNaN(n) ? fallback : n
}