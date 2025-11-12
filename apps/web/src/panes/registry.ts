// apps/web/src/panes/registry.ts
import { defineAsyncComponent, type Component } from 'vue'

/**
 * Auto-discover panes from: src/components/panes/**
 * Any *.vue SFC in that folder (and subfolders) is considered a pane.
 *
 * Examples:
 *  - src/components/panes/Logs.vue
 *  - src/components/panes/video/Player.vue
 *
 * The pane id is the SFC file name (without .vue). Labels are prettified.
 */

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
function prettifyName(base: string): string {
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

/** Build a registry keyed by file base name (unique per folder). */
const registry: Record<string, PaneMeta> = {}

for (const [path, loader] of Object.entries(discovered)) {
  const file = (path.split('/').pop() ?? '').replace(/\.vue$/i, '')
  const id = file // e.g. "Logs", "Player", "Stats"
  const label = prettifyName(file)
  if (!registry[id]) {
    registry[id] = {
      id,
      label,
      component: defineAsyncComponent(loader),
    }
  } else {
    // In the rare case of duplicate ids (same file base name in different subdirs),
    // prefer the first and ignore subsequent duplicates to keep behavior deterministic.
    // If you want strictness, we can throw instead.
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