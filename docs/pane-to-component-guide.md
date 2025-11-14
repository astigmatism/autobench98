
# Pane → Component Communication Guide

**Audience:** humans & AI assistants  
**Scope:** Autobench98 Studio front‑end (apps/web).  
**Purpose:** Define a clear, stable contract for how a pane (layout leaf) passes context into the component it renders, so new panes can be built consistently.

---

## TL;DR (for quick implementers)

- Your pane component **receives a single optional prop**: `pane?: PaneInfo`.
- Use `pane.appearance.bg` to **pick readable foreground colors** (see “Contrast helpers”).
- Treat the outer container as **authoritative for width/height** — size *inside* with `width: 100%; height: 100%` and avoid adding external margins.
- When in a split:
  - `pane.parentDir === 'row'` → siblings are side‑by‑side (main axis = **width**).
  - `pane.parentDir === 'col'` → siblings are stacked (main axis = **height**).
- Respect the user’s **constraints**: if a pane was set to a fixed px/% along the main axis, don’t fight it with hard CSS overrides.
- The `id` is stable within a session but **should not be used as storage key**; prefer your own keys.
- Always handle `pane` being **undefined** for forward compatibility.

---

## The Contract

### Type

```ts
// Keep in sync with apps/web/src/App.vue (renderer block)
export type Direction = 'row' | 'col'

export type Constraints = {
  widthPx?: number | null
  heightPx?: number | null
  /** percentage sizing relative to the split container (0–100) */
  widthPct?: number | null
  heightPct?: number | null
}

export type Appearance = {
  /** Hex color #rrggbb (or null for default) */
  bg?: string | null
  /** Insets in px applied by the layout engine */
  mTop?: number | null
  mRight?: number | null
  mBottom?: number | null
  mLeft?: number | null
}

export type PaneInfo = {
  /** Layout leaf id (opaque). Stable during a single session */
  id: string
  /** True when this leaf is the layout root */
  isRoot: boolean
  /** Direction of the containing split: siblings flow by 'row' (x) or 'col' (y). Null for root. */
  parentDir: Direction | null

  /** Constraints applied directly on this leaf */
  constraints: Constraints

  /** Appearance hints configured by the user */
  appearance: Appearance

  /** Container (parent split) info, if present */
  container: {
    constraints: Constraints | null
    direction: Direction | null
  }
}
```

### How it’s passed to your component

In `App.vue` the renderer resolves the pane component and mounts it like this:

```ts
h(ResolvedComponent as any, { pane: paneInfo, ...(leaf.props ?? {}) })
```

So your SFC should accept it as a prop:

```vue
<script setup lang="ts">
import type { PaneInfo } from '@/App.vue' // or copy the type locally

defineProps<{ pane?: PaneInfo }>()

// Optional: derived values with sane fallbacks
const bg = computed(() => pane?.appearance?.bg ?? '#ffffff')
</script>
```

> ⚠️ Your component may be mounted before `pane` is available in a future refactor. Always guard for `undefined`.

---

## Layout Responsibilities

- **Outer sizing** (width/height, margins, padding) is handled by the layout engine.
  - Your component container should typically be:

    ```css
    :host, .root {
      width: 100%;
      height: 100%;
      display: flex; /* or grid */
      min-width: 0;  /* allow flex text ellipsis */
      min-height: 0; /* allow nested scrollers */
    }
    ```

- **Scrolling**: provide internal scrollers as needed; don’t force the page to scroll.
- **Padding vs margins**: The layout engine already applies insets from `appearance.m*`. Prefer internal spacing (gap/padding) inside your component.

---

## Reading Constraints (when you need them)

- `pane.parentDir` defines the main axis. Along that axis, a sibling might be fixed (`widthPx`/`heightPx`) or percentage‐sized (`widthPct`/`heightPct`). Treat that as authoritative.
- Use constraints for **heuristics**, not absolutes. Example: if the main axis is tight (small px), render a compact toolbar.

```ts
const mainAxis = pane?.parentDir === 'row' ? 'width' : pane?.parentDir === 'col' ? 'height' : null
const mainPx = mainAxis === 'width' ? pane?.constraints?.widthPx : pane?.constraints?.heightPx
const mainPct = mainAxis === 'width' ? pane?.constraints?.widthPct : pane?.constraints?.heightPct
const isCompact = (mainPx ?? 0) > 0 || (mainPct ?? 0) > 0
```

---

## Appearance & Contrast

Use `pane.appearance.bg` to theme your UI surfaces and choose text/icon colors with adequate contrast.

### Minimal contrast helpers (copy‑paste)

```ts
export function normalizeHex(input: unknown): string | null {
  const s = typeof input === 'string' ? input.trim() : ''
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s)) return null
  if (s.length === 4) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase()
  return s.toLowerCase()
}

function hexToRgb(hex: string) {
  const n = hex.replace('#', '')
  return { r: parseInt(n.slice(0,2),16), g: parseInt(n.slice(2,4),16), b: parseInt(n.slice(4,6),16) }
}
function srgbToLinear(c: number) { const s = c/255; return s <= 0.04045 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4) }
function relativeLuminance(hex: string) {
  const { r, g, b } = hexToRgb(hex)
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b)
  return 0.2126*R + 0.7152*G + 0.0722*B
}
function contrastRatio(L1: number, L2: number) { const [a,b] = L1>=L2?[L1,L2]:[L2,L1]; return (a+0.05)/(b+0.05) }
export function bestContrastOnBlackOrWhite(bgHex: string) {
  const Lbg = relativeLuminance(bgHex)
  const cBlack = contrastRatio(Lbg, 0)
  const cWhite = contrastRatio(1, Lbg)
  return cBlack >= cWhite ? '#111827' : '#ffffff'
}
```

**Usage:**

```vue
<template>
  <div class="root" :style="{ color: fg, background: bg }">…</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { PaneInfo } from '@/App.vue'
import { bestContrastOnBlackOrWhite, normalizeHex } from '@/lib/contrast' // or inline

const props = defineProps<{ pane?: PaneInfo }>()

const bg = computed(() => normalizeHex(props.pane?.appearance?.bg) ?? '#ffffff')
const fg = computed(() => bestContrastOnBlackOrWhite(bg.value))
</script>
```

---

## Example: Logs Pane (excerpt)

```ts
const fgToolbar = computed(() => bestContrastOnBlackOrWhite(bg.value))
// Apply fgToolbar to plain text elements that sit outside dark panels.
```

The layout engine already ensures the empty-state label gets a readable color based on the pane bg. You can do the same for any top‑level text in your component.

---

## Do’s & Don’ts

**Do**
- Handle `pane` being missing.
- Use `width:100%; height:100%` for the outermost component wrapper.
- Use `min-width:0; min-height:0` inside flex/grid parents.
- Respect user constraints along the main axis.
- Use `pane.appearance.bg` for theme decisions & contrast.

**Don’t**
- Hard‑code outer margins that break the grid alignment.
- Override computed sizes with fixed viewport units unless necessary.
- Persist data under `pane.id` as a long‑term key.

---

## Testing Checklist

- [ ] Renders correctly with `pane` undefined.
- [ ] Renders with dark/light backgrounds; foreground remains readable.
- [ ] Respects tight px or pct constraints without overflow.
- [ ] No global scrollbars; internal scrolling works.
- [ ] Toolbar/buttons wrap gracefully at small widths.

---

## Versioning

This contract is considered **stable**. If fields are added, they’ll be optional and defaultable. Breaking changes will be announced with a `feat!:` commit and documented here.

---

## FAQ

**Q: Can my component change its pane’s constraints?**  
*A:* Not directly; the layout is server-authoritative. Expose UI in your component and route changes through the Pane Settings dialog (or future layout APIs).

**Q: How do I know if I’m root?**  
*A:* `pane.isRoot === true`. Some panes might choose to render extra chrome when they are the root.

---

*Document owner:* Studio Front‑end  
*Last updated:* 2025-11-14T23:08:19.229021Z
