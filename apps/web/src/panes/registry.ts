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

function prettifyName(base: string): string {
  if (!base) return ''
  const withSpaces = base
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  return withSpaces.replace(/\b\w/g, (m) => m.toUpperCase())
}

const registry: Record<string, PaneMeta> = {}

for (const [path, loader] of Object.entries(discovered)) {
  const file = (path.split('/').pop() ?? '').replace(/\.vue$/i, '')
  const id = file
  const label = prettifyName(file)
  if (!registry[id]) {
    registry[id] = {
      id,
      label,
      component: defineAsyncComponent(loader),
    }
  }
}

export function listPanes(): Array<{ id: string; label: string }> {
  return Object.values(registry).map(({ id, label }) => ({ id, label }))
}

export function resolvePane(id: string): Component | null {
  return registry[id]?.component ?? null
}

export function hasPane(id: string): boolean {
  return !!registry[id]
}