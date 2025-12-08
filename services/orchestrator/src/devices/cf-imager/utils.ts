// services/orchestrator/src/core/devices/cf-imager/utils.ts

import { resolve, sep, relative, normalize } from 'node:path'
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

    if (!rootRaw || rootRaw.trim() === '') {
        throw new Error('CF_IMAGER_ROOT must be set to a valid directory path')
    }

    const rootDir = resolveTilde(rootRaw.trim())
    const readScriptPath = resolve(readScript.trim())
    const writeScriptPath = resolve(writeScript.trim())

    return {
        rootDir,
        readScriptPath,
        writeScriptPath,
        maxEntriesPerDir: maxEntries,
    }
}

function parseIntSafe(value: string | undefined, fallback: number): number {
    if (!value) return fallback
    const n = Number.parseInt(value, 10)
    return Number.isNaN(n) ? fallback : n
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
    if (relFromRoot.startsWith('..') || relFromRoot === '' && !abs.startsWith(root)) {
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

export function listDirectoryState(
    rootDir: string,
    cwdAbs: string,
    maxEntries: number
): CfImagerFsState {
    const rootNorm = normalize(resolve(rootDir))
    const cwdNorm = normalize(resolve(cwdAbs))

    const cwdRel = toRelativeCwd(rootNorm, cwdNorm)

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

            // Hide non-.img files from the pane? For now, we only special-case
            // .img/.part; other files are left visible so you can see them.
            const name = d.name
            const extLower = name.toLowerCase().endsWith('.img')
            const displayName = extLower ? name.slice(0, -4) : name

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

    if (entries.length > maxEntries) {
        entries = entries.slice(0, maxEntries)
    }

    return {
        rootPath: rootNorm,
        cwd: cwdRel,
        entries,
    }
}