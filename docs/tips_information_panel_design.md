# Tips & Information Panel — Design Document (v1)

**Scope:** AutoBench98 Orchestrator (Fastify) + Studio (apps/web)  
**Feature:** Tips and Information Panel (new pane)  
**Status:** Design / implementation plan (no code in this doc)  
**Goal:** Add a new **WebSocket-driven pane** that displays rotating “tips / information” with **optional image + text**, sourced from **Google Sheets**, with **server-authoritative** selection based on orchestrator/benchmark state.

---

## 1) Requirements

### 1.1 UI (pane)
- New pane: **Tips and Information Panel**.
- Displays a single **current tip page** at a time:
  - `text` (sentence/paragraph)
  - optional `imageUrl`
  - optional metadata (category, page indicator, timestamps).
- Cycles automatically at a configurable cadence (**server-owned**; pane renders what it receives).
- Must render correctly when `pane` prop is **undefined**.
- Must respect the pane contract:
  - outer container `width:100%`, `height:100%`, `min-width:0`, `min-height:0`
  - no external margins (layout engine owns insets)
  - internal scrolling only.
- Must use `pane.appearance.bg` to choose readable foreground text (contrast helper pattern).

### 1.2 Backend ownership
- **Backend chooses the next tip** (frontend never selects).
- Backend determines **eligible categories** from orchestrator state (e.g., Quake2 benchmark running → Quake2 category eligible).
- Dedupe rule (v1): **exhaust all tips in a category before repeating**.
- Pagination rule (v1): a single tip may span multiple cycles (“pages”) before selecting the next tip.
- Tips are fetched/parsed from Google Sheets and updated “live” (with caching/TTL; not per tick).

### 1.3 Logging
- Tips subsystem must use `@autobench98/logging` with its **own service name**, and must write into the **shared** `app.clientBuf` (no new `makeClientBuffer()` inside the plugin).
- Use existing `LogChannel`s (prefer `google-sheets` for fetch/parse; `benchmark`/`app` for rotation decisions).
- Ensure channels used are present in `LOG_CHANNEL_ALLOWLIST` so logs appear in WS UI stream.

### 1.4 Configuration (.env)
- Add a new `.env` section for tips with safe defaults (**disabled by default**).
- Reuse existing Sheets auth env (`GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`).
- Expose server-owned tips config via `state.serverConfig.tips` (like other `serverConfig` areas).

---

## 2) Architecture contract (must follow)

This feature must use the existing WebSocket-driven pane blueprint:

> **service → adapter → AppState → JSON Patch → WS → mirror → pane**

### 2.1 Layer responsibilities
- **Service (backend domain):** talks to Sheets + reads orchestrator state; owns rotation/dedupe/pagination; emits structured events.
- **Adapter (backend):** translates domain events into `AppState` slice updates via state helpers; no domain logic.
- **State (`state.ts`):** owns canonical `AppState`, increments `version`, computes RFC-6902 JSON Patches, emits via `stateEvents`.
- **WS plugin (`ws.ts`):** transports snapshots/patches/log history; remains generic.
- **Mirror store (frontend):** applies `state.snapshot` and `state.patch` to reactive `mirror.data`.
- **Pane:** pure renderer reading from `mirror.data` and the `pane?: PaneInfo` prop.

### 2.2 Explicit design choices
- **Server-authoritative selection:** backend chooses which tip appears next.
- **No pane-to-service coupling:** the pane does not send requests to “get next tip” and does not open WS connections.

---

## 3) Google Sheets source of truth

### 3.1 Worksheet layout
Tips live in a single worksheet/tab in a Google Spreadsheet.

**Header row (Row 1):** category columns.

**Two-column pairing per category (v1):**
- `<category>.img` (image URL string, optional)
- `<category>.text` (tip text, required for a tip to exist)

Example header row:

| quake2.img | quake2.text | general.img | general.text | win98-install.img | win98-install.text |

**Rows 2..N:** tips. Each row may provide a tip for any category. Empty text cells are ignored.

### 3.2 Image representation
- v1 uses **string URLs** in `.img` cells (recommended `https://...`).
- Embedded images inside Sheets cells are not required for v1.
- If image is blank/invalid, treat as `null` and render text-only.

### 3.3 Tip pagination (“multi-cycle tips”)
The `.text` cell may contain multiple pages separated by a delimiter. Default delimiter: `---`.

Example cell:

```
For consistent results, close background apps before running timedemo.
---
Run multiple passes and average results; disk cache warms up.
---
If FPS seems low, verify you’re using the intended renderer (OpenGL vs software).
```

Parsing rules:
- Split by delimiter.
- Trim each page.
- Drop empty pages.

### 3.4 “Unlimited tips”
Within practical API limits, the design assumes an unbounded number of rows.
- Implementation may compute used range via metadata or read a large range and stop at trailing empty rows.

### 3.5 Header parsing rules
- Scan Row 1 left-to-right.
- Identify `.img` headers; validate partner column at `i+1` is `.text` with the same category prefix.
- Derive category name by stripping suffix.

Strictness:
- **Tolerant mode (default):** warn and skip malformed columns.
- **Strict mode:** fail load if any malformed header pairing is detected.

---

## 4) Domain model and events

### 4.1 Core terms
- **Category:** named group of tips (e.g., `quake2`, `general`, `win98-install`).
- **Tip:** a single authored entry (row cell) for a category, potentially multi-page.
- **Page:** one segment of a tip displayed for one cycle.

### 4.2 Tip identity
The backend needs stable identities for dedupe.

v1 recommendation: deterministic hash-based id, e.g.

`tipId = hash(category + '|' + rowIndex + '|' + normalizedText + '|' + normalizedImageUrl)`

Rationale:
- Row indices can change; including content reduces collision and preserves stability.
- Future enhancement: author-defined IDs (extra sheet column) if needed.

### 4.3 In-memory types (illustrative)

```ts
type Tip = {
  tipId: string
  category: string
  imageUrl?: string | null
  rawText: string
  pages: string[]
}

type TipsCurrent = {
  category: string
  tipId: string
  pageIndex: number
  pageCount: number
  text: string
  imageUrl?: string | null
  shownAt: number
}

type TipsEvent =
  | { kind: 'tips-disabled'; at: number; reason?: string }
  | { kind: 'tips-loading'; at: number }
  | { kind: 'tips-ready'; at: number; categories: string[]; totalTips: number }
  | { kind: 'tips-refreshed'; at: number; categories: string[]; totalTips: number }
  | { kind: 'tips-tip-shown'; at: number; current: TipsCurrent }
  | { kind: 'tips-category-exhausted'; at: number; category: string; total: number }
  | { kind: 'tips-error'; at: number; error: string }

interface TipsEventSink {
  publish(evt: TipsEvent): void
}
```

---

## 5) Backend service design

### 5.1 TipsRotationService responsibilities
The backend domain service (“TipsRotationService”) must:

1. Load tips from Sheets on startup.
2. Parse and normalize tips into per-category lists.
3. Determine eligible categories based on orchestrator state.
4. Maintain dedupe state (category decks).
5. Manage pagination across cycles.
6. Refresh from Sheets on TTL/interval (not per tick).
7. Emit only domain events (no `AppState` mutations).
8. Log to the shared client log buffer via `@autobench98/logging`.

### 5.2 Lifecycle
- `start()`
  - If `TIPS_ENABLED=false`, emit `tips-disabled` and do not start timers.
  - Else:
    - emit `tips-loading`
    - load + parse tips
    - emit `tips-ready` or `tips-error`
    - start rotation timer (`TIPS_INTERVAL_MS`)
    - start refresh schedule or TTL logic (`TIPS_CACHE_TTL_MS`)

- `stop()`
  - clear timers
  - release resources

### 5.3 Eligibility rules (category gating)
- Tips are categorized by the sheet headers.
- The service must compute eligible categories each cycle.

v1 policy:
- Always include `TIPS_DEFAULT_CATEGORIES` (if they exist).
- If a benchmark is active, include its category (e.g., `quake2`).
- If benchmark category has no tips, fall back to defaults.

Implementation guidance:
- Define a mapping from orchestrator “active benchmark id/name” to category name.
- Optionally support `TIPS_BENCHMARK_CATEGORY_PREFIX` if you want conventions like `bench:quake2`.

### 5.4 Dedupe rule (v1): exhaust-then-repeat
For each category:
- Initialize deck = shuffled list of all `tipId`s in that category.
- When selecting a new tip for a category, pop from deck.
- When deck becomes empty:
  - emit `tips-category-exhausted`
  - rebuild deck by reshuffling all tip ids.

Notes:
- Dedupe is at the **tip** level, not page level.

### 5.5 Pagination policy
On each rotation tick:
- If a current tip exists and `pageIndex + 1 < pageCount`, advance to the next page.
- Else, select a new tip and start at `pageIndex=0`.

### 5.6 Refresh + caching
- Do **not** call Sheets API each tick.
- Use a refresh TTL and/or periodic refresh timer.
- On refresh:
  - replace the tips map
  - reset decks (v1 acceptable)
  - emit `tips-refreshed`

### 5.7 Error handling
- Sheets fetch/parse errors should:
  - be logged
  - emit `tips-error` with a safe message
  - set AppState phase to `error` via adapter
- Recommended behavior: keep the last successful `current` tip visible if refresh fails.

---

## 6) Backend adapter + AppState integration

### 6.1 New AppState slice
Add `tipsPanel: TipsSnapshot` to `AppState`.

### 6.2 Snapshot shape
Follow existing service snapshot conventions:

```ts
type TipsPhase = 'disabled' | 'loading' | 'ready' | 'error'

type TipsSnapshot = {
  phase: TipsPhase
  message?: string
  stats: {
    totalEvents: number
    lastEventAt: number | null
    lastErrorAt: number | null
    lastRefreshAt: number | null
    totalTips: number
    totalCategories: number
  }
  current: TipsCurrent | null
  eligibleCategories: string[]
}
```

### 6.3 Initial state
- If tips disabled → `phase='disabled'` + message.
- If enabled but not loaded yet → `phase='loading'`.

### 6.4 State helpers
Add helpers in `state.ts`:
- `setTipsSnapshot(next: TipsSnapshot)`
- `updateTipsSnapshot(partial: Partial<TipsSnapshot> & { stats?: Partial<TipsSnapshot['stats']> })`

### 6.5 TipsStateAdapter
- Receives `TipsEvent`s and updates `tipsPanel` via `updateTipsSnapshot`.
- “Thin” logic only:
  - map `tips-loading` → phase loading
  - map `tips-ready` / `tips-refreshed` → counts + `lastRefreshAt`
  - map `tips-tip-shown` → set `current` + stats
  - map `tips-error` → phase error + message + `lastErrorAt`

---

## 7) Fastify plugin wiring

### 7.1 Plugin responsibilities
- Instantiate the TipsRotationService and its sinks.
- Decorate `app` with the service instance.
- Start on `onReady`, stop on `onClose`.

### 7.2 Logging
- Fastify should run with `logger:false`.
- Tips plugin must use `createLogger('<service-name>', app.clientBuf)`.
- Must not instantiate another client buffer.

Channel guidance:
- Use `google-sheets` channel for Sheets operations.
- Use `benchmark` or `app` channel for selection/rotation summaries.

Log events (minimum):
- start/stop
- sheet load success (tips/categories)
- sheet load failure
- refresh success/failure
- eligibility decisions (debug)
- tip shown: category, tipId, pageIndex/pageCount
- deck exhausted + reshuffle

### 7.3 WS plugin
- No changes required; tips slice changes will be included in JSON Patch frames automatically.

---

## 8) Configuration plan (.env + serverConfig)

### 8.1 Proposed `.env` keys (v1)
Enablement/cadence:
- `TIPS_ENABLED=false`
- `TIPS_INTERVAL_MS=10000`

Sheets:
- `TIPS_SHEETS_TAB=TIPS`
- `TIPS_PAGE_DELIM=---`
- `TIPS_CACHE_TTL_MS=30000`
- `TIPS_STRICT=false`

Eligibility:
- `TIPS_DEFAULT_CATEGORIES=general,win98-install`
- `TIPS_BENCHMARK_CATEGORY_PREFIX=` (optional)
- `TIPS_FALLBACK_TO_DEFAULT_WHEN_BENCH_EMPTY=true`

Guardrails:
- `TIPS_MAX_TEXT_CHARS=4000`
- `TIPS_MAX_PAGES_PER_TIP=10`

Reuse existing Sheets auth vars:
- `GOOGLE_SHEETS_SPREADSHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`

### 8.2 Server-owned exposure: `serverConfig.tips`
Extend `AppState.serverConfig` with a tips config object:

```ts
type TipsServerConfig = {
  enabled: boolean
  intervalMs: number
  pageDelim: string
  defaultCategories: string[]
  tab: string
  cacheTtlMs: number
}
```

The pane may display these values later; v1 can treat it as diagnostics.

---

## 9) Frontend pane design

### 9.1 Data flow
- Pane reads from mirror store:
  - `mirror.data.tipsPanel`
- Pane does not speak to WS directly and does not fetch tips.

### 9.2 Rendering
- Header: title + status badge (derived from `phase`).
- Main:
  - image (if `current.imageUrl`)
  - text (current page)
  - internal scroll for long text.
- Footer (optional): category label + page indicator `2 / 4` + times.

### 9.3 Constraints and theming
- Respect constraints heuristically (compact mode): hide footer/metadata if main axis is tight.
- Use `pane.appearance.bg` + contrast helper to ensure readable text.

### 9.4 Forbidden behaviors
- No persistence keyed by `pane.id`.
- No direct selection logic; the pane renders server state.

---

## 10) Operational walkthrough

### 10.1 Startup
- Disabled: `phase=disabled`.
- Enabled: `phase=loading` → `ready` after initial load.
- Rotation tick begins; each tick emits `tips-tip-shown` events.

### 10.2 Benchmark-aware selection
- When benchmark changes, eligible categories update.
- Active benchmark category tips become eligible (and optionally preferred).
- If empty/unavailable, fall back to default categories.

### 10.3 Errors
- Sheets errors → log + `phase=error` (message set).
- Recommended: retain last shown tip while in error.

---

## 11) Testing checklist

### 11.1 Backend unit tests
- header parsing (paired columns)
- strict vs tolerant schema behavior
- tip parsing + pagination splitting
- dedupe (exhaust then reshuffle)
- page sequencing across ticks
- eligibility gating + fallback
- refresh TTL (no API spam)

### 11.2 Backend integration
- `tipsPanel` slice updates produce JSON Patch frames
- WS broadcasts patches (no `ws.ts` change)
- logs appear in client stream via shared buffer

### 11.3 Frontend
- renders with `pane` undefined
- readable on dark/light backgrounds
- phases (disabled/loading/error/ready)
- image optional layout
- internal scrolling, no global scrollbars

---

## 12) Future extensions
- weighted selection / cooldowns
- phase-specific categories (setup vs run vs post-run)
- UI controls (pause/next/pin) as server-authoritative intents
- richer formatting (safe markdown subset)
- persistent deck state across restarts (DATA_DIR)

---

## Appendix A — Example sheet content

Header row:

```
quake2.img | quake2.text | general.img | general.text | win98-install.img | win98-install.text
```

Example `quake2.text` cell:

```
For consistent results, close background apps before running timedemo.
---
Run multiple passes and average results; disk cache warms up.
---
If FPS seems low, verify you’re using the intended renderer (OpenGL vs software).
```

**End of document.**
