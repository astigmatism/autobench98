import { defineAsyncComponent, type Component } from 'vue'

const discovered = import.meta.glob('../components/panes/**/*.vue') as Record<
  string,
  () => Promise<any>
>

export type PaneMeta = {
  id: string
  label: string
  component: Component
}

/** Make "LogsViewer" -> "Logs Viewer", "cpu_stats" -> "Cpu Stats", etc. */
export function prettifyName(base: string): string {
  if (!base) return ''
  const withSpaces = base
    // add space before capitals in camelCase / PascalCase
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // underscores/dashes to spaces
    .replace(/[_-]+/g, ' ')
    .trim()
  // Upper-case first letter of each word
  return withSpaces.replace(/\b\w/g, (m) => m.toUpperCase())
}

const registry: Record<string, PaneMeta> = {}

for (const [path, loader] of Object.entries(discovered)) {
  const file = (path.split('/').pop() ?? '').replace(/\.vue$/i, '').trim()
  const id = file
  const label = prettifyName(file)
  if (!id) continue

  if (!registry[id]) {
    registry[id] = {
      id,
      label,
      component: defineAsyncComponent(loader),
    }
  }
}

/** List panes for UI dropdowns. */
export function listPanes(): Array<{ id: string; label: string }> {
  return Object.values(registry).map(({ id, label }) => ({ id, label }))
}

/** Resolve a pane id to its (lazy) component, or null if missing. */
export function resolvePane(id: string): Component | null {
  return registry[id]?.component ?? null
}

/** Fast existence check. */
export function hasPane(id: string): boolean {
  return !!registry[id]
}

/** NEW: Human-label for a pane id (falls back to prettify if unknown at runtime). */
export function getPaneLabel(id: string | null | undefined): string {
  if (!id) return 'Empty Pane'
  return registry[id]?.label ?? prettifyName(id)
}

/* -------------------------------------------------------------------------- */
/*  Per-pane UI prefs specs (for profile + localStorage persistence)           */
/* -------------------------------------------------------------------------- */

export type PanePrefsSpec = {
  /**
   * Logical id for the prefs domain, e.g. "logs" / "stream".
   * Used only for debugging and de-duping.
   */
  id: string

  /** localStorage key prefix. Full key becomes `${storagePrefix}${leafId}`. */
  storagePrefix: string

  /** leaf.props key that stores the embedded prefs in a saved profile snapshot. */
  propsKey: string

  /**
   * leaf.props key used to stamp a monotonically increasing number when a profile loads,
   * so panes can force a rehydrate even if the leaf id didn’t change.
   */
  profileRevKey: string
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0
}

function isValidPrefsSpec(x: any): x is PanePrefsSpec {
  if (!x || typeof x !== 'object') return false
  return (
    isNonEmptyString(x.id) &&
    isNonEmptyString(x.storagePrefix) &&
    isNonEmptyString(x.propsKey) &&
    isNonEmptyString(x.profileRevKey)
  )
}

const prefsSpecsById = new Map<string, PanePrefsSpec>()

/**
 * Register a prefs spec.
 * This is intentionally a no-op for invalid/duplicate registrations so discovery can be “best effort”.
 */
export function registerPanePrefsSpec(spec: PanePrefsSpec): void {
  if (!isValidPrefsSpec(spec)) return
  const id = spec.id.trim()
  if (!id) return
  if (prefsSpecsById.has(id)) return
  prefsSpecsById.set(id, {
    id,
    storagePrefix: spec.storagePrefix,
    propsKey: spec.propsKey,
    profileRevKey: spec.profileRevKey,
  })
}

/**
 * Enumerate all registered prefs specs in a stable order.
 * App.vue uses this to embed/restore/stamp without knowing pane specifics.
 */
export function listPanePrefsSpecs(): PanePrefsSpec[] {
  return Array.from(prefsSpecsById.values()).sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Discovery mechanism: panes can contribute a tiny sidecar module that exports:
 *   export const panePrefsSpec: PanePrefsSpec = { ... }
 *
 * This keeps App.vue free of per-pane wiring, and avoids needing to edit this file for each new pane.
 *
 * Convention: `apps/web/src/components/panes/** / *.panePrefs.ts`
 */
const discoveredPrefs = import.meta.glob('../components/panes/**/*.panePrefs.ts', {
  eager: true,
}) as Record<string, any>

for (const mod of Object.values(discoveredPrefs)) {
  const spec = mod?.panePrefsSpec ?? mod?.default ?? null
  if (isValidPrefsSpec(spec)) registerPanePrefsSpec(spec)
}
