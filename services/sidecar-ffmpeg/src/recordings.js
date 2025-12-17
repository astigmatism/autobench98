// src/recordings.js
// Recording management for the sidecar.
//
// Responsibilities:
// - Start a recording: spawn an FFmpeg process that reads from this sidecar's
//   own /stream endpoint and writes an MP4 file to the configured recordings root.
// - Stop a recording: stop the FFmpeg process cleanly.
// - Report status for each recording.
//
// Post-processing (segment merging, retiming, overlays) will be added later.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { config } = require('./config');
const { log } = require('./log');

// In-memory tracking of active and completed recordings.
// Map<string, RecordingState>
const recordings = new Map();

/**
 * @typedef {Object} RecordingState
 * @property {string} id                    // internal recording id (uuid)
 * @property {string|null} referenceId      // orchestrator-provided id (run id, benchmark id, etc.)
 * @property {string|null} label            // human-friendly label
 * @property {string} state                 // "idle" | "recording" | "stopping" | "completed" | "failed"
 * @property {string} dir                   // absolute directory path for this recording
 * @property {string} fileName              // file name only (e.g. run-123__20251216-192045.mp4)
 * @property {string} outputPath            // absolute path to the file
 * @property {string} relativePath          // path relative to recordingsRoot
 * @property {Date}   startedAt
 * @property {Date|null} stoppedAt
 * @property {number|null} durationMs       // computed when stopped
 * @property {string|null} error
 * @property {import('child_process').ChildProcessWithoutNullStreams | null} ffmpegProc
 */

/**
 * Ensure the recordings root directory exists and is writable.
 * This is a second line of defense; the launcher should also do this
 * for SIDECAR_RECORDINGS_ROOT so failures are caught early.
 */
function ensureRecordingsRoot() {
  const root = config.recordingsRoot;
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    log.sidecar.error(
      `Failed to create recordings root directory root=${root} error="${msg}"`
    );
    throw new Error(`Failed to create recordings root directory: ${root}`);
  }

  try {
    fs.accessSync(root, fs.constants.W_OK | fs.constants.R_OK);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    log.sidecar.error(
      `Recordings root is not readable/writable root=${root} error="${msg}"`
    );
    throw new Error(`Recordings root is not readable/writable: ${root}`);
  }
}

/**
 * Make a reasonably safe slug from an arbitrary string for use in
 * directory and file names (no path separators, normalized).
 */
function safeSlug(input, fallback) {
  const base = (input == null ? '' : String(input)).trim().toLowerCase();
  if (!base) return fallback;
  let slug = base
    .replace(/[^a-z0-9]+/gi, '-')   // non-alphanumeric -> dash
    .replace(/^-+|-+$/g, '');       // trim leading/trailing dashes
  if (!slug) slug = fallback;
  if (slug.length > 80) slug = slug.slice(0, 80);
  return slug;
}

/**
 * Format a timestamp suitable for filenames, e.g. 20251216-192045
 */
function formatTimestampForFilename(d) {
  const pad = (n) => (n < 10 ? `0${n}` : String(n));
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hour = pad(d.getHours());
  const min = pad(d.getMinutes());
  const sec = pad(d.getSeconds());
  return `${year}${month}${day}-${hour}${min}${sec}`;
}

/**
 * Count active recordings for concurrency limiting.
 * We treat both "recording" and "stopping" as active, because in "stopping"
 * the FFmpeg process may still be running and consuming resources.
 */
function getActiveRecordingCount() {
  let count = 0;
  for (const rec of recordings.values()) {
    if (rec.state === 'recording' || rec.state === 'stopping') {
      count += 1;
    }
  }
  return count;
}

/**
 * Create a new recording state object with paths and metadata.
 *
 * Options:
 * - referenceId: orchestrator-run ID or similar (preferred stable identifier)
 * - label:       human label
 * - subdir:      optional explicit subdirectory name under recordingsRoot
 */
function createRecordingState(options) {
  const id = randomUUID();
  const startedAt = new Date();

  const referenceId =
    options && options.referenceId ? String(options.referenceId) : null;

  // Decide a base name for directory + file based on:
  // 1. referenceId (if provided)
  // 2. subdir (if provided)
  // 3. recording id (fallback)
  const baseNameSource =
    (referenceId && referenceId.trim()) ||
    (options && options.subdir && String(options.subdir).trim()) ||
    id;

  const dirName = safeSlug(baseNameSource, id);
  const timestampPart = formatTimestampForFilename(startedAt);
  const fileName = `${dirName}__${timestampPart}.mp4`;

  const dir = path.resolve(config.recordingsRoot, dirName);
  const outputPath = path.join(dir, fileName);
  const relativePath = path.relative(config.recordingsRoot, outputPath);

  /** @type {RecordingState} */
  const rec = {
    id,
    referenceId,
    label: options && options.label ? String(options.label) : null,
    state: 'idle',
    dir,
    fileName,
    outputPath,
    relativePath,
    startedAt,
    stoppedAt: null,
    durationMs: null,
    error: null,
    ffmpegProc: null,
  };

  return rec;
}

/**
 * Serialize internal RecordingState to a JSON-safe object for API responses.
 */
function serializeRecording(rec) {
  const startedAtIso = rec.startedAt ? rec.startedAt.toISOString() : null;
  const stoppedAtIso = rec.stoppedAt ? rec.stoppedAt.toISOString() : null;

  let durationMs = rec.durationMs;
  if (durationMs == null && rec.startedAt && rec.stoppedAt) {
    durationMs = rec.stoppedAt.getTime() - rec.startedAt.getTime();
  }

  return {
    id: rec.id,
    referenceId: rec.referenceId,
    label: rec.label,
    state: rec.state,
    dir: rec.dir,
    fileName: rec.fileName,
    outputPath: rec.outputPath,
    relativePath: rec.relativePath,
    startedAt: startedAtIso,
    stoppedAt: stoppedAtIso,
    durationMs: durationMs,
    error: rec.error,
  };
}

/**
 * Start a new recording.
 *
 * - Ensures recordings root exists and is writable.
 * - Enforces a maximum number of concurrent recordings (config.maxRecordings).
 * - Creates a new directory (based on referenceId or id).
 * - Spawns FFmpeg that reads from this sidecar's own /stream endpoint and
 *   writes a single MP4 file.
 *
 * @param {{ label?: string, referenceId?: string, subdir?: string } | undefined} options
 * @returns {Promise<ReturnType<typeof serializeRecording>>}
 */
async function startRecording(options) {
  ensureRecordingsRoot();

  const max = config.maxRecordings;
  if (Number.isFinite(max) && max > 0) {
    const activeCount = getActiveRecordingCount();
    if (activeCount >= max) {
      const err = new Error(
        `Maximum concurrent recordings (${max}) reached (active=${activeCount}).`
      );
      // Custom error code so the HTTP layer can map this cleanly.
      // @ts-ignore
      err.code = 'EMAXREC';
      // @ts-ignore
      err.maxRecordings = max;
      throw err;
    }
  }

  const rec = createRecordingState(options);

  // Ensure the per-recording directory exists
  try {
    fs.mkdirSync(rec.dir, { recursive: true });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    log.sidecar.error(
      `Failed to create recording directory dir=${rec.dir} recordingId=${rec.id} error="${msg}"`
    );
    throw new Error(`Failed to create recording directory: ${rec.dir}`);
  }

  // Build FFmpeg command:
  //
  // Input: this sidecar's MJPEG /stream
  // Output: H.264 MP4 (libx264) with a reasonable quality preset.
  const inputUrl = `http://127.0.0.1:${config.port}/stream`;

  const ffmpegArgs = [
    '-y',
    '-f',
    'mjpeg',
    '-i',
    inputUrl,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    rec.outputPath,
  ];

  log.sidecar.info(
    `Starting recording recordingId=${rec.id} referenceId=${rec.referenceId ?? 'null'} outputPath=${rec.outputPath}`
  );
  log.ffmpeg.debug(
    `Recording FFmpeg args recordingId=${rec.id} args=${JSON.stringify(ffmpegArgs)}`
  );

  rec.state = 'recording';
  rec.error = null;
  rec.durationMs = null;

  const ffmpegProc = spawn('ffmpeg', ffmpegArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  rec.ffmpegProc = ffmpegProc;

  // Optional: log FFmpeg stderr for this recording, but avoid frame/fps spam.
  ffmpegProc.stderr.on('data', (chunk) => {
    const line = chunk.toString();
    const trimmed = line.trim();
    if (!trimmed) return;

    if (/\b(error|fail|failed|invalid|no such file|permission denied|unable to)\b/i.test(trimmed)) {
      log.ffmpeg.error(`recordingId=${rec.id} ${trimmed}`);
    }
    // otherwise, ignore the normal progress output
  });

  ffmpegProc.stdout.on('data', (_chunk) => {
    // We don't need stdout for this recording; it's writing to a file.
  });

  ffmpegProc.on('error', (err) => {
    const detail = String(err && err.message ? err.message : err);
    const msg = `Recording FFmpeg process error: ${detail}`;
    log.ffmpeg.error(`recordingId=${rec.id} ${msg}`);
    rec.state = 'failed';
    rec.error = msg;
    rec.stoppedAt = new Date();
    rec.durationMs =
      rec.startedAt && rec.stoppedAt
        ? rec.stoppedAt.getTime() - rec.startedAt.getTime()
        : null;
    rec.ffmpegProc = null;
  });

  ffmpegProc.on('close', (code, signal) => {
    const msg = `Recording FFmpeg exited code=${code} signal=${signal || 'null'}`;
    log.ffmpeg.info(
      `recordingId=${rec.id} referenceId=${rec.referenceId ?? 'null'} ${msg}`
    );
    rec.ffmpegProc = null;

    if (rec.state === 'stopping') {
      rec.state = 'completed';
      rec.error = null;
    } else if (rec.state === 'recording') {
      // Unexpected exit while we thought we were recording.
      rec.state = 'failed';
      rec.error = msg;
    }
    rec.stoppedAt = new Date();
    rec.durationMs =
      rec.startedAt && rec.stoppedAt
        ? rec.stoppedAt.getTime() - rec.startedAt.getTime()
        : null;
  });

  recordings.set(rec.id, rec);

  return serializeRecording(rec);
}

/**
 * Stop an existing recording by id.
 *
 * - Sends SIGINT to the FFmpeg process.
 * - Marks state as "stopping"; final state is resolved in the 'close' handler.
 *
 * @param {string} id
 * @returns {Promise<ReturnType<typeof serializeRecording>>}
 */
async function stopRecording(id) {
  const rec = recordings.get(id);
  if (!rec) {
    const err = new Error(`Recording not found: ${id}`);
    // @ts-ignore
    err.code = 'ENOENT';
    throw err;
  }

  if (rec.state !== 'recording' || !rec.ffmpegProc) {
    // Already stopping/completed/failed
    return serializeRecording(rec);
  }

  log.sidecar.info(
    `Stopping recording recordingId=${rec.id} referenceId=${rec.referenceId ?? 'null'}`
  );
  rec.state = 'stopping';

  try {
    rec.ffmpegProc.kill('SIGINT');
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    log.sidecar.error(
      `Error killing recording FFmpeg process recordingId=${rec.id} error="${msg}"`
    );
    rec.state = 'failed';
    rec.error = `Failed to stop recording: ${msg}`;
    rec.stoppedAt = new Date();
    rec.durationMs =
      rec.startedAt && rec.stoppedAt
        ? rec.stoppedAt.getTime() - rec.startedAt.getTime()
        : null;
    rec.ffmpegProc = null;
  }

  // We don't wait for process exit here; the 'close' handler updates final state.
  return serializeRecording(rec);
}

/**
 * Get status for a recording by id.
 *
 * @param {string} id
 * @returns {ReturnType<typeof serializeRecording> | null}
 */
function getRecordingStatus(id) {
  const rec = recordings.get(id);
  if (!rec) return null;
  return serializeRecording(rec);
}

/**
 * Clear the entire recordings root on disk and reset in-memory state.
 * Refuses to run if any recording is active (recording/stopping).
 */
async function clearAllRecordings() {
  ensureRecordingsRoot();

  const activeCount = getActiveRecordingCount();
  if (activeCount > 0) {
    const err = new Error(
      `Cannot clear recordings root while ${activeCount} recording(s) are active.`
    );
    // @ts-ignore
    err.code = 'EACTIVE';
    // @ts-ignore
    err.activeCount = activeCount;
    throw err;
  }

  const root = config.recordingsRoot;
  let deletedEntries = 0;

  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
        deletedEntries += 1;
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        log.sidecar.warn(
          `Failed to remove entry during recordings clear path=${fullPath} error="${msg}"`
        );
      }
    }
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    log.sidecar.error(
      `Failed to read recordings root during clear root=${root} error="${msg}"`
    );
    throw new Error(`Failed to clear recordings root: ${root}`);
  }

  recordings.clear();

  log.sidecar.info(
    `Cleared recordings root root=${root} deletedEntries=${deletedEntries}`
  );

  return {
    root,
    deletedEntries,
  };
}

module.exports = {
  startRecording,
  stopRecording,
  getRecordingStatus,
  clearAllRecordings,
};
