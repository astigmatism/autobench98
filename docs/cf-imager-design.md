# CompactFlash Imager Service & Pane Design

> **Status:** Draft  
> **Scope:** Orchestrator service + WebSocket integration + frontend pane + filesystem conventions for CompactFlash imaging via existing bash scripts on Linux.

---

## 1. Goals & Non-Goals

### 1.1 Goals

- Provide a **CompactFlash Imager Service** in the orchestrator that can:
  - Discover and track a single CompactFlash device (via existing USB discovery pipeline).
  - **Write** an image file from disk to the CF device.
  - **Read** (clone) the CF device into a new image file on disk.
- Integrate with the existing **WebSocket state mirroring** so the frontend can:
  - Display device connection & operation state.
  - Show live progress for read/write operations (parsed from shell script stdout).
  - Present a **file-browser-like UI** rooted at a configured images directory.
- Reuse existing **Linux bash scripts** (based on `dd` and friends) for actual imaging work.
- Enforce **safety & guardrails**:
  - Never touch system disks (rely on discovery to select only the CF reader device).
  - Avoid accidental overwwrites of image files without explicit confirmation.
  - Require confirmation before destructive operations (delete, overwrite).

### 1.2 Non-Goals

- Cross-platform support (macOS/Windows) — **Linux only** for now.
- Arbitrary filesystem browsing outside the configured images root.
- Supporting multiple CompactFlash devices simultaneously.
- Implementing HTTP/REST endpoints — integration happens **only via WebSocket state**, consistent with the rest of AutoBench98.
- Advanced imaging features like checksums, compression, or verification (these may be added later).

---

## 2. High-Level Architecture

### 2.1 Data Flow Overview

1. **USB Discovery (existing)** identifies the CF reader device and emits a device event into the orchestrator.
2. **CfImagerService** subscribes to these events and:
   - Tracks the current CF device (path, IDs).
   - Updates an internal state machine.
   - Exposes imperative methods to start **read** and **write** operations.
3. For image operations, **CfImagerService** spawns a **child process** running a bash script (read or write script):
   - For progress, it parses script stdout/stderr lines and translates them into structured progress events.
   - On completion or error, it updates its internal state accordingly.
4. **CfImagerStateAdapter** listens to service events and mirrors them into `AppState.cfImager`:
   - Device status (`connected`, `disconnected`).
   - Current operation (kind, progress, source/dest paths).
   - Filesystem state for the images root and current working directory.
   - Last error message(s).
5. The **WebSocket plugin** for state changes broadcasts JSON patches for `cfImager` to all connected clients.
6. The **frontend pane** subscribes to the mirrored `cfImager` slice and provides:
   - A basic file browser inside the configured root.
   - Actions for:
     - New folder
     - Rename file/folder
     - Delete file/folder
     - Write selected image to CF device
     - Read CF device to new image (prompt for name)
   - Modals / confirmations for destructive or overwriting actions.
   - A status area for in-progress operations and errors.

### 2.2 Modules & Responsibilities

- `CfImagerService`
  - Orchestrator-side service.
  - Tightly coupled to:
    - Existing USB discovery events.
    - Imaging shell scripts.
    - Filesystem operations under the images root.
- `CfImagerStateAdapter`
  - Pure adapter layer that translates service events into `AppState.cfImager` mutations.
- `cf-imager-logging` (within existing logging framework)
  - Uses a dedicated log channel (e.g. `cfimager`) for all backend behavior.
  - Emits logs into the shared client log buffer so progress and errors can be inspected from the generic log pane.
- `CfImagerPane` (frontend)
  - Pane component that renders file browser and controls based solely on the mirrored state.
  - Uses pane appearance APIs (bg, contrast helpers) and respects pane layout constraints.

---

## 3. Environment & Configuration

### 3.1 OS & Runtime Assumptions

- Host OS: **Linux** (e.g. Debian) only.
- Orchestrator: Node.js (Fastify-based backend) already running under a bash bootstrap script.
- Start script:
  - Reads `.env` file that is a sibling to the start script.
  - Can create required directories and adjust permissions before launching Node.

### 3.2 Environment Variables

Proposed key env vars, read by the orchestrator and/or start script:

- `CF_IMAGER_ROOT`  
  Absolute or `~`-expanded path to the root directory where image files and related metadata are stored.  
  Example: `CF_IMAGER_ROOT=~/autobench-images/cf`

- `CF_IMAGER_READ_SCRIPT`  
  Path to the bash script used to **read** (clone) the CF device to a new image file.

- `CF_IMAGER_WRITE_SCRIPT`  
  Path to the bash script used to **write** an existing image file to the CF device.

- `CF_IMAGER_LOG_LEVEL` (optional)  
  Overrides default logging level for this service (`debug`, `info`, `warn`, `error`).

The bootstrap script can:

1. Source `.env`.
2. Resolve and create `CF_IMAGER_ROOT` if it does not exist.
3. Ensure ownership and permissions allow the orchestrator user to read/write within this directory.

---

## 4. Device Discovery & Identification

### 4.1 Integration with Existing USB Discovery

- The project already has a **Serial/USB Discovery Service** that scans for devices and emits structured events.
- For this service, we assume:
  - The CF reader appears as a **block device** at a path like `/dev/sdX` or `/dev/disk/by-id/...`.
  - The discovery system can be extended (if not already) to mark it as a specific kind, e.g. `kind = 'block.cf'` or similar.

### 4.2 Device Selection Strategy

- There is effectively a **single active CF device** at a time.
- The CfImagerService will:

  - Listen for discovery events matching the configured CF reader identity.
  - Criteria can include:
    - USB Vendor ID / Product ID.
    - Serial number (if available).
  - Once a matching device is found, the service stores:
    - `deviceId` (from discovery)
    - `devicePath` (e.g. `/dev/sdX`)
    - Optional metadata like `vendor`, `product`, `serial`

- If the CF reader attribute details are not known ahead of time, we may initially key off:
  - A device kind emitted by the discovery service (e.g. `kind='block'` + manual configuration), and refine later once the real device is in hand.

### 4.3 Safety Guardrails

To avoid touching system disks:

- **Rule 1**: CfImagerService will operate **only** on devices that have been pre-classified by the discovery layer as "the CF reader".
- **Rule 2**: No direct device paths may be provided from the UI or config. The UI only sees `deviceId` or high-level state; actual `/dev/...` paths remain internal.
- **Rule 3**: If the CF device disappears (unplugged), the service will:
  - Cancel any in-progress operation (terminate the child process).
  - Emit an error and transition to a `disconnected` phase.
  - Let the state adapter update the UI appropriately.

---

## 5. Filesystem Layout & File Browser Behavior

### 5.1 Root Directory

- All browser-visible content is under `CF_IMAGER_ROOT`.
- The UI must *never* navigate above this root (no `..` beyond root).
- Nested folders under the root are allowed.

### 5.2 CF Image Files & Partials

- The existing read script is expected to produce:
  - A primary image file, e.g. `NAME.img`.
  - A secondary file, e.g. `NAME.part` (or similar), used as a partial / metadata / progress marker.
- The UI **only displays** the main `*.img` files in the listing, without their `.img` extensions (for a cleaner UX).
- When operations act on an image:
  - The service will transparently operate on both `NAME.img` and associated supporting files (e.g. `NAME.part`), performing renames and deletions together.

### 5.3 Allowed Operations

Within `CF_IMAGER_ROOT`:

- **Directories**
  - Create folder (under the current directory).
  - Delete folder (only if empty, or we choose to allow recursive delete — see TODO).
  - Rename folder.

- **Image Files (`*.img`)**
  - Rename image (also rename `.part` or other companions as needed).
  - Delete image + associated `.part`.
  - Select image as the **source** for a CF write operation.

All operations are exposed as methods on CfImagerService and mirrored in `AppState`.

### 5.4 Guardrails for FS Operations

- **No navigation outside root**:
  - Paths are always normalized and checked to ensure they remain descendents of `CF_IMAGER_ROOT`.
- **Overwrite handling**:
  - On image creation (read from CF) or rename, if the target name already exists:
    - The service emits a `would-overwrite` error, and no change occurs automatically.
    - The frontend is responsible for showing a confirmation modal. If the user confirms, the UI issues a follow-up command with an `overwrite: true` flag.
- **Deletion confirmation**:
  - The frontend should always show a confirmation modal before invoking `delete` on files or folders.

---

## 6. CfImagerService Design

### 6.1 Responsibilities

- Track device connection / disconnection.
- Expose safe, high-level operations:
  - `listDirectory(relativePath) -> CfImagerFsState`
  - `createFolder(relativePath, name)`
  - `renamePath(fromRelativePath, toRelativePath)`
  - `deletePath(relativePath)`
  - `writeImageToDevice(imageRelativePath)`
  - `readDeviceToImage(targetDirRelativePath, imageName, overwrite: boolean)`
- Manage an internal **operation state machine** for read/write tasks.
- Spawn and supervise the **child processes** executing bash scripts.
- Emit strongly-typed events to the CfImagerStateAdapter.
- Log to a dedicated logging channel.

### 6.2 State Machine (Backend)

Phases (internal):

- `disconnected`
- `idle`
- `reading`
- `writing`
- `error`

Transitions (simplified):

1. `disconnected` → `idle`  
   When the correct CF device is discovered and ready.

2. `idle` → `reading`  
   When `readDeviceToImage(...)` is called and parameters validated.

3. `idle` → `writing`  
   When `writeImageToDevice(...)` is called and parameters validated.

4. `reading` / `writing` → `idle`  
   On successful script completion.

5. `reading` / `writing` → `error`  
   On script failure, device disappearance, or unexpected termination.

6. `reading` / `writing` → `disconnected`  
   If device disappears and cannot be recovered.

7. `error` → `idle`  
   After receiving a reset/retry command (or when device state is stable again).

### 6.3 Child Process Handling

- Use `child_process.spawn` to invoke scripts with arguments:
  - Read script example args:
    - `--device /dev/sdX`
    - `--output /path/to/root/subdir/name.img`
  - Write script example args:
    - `--device /dev/sdX`
    - `--input /path/to/root/subdir/name.img`
- Stdout / stderr:
  - Listen to `data` events and interpret lines.
  - We expect the scripts to output progress in a parseable form (TBD once scripts are inspected).
  - Emit events such as `progress: { pct, bytesDone, bytesTotal }` whenever we parse an update.
- On `exit` / `close`:
  - Map exit code and signal into success/failure events.
- On cancellation (future extension):
  - Keep track of the `ChildProcess` instance.
  - Implement a `cancelCurrentOperation()` method that:
    - Sends `SIGINT` or `SIGTERM` to the process.
    - Transitions to an appropriate state (`error` or `idle` with a warning).

### 6.4 Error Handling

Typical errors:

- Device not connected.
- FS path invalid or outside root.
- Output file already exists and overwrite is not allowed.
- Script not found or not executable.
- Script returned non-zero exit code.

For each error, the service will:

- Emit a structured error event, with a human-readable message and an optional error code.
- Log the error via the logging channel with context (device path, operation kind, arguments).

---

## 7. State Adapter & AppState Shape

### 7.1 CfImagerStateAdapter

- Listens to events from CfImagerService:
  - `deviceConnected`
  - `deviceDisconnected`
  - `fsUpdated` (e.g. after directory read, folder creation, etc.)
  - `operationStarted`
  - `operationProgress`
  - `operationCompleted`
  - `operationError`
- Translates each event into `updateAppState` calls, modifying the `cfImager` slice.

### 7.2 AppState.cfImager Shape

Example shape (can be refined during implementation):

```ts
type CfImagerPhase = 'disconnected' | 'idle' | 'reading' | 'writing' | 'error'

interface CfImagerDeviceInfo {
  id: string
  path: string
  vendor?: string
  product?: string
  serial?: string
}

type CfImagerEntryKind = 'file' | 'dir'

interface CfImagerFsEntry {
  name: string            // display name, no extension for .img
  kind: CfImagerEntryKind
  sizeBytes?: number
  modifiedAt?: string     // ISO timestamp
}

interface CfImagerFsState {
  rootPath: string        // read-only; for debug display if desired
  cwd: string             // relative path from root, e.g. '.', 'subfolder'
  entries: CfImagerFsEntry[]
}

type CfImagerOpKind = 'read' | 'write'

interface CfImagerCurrentOp {
  kind: CfImagerOpKind
  source: string          // relative path of img or device id
  destination: string     // relative target path or created file name
  startedAt: string       // ISO timestamp
  progressPct: number     // 0–100
  bytesDone?: number
  bytesTotal?: number
  message?: string
}

interface CfImagerState {
  phase: CfImagerPhase
  message?: string
  device?: CfImagerDeviceInfo
  fs: CfImagerFsState
  currentOp?: CfImagerCurrentOp
  lastError?: string
}
```

- The frontend pane will consume this state via the mirrored AppState from the WebSocket connection.
- No direct knowledge of device paths or script paths is leaked to the UI.

---

## 8. Frontend Pane Design

### 8.1 Layout & UX

The CfImagerPane will roughly follow this layout:

1. **Header**
   - Title (e.g. "CompactFlash Imager").
   - Device status indicator:
     - `Disconnected`, `Idle`, `Reading`, `Writing`, `Error` (with appropriate colors based on pane bg and contrast helpers).
   - Optional device details (vendor/product/serial) if available.

2. **Path & Navigation Bar**
   - Shows current relative path from the images root (e.g. `/`, `/games/`, `/backups/`).
   - "Up" button to go to parent directory (unless already at root).

3. **File Browser Table/List**
   - Lists folders and `*.img` files (extension stripped in display).
   - Columns:
     - Name
     - Type (folder / image)
     - Size
     - Modified
   - Interactions:
     - Double-click folder → navigate into it.
     - Click to select a file (single selection).
     - Double-click image → optional convenience action (e.g. set as active image for writing).

4. **Action Bar (below browser)**
   - For directories:
     - `New Folder` → opens small modal to enter folder name.
   - For selected file/folder:
     - `Rename` → opens a rename modal.
     - `Delete` → opens a confirmation modal.
   - For CF imaging:
     - `Write Selected Image to CF` (enabled only when:
       - A file (image) is selected.
       - Service phase is `idle` and device is connected).
     - `Read CF to New Image`:
       - Opens a modal to enter the new image name (no extension; `.img` is implied).
       - Optionally choose a subfolder (uses current directory by default).

5. **Status / Progress Area**
   - Shows current operation info from `cfImager.currentOp`:
     - Text like `"Writing games/dos.img to CF..."`
     - Progress bar using `progressPct`.
   - When not active, shows last status message or a simple `"Idle"` indicator.
   - On `error` phase or `lastError`, displays a small inline error banner.

6. **Modals**
   - **Confirm Delete**: `"Are you sure you want to delete 'NAME'?"`.
   - **Confirm Overwrite**: `"A file named 'NAME.img' already exists. Overwrite?"`.
   - **Read Image Name Prompt**: input for new image name, validation for allowed characters and conflicts.

### 8.2 Interaction with Backend

The pane does not directly talk to the service; instead it sends high-level commands over the existing command channel used in AutoBench98 (pattern to match other panes). Command examples:

- `cfimager:list-dir` with `{ cwd }`
- `cfimager:create-folder` with `{ cwd, name }`
- `cfimager:rename` with `{ from, to }`
- `cfimager:delete` with `{ path, recursive?: boolean }`
- `cfimager:write-image` with `{ imagePath }`  // relative from root
- `cfimager:read-image` with `{ cwd, name, overwrite?: boolean }`

The backend plugin that handles commands will call CfImagerService methods and rely on CfImagerStateAdapter to propagate changes back into AppState and then out via WebSocket.

### 8.3 Validation & Name Rules

- Allowed characters:
  - For v1, we can allow most filenames but disallow `/` and `..` explicitly.
  - Optionally sanitize spaces (keep them) and weird characters, unless they cause issues in scripts.
- Automatically append `.img` extension when creating new images from the UI.
- Show inline validation error messages for invalid names or duplicates.

---

## 9. Logging & Observability

### 9.1 Logging Channel

- Define a dedicated channel, e.g. `LogChannel.cfimager`.
- All service logs go through this channel:
  - Device detection and changes.
  - Start/stop of read/write operations.
  - Script invocation details (sanitized; no sensitive paths beyond root).
  - Parsed progress updates (maybe rate-limited).
  - Error conditions and exceptions.

### 9.2 Client Log Buffer Integration

- Logs emitted on the `cfimager` channel are appended to the shared **client log buffer**.
- This allows users to open the existing log pane and see all CF imaging events alongside other system logs.

### 9.3 Metrics & Future Hooks

- Optionally, we could later add:
  - Counters for successful/failed operations.
  - Histograms for operation durations.
  - These can be integrated into any existing metrics system but are out of scope for v1.

---

## 10. Safety Considerations & Open Questions

### 10.1 Safety Highlights

- **Single active CF device**: service only operates on a validated device from the discovery system.
- **No free-form device paths** from the frontend.
- **Filesystem rooted** to `CF_IMAGER_ROOT`; no external path traversal.
- **Explicit confirmation** for delete and overwrite operations in the frontend.
- **One operation at a time** globally:
  - While an operation is active, the backend rejects new CF read/write commands.
  - The pane should disable buttons accordingly.

### 10.2 Open Questions / TBD Details

These items will be resolved once the existing scripts and actual CF reader are available:

1. **Exact script interfaces**:
   - Expected arguments and their semantics.
   - Requirements or assumptions about device paths and image paths.
2. **Progress output format**:
   - Which tool is used (`dd` with `status=progress`, `pv`, or something custom)?
   - How to robustly parse percentage or bytes from stdout/stderr.
3. **Partial file semantics**:
   - Exact naming convention and lifecycle of `.part` (or similar) files.
   - Whether they need special handling in error cases (e.g., cleanup on failure).
4. **Cancellation behavior**:
   - How `dd` responds to signals in the script’s context.
   - Whether we need an explicit “cleanup” routine after cancellation.

---

## 11. Implementation Plan (Incremental)

1. **Service Skeleton**
   - Create `CfImagerService` with basic state machine and event emitter interface.
   - Integrate logging channel.
   - Implement only device tracking and directory listing for now.

2. **State Adapter & AppState Slice**
   - Define `CfImagerState` types.
   - Implement `CfImagerStateAdapter` and wire it into the orchestrator state update system.
   - Verify that WebSocket mirroring correctly exposes the `cfImager` slice to clients.

3. **Frontend Pane Skeleton**
   - Add `CfImagerPane` with basic layout, path bar, and static table.
   - Wire it to the mirrored `cfImager` state.
   - Implement interactions for directory navigation and simple FS operations (create folder, delete, rename).

4. **Script Integration (Write & Read)**
   - Wire service methods to spawn read/write scripts.
   - Implement progress parsing based on real script output.
   - Update state and logs accordingly.

5. **Modals & Guardrails**
   - Implement overwrite and delete confirmation modals.
   - Add read-image name prompt modal and validation logic.
   - Enforce one active operation at a time.

6. **Polish & Edge Cases**
   - Handle device disconnects mid-operation.
   - Improve error messages and logging.
   - Optionally add quality-of-life improvements (auto-refresh directory listing after operations, etc.).

---

## 12. Summary

This design introduces a **CompactFlash Imager** service and pane that:

- Reuses existing Linux shell scripts for reliable disk imaging.
- Integrates naturally with the orchestrator’s event-driven architecture and WebSocket state mirroring.
- Provides a safe, restricted file browser rooted in a configurable images directory.
- Offers a clean UI for reading and writing CF images with progress and logging, while respecting the project’s logging and pane design conventions.

Once the actual bash scripts and CF reader details are available, we’ll refine the script interface section and progress parsing rules, but the high-level architecture and state flows described here should remain stable.
