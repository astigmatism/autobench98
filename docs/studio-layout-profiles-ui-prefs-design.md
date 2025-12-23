# Studio Layout Profiles + Global UI Preferences Persistence (Design)

**Status:** Proposal  
**Audience:** Humans + AI (implementation guide)  
**Scope:** Autobench98 Studio (web) + Orchestrator (server)  
**Last updated:** 2025-12-22

---

## Problem statement

The Studio currently has **two parallel persistence mechanisms**:

1. **Server-side layout profiles** (`/api/layouts/*`) stored in `layouts.json`
2. **Client-side localStorage fallback** (`ab98:studio:layout`) that stores the raw layout tree

Separately, pane UI preferences (example: Logs filters/sorting/autoscroll) are persisted **only locally** (e.g., `logs:ui`), and are **not associated with a saved layout profile**.

This causes a few issues:

- A user expects a saved **layout profile** to restore not just pane placement, but also the **UI state** that makes the layout useful (filters, sorting, selected channels, etc.).
- localStorage persistence can “fight” with server profiles (e.g., you load a server profile, then localStorage rehydrates/overwrites or persists stale state back).
- Global UI preferences are not portable across machines and are not exportable/importable with layouts.

---

## Goals

1. Extend layout profiles to optionally include **global Studio UI preferences** (“prefs”).
2. Define a clear **precedence / hydration order** between:
   - server profile prefs
   - client localStorage prefs
   - server defaults / serverConfig
3. Make profiles **portable** via existing export/import endpoints (include prefs).
4. Keep the implementation incremental and backwards compatible:
   - existing profiles without prefs continue to work
   - existing localStorage prefs remain a fallback

---

## Non-goals

- Do not implement real-time collaborative editing of layouts via WebSocket.
- Do not require every pane to store state; only global UI preferences are in scope.
- Do not redesign the Studio layout tree model (leaf/split).
- Do not move device command handling into layout profiles.

---

## Current architecture summary

### Web app (Studio)

- **Layout editor/renderer owner:** `apps/web/src/App.vue`
  - Maintains `root` layout tree in a reactive object.
  - Saves/loads server profiles via REST endpoints.
  - Also persists the layout tree to localStorage key `ab98:studio:layout`.
- **WebSocket mirror:** `apps/web/src/bootstrap.ts`, `apps/web/src/lib/wsClient.ts`, `apps/web/src/stores/mirror.ts`
  - Mirrors orchestrator state snapshots/patches.
  - Streams logs history + appends.
- **Logs UI preferences:** `apps/web/src/stores/logs.ts`
  - Persists log viewer UI prefs to localStorage key `logs:ui`
  - Examples: selectedChannels, minLevel, autoscroll, searchText, useChannelFilter, sortDir, capacity

### Server (Orchestrator)

- **Layouts REST API:** `services/orchestrator/src/routes/layouts.ts`
  - Reads/writes `layouts.json` under `DATA_DIR`.
  - Supports CRUD for profiles, default profile, export, import.
- **WebSocket plugin:** `services/orchestrator/src/plugins/ws.ts`
  - Sends `state.snapshot` and `state.patch`
  - Sends `logs.history` and `logs.append`
  - Receives pings, device commands (atlona, cf-imager)
  - **Does not** handle layout persistence over WS

---

## Proposed change

### 1) Add `prefs` to a layout profile

Extend the profile schema stored server-side:

```ts
type Profile = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  layout: LayoutNode
  prefs?: StudioPrefs
}
```

Where:

```ts
type StudioPrefs = {
  logs?: LogsPrefs
  // future: ws?: WsPrefs, stream?: StreamPrefs, etc.
}

type LogsPrefs = {
  selectedChannels?: string[]
  minLevel?: 'debug'|'info'|'warn'|'error'|'fatal'
  autoscroll?: boolean
  searchText?: string
  useChannelFilter?: boolean
  sortDir?: 'asc'|'desc'
  capacity?: number
}
```

Notes:

- `prefs` is optional (backwards compatible).
- Server should store unknown keys but may validate “known” shapes conservatively.
- `selectedChannels` is stored as `string[]` for forward compatibility (channels evolve).

### 2) Define precedence rules (hydration order)

When Studio starts:

1. **Server-driven config** (`serverConfig`) is adopted first (if present in initial snapshot):
   - e.g., `logs.capacity`, `logs.minLevel`, `logs.allowedChannels`
2. **Profile prefs** (if a profile is loaded / default profile is set):
   - apply `prefs.logs` to the logs store, etc.
3. **LocalStorage fallback hydration**:
   - only used when profile prefs are absent, or for prefs not present in profile

This ensures:
- server can enforce baseline bounds (capacity / minLevel)
- a profile reliably reproduces the “saved experience”
- localStorage remains a user-friendly fallback

### 3) Align localStorage layout persistence with server profiles

Today, `App.vue` always writes `root` to localStorage on every change.

Proposed behavior:

- Keep localStorage layout as a **fallback** only:
  - If no profile is selected/loaded, use `ab98:studio:layout`.
  - If a profile is selected, do not overwrite global fallback key on every change.
- Optional enhancement: store per-profile draft layout under a profile-scoped key:
  - `ab98:studio:layout:<profileId>` (draft / autosave behavior)
  - This is optional; if added, document the exact behavior to avoid confusion.

### 4) Update REST endpoints to include prefs

- `GET /api/layouts` returns profiles including `prefs` (or omits if undefined).
- `GET /api/layouts/:id` includes prefs.
- `POST /api/layouts` accepts `{ name, layout, prefs? }`.
- `PUT /api/layouts/:id` accepts `{ name?, layout?, prefs? }`.
- Export endpoints include `prefs` transparently.
- Import endpoint accepts `prefs` and carries forward (with normalization / regeneration).

---

## Files involved

### Web (frontend)

- `apps/web/src/App.vue`
  - **Owner** of the layout tree, profile list, load/save actions.
  - Will be responsible for:
    - exporting current prefs when saving/overwriting a profile
    - applying prefs when loading a profile
    - adjusting localStorage behavior to not fight server profiles

- `apps/web/src/stores/logs.ts`
  - Add explicit API:
    - `exportPrefs(): LogsPrefs`
    - `applyPrefs(p: LogsPrefs): void`
  - Update localStorage hydration logic so it can be “skipped” once profile prefs were applied.

- `apps/web/src/bootstrap.ts`
  - Ensure `logs.hydrate()` is called at the correct time (or is indirectly triggered by UI).
  - If `useWsStatus` is intended, wire `WSClient` status events to `wsStatus` store.

- `apps/web/src/components/PaneSettingsModal.vue`
  - Will likely need updates if it triggers profile selection/loading and should display “prefs included” semantics.
  - Not strictly required for the server-side schema change, but likely involved for UX.

### Server (orchestrator)

- `services/orchestrator/src/routes/layouts.ts`
  - Update types and persistence to include `prefs`.
  - Update validation/normalization to accept prefs safely.
  - Ensure export/import preserves prefs.

- (No changes required) `services/orchestrator/src/plugins/ws.ts`
  - WS remains for state+logs streaming and device commands; no layout saving over WS.

---

## Data model details

### Profile evolution and backward compatibility

Existing `layouts.json` contains:

```json
{
  "defaultId": "abc123",
  "items": {
    "abc123": { "id": "...", "name": "...", "layout": { ... } }
  }
}
```

Proposed: allow profile objects to also include `prefs`:

```json
{
  "defaultId": "abc123",
  "items": {
    "abc123": {
      "id": "...",
      "name": "...",
      "layout": { ... },
      "prefs": {
        "logs": {
          "minLevel": "info",
          "useChannelFilter": true,
          "selectedChannels": ["orchestrator","device"]
        }
      }
    }
  }
}
```

Server should:
- not reject older profiles
- treat unknown fields as ignorable (or preserve them if desired)

---

## Implementation sketch (examples)

### A) Frontend: exporting and applying prefs

#### logs store API (example)

```ts
// logs.ts
export type LogsPrefs = {
  selectedChannels?: string[]
  minLevel?: ClientLogLevel
  autoscroll?: boolean
  searchText?: string
  useChannelFilter?: boolean
  sortDir?: 'asc'|'desc'
  capacity?: number
}

export function exportPrefs(): LogsPrefs {
  return {
    selectedChannels: this.selectedChannels,
    minLevel: this.minLevel,
    autoscroll: this.autoscroll,
    searchText: this.searchText,
    useChannelFilter: this.useChannelFilter,
    sortDir: this.sortDir,
    capacity: this.capacity,
  }
}

export function applyPrefs(p?: LogsPrefs) {
  if (!p) return
  // apply carefully with validation
  // set a flag like this._prefsAppliedFromProfile = true
}
```

#### App.vue: include prefs when saving

```ts
const logs = useLogs()

async function overwriteSelected() {
  const id = selectedProfileId.value
  const body = {
    layout: deepClone(root),
    prefs: { logs: logs.exportPrefs() }
  }
  await apiJSON(`/api/layouts/${id}`, { method: 'PUT', body: JSON.stringify(body) })
}
```

#### App.vue: apply prefs when loading

```ts
async function loadProfile(id: string) {
  const data = await apiJSON(`/api/layouts/${id}`)
  applyLayout(data.profile.layout)
  const logs = useLogs()
  logs.applyPrefs(data.profile.prefs?.logs)
}
```

### B) Server: schema changes and validation approach

Minimal validation strategy:

- Accept `prefs` as an object.
- For `prefs.logs`:
  - clamp numeric fields (capacity)
  - validate enums (`minLevel`, `sortDir`)
  - coerce arrays to string arrays
  - drop invalid fields silently (do not 400 unless payload is totally malformed)

This mirrors how layout normalization is handled (best-effort, resilient).

---

## Migration plan

No explicit migration required.

- Old profiles load normally (prefs undefined).
- UI uses localStorage prefs fallback when profile prefs are missing.
- New saves will include prefs, making profiles portable.

Optionally:
- add a one-time tool/script to backfill prefs into profiles if desired,
  but not required for functionality.

---

## Testing strategy

### Unit-ish tests (lightweight)

- `layouts.ts`:
  - reading/writing store with profiles containing prefs
  - import/export round-trip preserves prefs
  - invalid prefs shapes do not crash; fields are sanitized

- `logs.ts`:
  - `applyPrefs` respects validation and does not break store invariants
  - localStorage hydration is skipped/merged correctly when profile prefs applied

### Manual testing checklist

1. Start with empty layouts store; configure logs filters; save profile.
2. Reload Studio; load profile; verify logs filters restore.
3. Export profile; import into a clean DATA_DIR; verify prefs included.
4. Verify serverConfig adoption still works (capacity/minLevel).
5. Verify localStorage fallback still works if no profile selected.

---

## Rollout plan

1. Land server changes first (accept/store prefs; backwards compatible).
2. Land frontend changes:
   - export/apply prefs
   - adjust hydration precedence and localStorage behavior
3. Optional UX polish:
   - indicate when profile contains prefs (“Includes UI prefs” badge)
   - add “Reset UI prefs” action for troubleshooting

---

## Open questions / decisions to lock

1. **Where should “draft” autosave live when a profile is selected?**
   - A) disable autosave to `ab98:studio:layout` entirely when profile selected (simplest)
   - B) write draft per-profile key `ab98:studio:layout:<profileId>` (more complex, more convenient)

2. **Should server-side prefs be user-specific?**
   - Currently profiles are stored in a shared file; no user identity model exists.
   - If multi-user becomes a requirement, we may need:
     - per-user storage, or
     - namespace profiles by user, or
     - separate “workspace” concept.

3. **Pane instance scoping**
   - Current logs prefs are global.
   - If multiple logs panes are supported in the future, prefs may need to be keyed by pane id:
     - `prefs.logsByPaneId[paneId] = ...`

---

## Summary

This design makes layout profiles reproduce the entire Studio “experience” by storing optional global UI preferences alongside the layout tree. It preserves current behavior via fallbacks and avoids adding WebSocket-based persistence, keeping the system understandable and easy to restart from a single document.
