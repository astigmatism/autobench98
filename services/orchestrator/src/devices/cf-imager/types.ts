// services/orchestrator/src/core/devices/cf-imager/types.ts

/* -------------------------------------------------------------------------- */
/*  Config                                                                    */
/* -------------------------------------------------------------------------- */

export interface CfImagerConfig {
    /**
     * Absolute or ~-expanded path used as the root for all filesystem
     * operations. The service will never read or write outside this tree.
     */
    rootDir: string

    /**
     * Optional maximum number of entries returned from a directory listing.
     * Primarily a guard for huge directories.
     */
    maxEntriesPerDir: number

    /**
     * Path to the bash script used to READ (clone) the CF device to an image.
     * This can be relative to the orchestrator working directory or absolute.
     */
    readScriptPath: string

    /**
     * Path to the bash script used to WRITE an image to the CF device.
     * This can be relative to the orchestrator working directory or absolute.
     */
    writeScriptPath: string

    /**
     * Optional list of file extensions (lowercase, without dots) that are
     * allowed to appear in the CF image browser. Directories are always shown.
     *
     * Example: ['img', 'iso']
     *
     * If omitted or empty, all file types are visible (except internal
     * companions like .part, which are always hidden).
     */
    visibleExtensions?: string[]

    /**
     * Optional polling cadence (ms) for refreshing the filesystem view.
     *  - If <= 0 or undefined, periodic polling is disabled.
     *  - Default is configured via CF_IMAGER_FS_POLL_MS (see utils.ts).
     */
    fsPollIntervalMs?: number
}

/* -------------------------------------------------------------------------- */
/*  State + FS types                                                          */
/* -------------------------------------------------------------------------- */

export type CfImagerPhase =
    | 'disconnected'
    | 'idle'
    | 'busy'
    | 'error'

export type CfImagerMediaStatus =
    | 'none'     // reader present but no card
    | 'present'  // card inserted and detected
    | 'unknown'  // reader present, card status not yet determined

export interface CfImagerDeviceInfo {
    /** Discovery-level device ID (e.g., usb:VID:PID:kind:/dev/sdX). */
    id: string
    /** Underlying block device path, e.g. /dev/sdc. */
    path: string
    vendorId?: string
    productId?: string
    serialNumber?: string
}

/** Entry kind seen by the frontend file browser. */
export type CfImagerEntryKind = 'file' | 'dir'

export interface CfImagerFsEntry {
    /** Display name (no .img extension for images). */
    name: string
    kind: CfImagerEntryKind
    sizeBytes?: number
    modifiedAt?: string // ISO timestamp
}

/**
 * Filesystem state mirrored to the frontend.
 *
 * NOTE: cwd is always a path relative to rootDir, using POSIX-style separators.
 * Example: ".", "games", "backups/dos".
 */
export interface CfImagerFsState {
    rootPath: string
    cwd: string
    entries: CfImagerFsEntry[]
}

/* -------------------------------------------------------------------------- */
/*  Operation state                                                           */
/* -------------------------------------------------------------------------- */

export type CfImagerOpKind = 'read' | 'write'

export interface CfImagerCurrentOp {
    kind: CfImagerOpKind
    /** For write: relative image path; for read: device id/path. */
    source: string
    /** For write: device id/path; for read: relative image path. */
    destination: string
    startedAt: string
    progressPct: number
    bytesDone?: number
    bytesTotal?: number
    message?: string
}

/** High-level state slice for AppState.cfImager. */
export interface CfImagerState {
    phase: CfImagerPhase
    media: CfImagerMediaStatus
    message?: string
    device?: CfImagerDeviceInfo
    fs: CfImagerFsState
    currentOp?: CfImagerCurrentOp
    lastError?: string
}

/* -------------------------------------------------------------------------- */
/*  Events + sink                                                             */
/* -------------------------------------------------------------------------- */

export interface CfImagerEventSink {
    publish(evt: CfImagerEvent): void
}

export type CfImagerEvent =
    | {
          kind: 'cf-device-identified'
          at: number
          device: CfImagerDeviceInfo
      }
    | {
          kind: 'cf-device-disconnected'
          at: number
          deviceId: string
          reason: 'device-lost' | 'explicit-close' | 'io-error' | 'unknown'
      }
    | {
          kind: 'cf-fs-updated'
          at: number
          fs: CfImagerFsState
      }
    | {
          kind: 'cf-op-started'
          at: number
          op: CfImagerCurrentOp
      }
    | {
          kind: 'cf-op-progress'
          at: number
          op: CfImagerCurrentOp
      }
    | {
          kind: 'cf-op-completed'
          at: number
          op: CfImagerCurrentOp
      }
    | {
          kind: 'cf-op-error'
          at: number
          op?: CfImagerCurrentOp
          error: string
      }
    | {
          kind: 'cf-error'
          at: number
          error: string
      }
    | {
          kind: 'cf-media-updated'
          at: number
          media: CfImagerMediaStatus
          /**
           * Optional current device; included when we know it so the adapter
           * can keep device info fresh without guessing.
           */
          device?: CfImagerDeviceInfo
          /**
           * Optional size hint from the probe (bytes for "present", 0 for "none").
           * Useful for logging or future UI polish.
           */
          sizeBytes?: number
          /**
           * Optional human-readable message computed by the service (e.g.
           * "CF card detected", "No CF media in reader", etc.).
           */
          message?: string
      }