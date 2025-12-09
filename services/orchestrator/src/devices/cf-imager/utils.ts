// services/orchestrator/src/core/devices/cf-imager/utils.ts

import { resolve, sep, relative, normalize, extname } from 'node:path'
import { statSync, readdirSync } from 'node:fs'
import type {
    CfImagerConfig,
    CfImagerFsEntry,
    CfImagerFsState,
} from './types.js'

/* -------------------------------------------------------------------------- */
/*  Env → config                                                              */
/* -------------------------------------------------------------------------- */

export function buildCfImagerConfigFromEnv(env: NodeJS.ProcessEnv): CfImagerConfig {
    const rootRaw = env.CF_IMAGER_ROOT ?? ''
    const readScript = env.CF_IMAGER_READ_SCRIPT ?? './read-image.sh'
    const writeScript = env.CF_IMAGER_WRITE_SCRIPT ?? './write-image.sh'
    const maxEntries = parseIntSafe(env.CF_IMAGER_MAX_ENTRIES, 500)
    const fsPollMsRaw = parseIntSafe(env.CF_IMAGER_FS_POLL_MS, 3000)

    if (!rootRaw || rootRaw.trim() === '') {
        throw new Error('CF_IMAGER_ROOT must be set to a valid directory path')
    }

    const rootDir = resolveTilde(rootRaw.trim())
    const readScriptPath = resolve(readScript.trim())
    const writeScriptPath = resolve(writeScript.trim())

    const visibleExtensions = parseVisibleExtensions(env.CF_IMAGER_VISIBLE_EXTENSIONS)

    const fsPollIntervalMs = fsPollMsRaw > 0 ? fsPollMsRaw : 0

    return {
        rootDir,
        readScriptPath,
        writeScriptPath,
        maxEntriesPerDir: maxEntries,
        visibleExtensions,
        fsPollIntervalMs,
    }
}

function parseIntSafe(value: string | undefined, fallback: number): number {
    if (!value) return fallback
    const n = Number.parseInt(value, 10)
    return Number.isNaN(n) ? fallback : n
}

/**
 * Parse a comma-separated list of extensions (without dots) into a normalized
 * lowercase string array. Empty/whitespace entries are discarded.
 *
 * Example:
 *   "img, iso ,IMG" -> ["img", "iso"]
 *
 * Returns [] when unset/empty so callers can treat that as "no filter".
 */
function parseVisibleExtensions(raw: string | undefined): string[] {
    if (!raw) return []
    return raw
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(s => s.length > 0)
}

function resolveTilde(p: string): string {
    if (!p.startsWith('~')) return resolve(p)
    const home = process.env.HOME || process.env.USERPROFILE || ''
    if (!home) return resolve(p.slice(1))
    return resolve(p.replace(/^~(?=$|\/|\\)/, home))
}

/* -------------------------------------------------------------------------- */
/*  Root-constrained path helpers                                             */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a relative path within rootDir.
 *
 * - Collapses ".." and ".".
 * - Ensures the result never leaves rootDir; if it would, throws.
 */
export function resolveUnderRoot(rootDir: string, rel: string): string {
    const root = normalize(resolve(rootDir))
    const abs = normalize(resolve(root, rel || '.'))

    // Ensure abs is a descendant of root
    const relFromRoot = relative(root, abs)
    if (relFromRoot.startsWith('..') || (relFromRoot === '' && !abs.startsWith(root))) {
        throw new Error(`Path "${rel}" escapes root "${root}"`)
    }

    return abs
}

/**
 * Compute a safe cwd string (relative, POSIX-style) from an absolute path
 * under rootDir.
 */
export function toRelativeCwd(rootDir: string, absPath: string): string {
    const root = normalize(resolve(rootDir))
    const abs = normalize(resolve(absPath))
    let relPath = relative(root, abs)
    if (!relPath || relPath === '') relPath = '.'
    return relPath.split(sep).join('/')
}

/* -------------------------------------------------------------------------- */
/*  Directory listing                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Build a filesystem snapshot for the given absolute cwd within rootDir.
 *
 * visibleExtensions:
 *   - If provided and non-empty, only files whose extension (lowercase,
 *     without the dot) is in the list are included.
 *   - Directories are always included.
 *   - Internal companion files such as *.part are always hidden.
 */
export function listDirectoryState(
    rootDir: string,
    cwdAbs: string,
    maxEntries: number,
    visibleExtensions?: string[] | null
): CfImagerFsState {
    const rootNorm = normalize(resolve(rootDir))
    const cwdNorm = normalize(resolve(cwdAbs))

    const cwdRel = toRelativeCwd(rootNorm, cwdNorm)

    const filterExts = (visibleExtensions ?? []).map(e => e.toLowerCase())
    const hasFilter = filterExts.length > 0

    let entries: CfImagerFsEntry[] = []

    try {
        const names = readdirSync(cwdNorm, { withFileTypes: true })
        for (const d of names) {
            if (!d.name) continue

            const entryPath = resolve(cwdNorm, d.name)
            let stat
            try {
                stat = statSync(entryPath)
            } catch {
                continue
            }

            const isDir = d.isDirectory()
            const isFile = d.isFile()

            if (!isDir && !isFile) continue

            const name = d.name

            if (isFile) {
                // Internal: always hide *.part companions regardless of config.
                const ext = extname(name) // includes leading dot, e.g. ".img"
                const extLower = ext.toLowerCase()

                if (extLower === '.part') {
                    continue
                }

                if (hasFilter) {
                    const extBare = extLower.startsWith('.') ? extLower.slice(1) : extLower
                    if (!filterExts.includes(extBare)) {
                        continue
                    }
                }
            }

            // Display name: strip *any* extension for files we actually show.
            let displayName = name
            if (!isDir) {
                const ext = extname(name)
                if (ext) {
                    displayName = name.slice(0, -ext.length)
                }
            }

            entries.push({
                name: displayName,
                kind: isDir ? 'dir' : 'file',
                sizeBytes: isDir ? undefined : stat.size,
                modifiedAt: stat.mtime.toISOString(),
            })
        }
    } catch {
        // On any FS error, just return an empty listing and let caller emit error.
        entries = []
    }

    // Sort alphabetically by name (case-insensitive), then by kind as a stable tiebreaker
    entries.sort((a, b) => {
        const na = a.name.toLowerCase()
        const nb = b.name.toLowerCase()
        if (na < nb) return -1
        if (na > nb) return 1
        // If names collide, keep directories before files for a small UX nicety.
        if (a.kind === b.kind) return 0
        return a.kind === 'dir' ? -1 : 1
    })

    if (entries.length > maxEntries) {
        entries = entries.slice(0, maxEntries)
    }

    return {
        rootPath: rootNorm,
        cwd: cwdRel,
        entries,
    }
}