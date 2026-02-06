// src/server.js
// HTTP server exposing:
// - /health          : JSON health status
// - /                : root info
// - /stream          : MJPEG video stream
// - /screenshot      : latest frame as JPEG
// - /recordings/*    : start/stop/status of recordings

const http = require('http')
const { URL } = require('url')
const os = require('os')

const { config } = require('./config')
const { state } = require('./state')
const { startCapture, addStreamClient } = require('./capture')
const {
  startRecording,
  stopRecording,
  getRecordingStatus,
  clearAllRecordings,
} = require('./recordings')

const { log } = require('./log')

const startedAt = state.service.startedAt

/* -------------------------------------------------------------------------- */
/*  Basic JSON response helper                                                */
/* -------------------------------------------------------------------------- */

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Compute service uptime in seconds.
 */
function getUptimeSec() {
  const uptimeMs = Date.now() - startedAt
  return Math.round(uptimeMs / 1000)
}

/**
 * Parse and normalize a maxFps query parameter.
 * - Accepts any finite number
 * - Clamps to 1..60
 * - Returns null when absent/invalid (meaning "unlimited" at the stream layer)
 */
function parseMaxFpsParam(url) {
  if (!url || !url.searchParams) return null

  const raw = url.searchParams.get('maxFps')
  if (raw == null || String(raw).trim() === '') return null

  const n = Number(raw)
  if (!Number.isFinite(n)) return null

  const i = Math.floor(n)
  if (i <= 0) return null

  return Math.max(1, Math.min(60, i))
}

/**
 * Determine high-level health status based on current state.
 *
 * We consider the service unhealthy if:
 * - FFMPEG_ARGS is missing/blank, OR
 * - The capture process is not running, OR
 * - We haven't seen a frame in > 5 seconds after we've ever seen one.
 */
function evaluateHealth() {
  const reasons = []

  if (!config.ffmpegArgs || !config.ffmpegArgs.trim()) {
    reasons.push('ffmpeg_args_missing')
  }

  if (!state.capture.running) {
    reasons.push('capture_not_running')
  } else {
    const now = Date.now()
    const lastFrameTs = state.capture.lastFrameTs
    if (lastFrameTs !== null && now - lastFrameTs > 5000) {
      reasons.push('no_recent_frames')
    }
  }

  const ok = reasons.length === 0

  return {
    ok,
    reasons,
  }
}

/**
 * Handles the /health endpoint.
 */
async function handleHealth(_req, res) {
  const { ok, reasons } = evaluateHealth()

  const now = Date.now()
  const lastFrameTs = state.capture.lastFrameTs
  const lastFrameAgeMs =
    typeof lastFrameTs === 'number' ? Math.max(0, now - lastFrameTs) : null

  const payload = {
    service: config.serviceName,
    status: ok ? 'ok' : 'unhealthy',
    timestamp: new Date(now).toISOString(),
    uptimeSec: getUptimeSec(),
    hostname: os.hostname(),
    env: {
      nodeEnv: config.env,
      port: config.port,
      host: config.host,
      ffmpegArgsConfigured: Boolean(config.ffmpegArgs && config.ffmpegArgs.trim()),
      maxStreamClients: config.maxStreamClients,
      recordingsRoot: config.recordingsRoot,
      maxRecordings: config.maxRecordings,
    },
    capture: {
      running: state.capture.running,
      lastFrameTs: state.capture.lastFrameTs,
      lastFrameAgeMs, // NEW: directly usable “capture freshness” number
      lastError: state.capture.lastError,
      restartCount: state.capture.restartCount,
      metrics: state.capture.metrics,
      hasLastFrame: Boolean(state.capture.lastFrame),

      // NEW: delivery pressure diagnostics (populated by capture.js instrumentation)
      streamDiag: state.capture.streamDiag || null,
    },
    reasons,
  }

  if (!ok) {
    // Single-line, key=value style
    log.sidecar.warn(
      `health check indicates unhealthy state reasons=${JSON.stringify(reasons)}`
    )
  }

  sendJson(res, ok ? 200 : 503, payload)
}

/**
 * Handle /stream MJPEG endpoint.
 *
 * Supports optional throttling:
 *   /stream?maxFps=<N>
 *
 * This does NOT change capture throughput; it only affects how frequently
 * frames are delivered to this specific downstream client connection.
 */
async function handleStream(req, res, url) {
  // Ensure the capture pipeline is running.
  startCapture()

  const maxFps = parseMaxFpsParam(url)

  // Attach this request/response as a stream client (with optional throttling).
  // NOTE: Extra args are safe even if addStreamClient currently only accepts (req, res).
  addStreamClient(req, res, { maxFps })
}

/**
 * Handle /screenshot endpoint.
 */
async function handleScreenshot(_req, res) {
  const frame = state.capture.lastFrame
  const ts = state.capture.lastFrameTs

  if (!frame || !Buffer.isBuffer(frame)) {
    return sendJson(res, 503, {
      status: 'error',
      error: 'NoScreenshotAvailable',
      message: 'No captured frame is currently available.',
    })
  }

  const now = Date.now()
  const ageMs = typeof ts === 'number' ? now - ts : null

  const headers = {
    'Content-Type': 'image/jpeg',
    'Content-Length': frame.length,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  }

  if (ageMs !== null) {
    headers['X-Frame-Age-Ms'] = String(ageMs)
  }

  res.writeHead(200, headers)
  res.end(frame)
}

/**
 * Utility to read a JSON body from a request (for POST endpoints).
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    const MAX_BODY_BYTES = 1024 * 1024 // 1 MiB cap

    req.on('data', (chunk) => {
      data += chunk.toString('utf8')
      if (Buffer.byteLength(data, 'utf8') > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
      }
    })

    req.on('end', () => {
      if (!data.trim()) {
        return resolve({})
      }
      try {
        const parsed = JSON.parse(data)
        resolve(parsed)
      } catch (_err) {
        reject(new Error('Invalid JSON body'))
      }
    })

    req.on('error', (err) => {
      reject(err)
    })
  })
}

/**
 * Handle POST /recordings/start
 *
 * Body fields we care about:
 * - referenceId | runId : stable id from orchestrator (used in dir/file naming)
 * - label               : human-friendly label (optional)
 * - subdir              : optional explicit subdir override (rarely needed)
 */
async function handleStartRecording(req, res) {
  let body
  try {
    body = await readJsonBody(req)
  } catch (err) {
    return sendJson(res, 400, {
      status: 'error',
      error: 'BadRequest',
      message: err.message || 'Failed to parse request body',
    })
  }

  const label =
    typeof body.label === 'string' && body.label.trim() ? body.label : undefined

  // Allow orchestrator to send either "referenceId" or "runId"
  const referenceIdRaw =
    (typeof body.referenceId === 'string' && body.referenceId.trim()
      ? body.referenceId
      : null) ||
    (typeof body.runId === 'string' && body.runId.trim() ? body.runId : null)

  const subdir =
    typeof body.subdir === 'string' && body.subdir.trim() ? body.subdir : undefined

  try {
    const rec = await startRecording({
      label,
      referenceId: referenceIdRaw || undefined,
      subdir,
    })
    return sendJson(res, 201, {
      status: 'ok',
      recording: rec,
    })
  } catch (err) {
    // Concurrency limit exceeded
    if (err && err.code === 'EMAXREC') {
      return sendJson(res, 429, {
        status: 'error',
        error: 'TooManyRecordings',
        message:
          err.message ||
          `Maximum concurrent recordings (${config.maxRecordings}) reached.`,
        maxRecordings: config.maxRecordings,
      })
    }

    return sendJson(res, 500, {
      status: 'error',
      error: 'RecordingStartFailed',
      message: err && err.message ? err.message : String(err),
    })
  }
}

/**
 * Handle POST /recordings/:id/stop
 */
async function handleStopRecording(_req, res, recordingId) {
  try {
    const rec = await stopRecording(recordingId)
    return sendJson(res, 200, {
      status: 'ok',
      recording: rec,
    })
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return sendJson(res, 404, {
        status: 'error',
        error: 'RecordingNotFound',
        message: `Recording not found: ${recordingId}`,
      })
    }
    return sendJson(res, 500, {
      status: 'error',
      error: 'RecordingStopFailed',
      message: err && err.message ? err.message : String(err),
    })
  }
}

/**
 * Handle GET /recordings/:id/status
 */
async function handleRecordingStatus(_req, res, recordingId) {
  const rec = getRecordingStatus(recordingId)
  if (!rec) {
    return sendJson(res, 404, {
      status: 'error',
      error: 'RecordingNotFound',
      message: `Recording not found: ${recordingId}`,
    })
  }

  return sendJson(res, 200, {
    status: 'ok',
    recording: rec,
  })
}

/**
 * POST /recordings/clear
 * Clears all files/directories under recordingsRoot.
 * Fails with 409 if any recording is currently active.
 */
async function handleClearRecordings(_req, res) {
  try {
    const result = await clearAllRecordings()
    return sendJson(res, 200, {
      status: 'ok',
      root: result.root,
      deletedEntries: result.deletedEntries,
    })
  } catch (err) {
    if (err && err.code === 'EACTIVE') {
      return sendJson(res, 409, {
        status: 'error',
        error: 'ActiveRecordingsPresent',
        message:
          err.message ||
          'Cannot clear recordings while one or more recordings are active.',
      })
    }

    return sendJson(res, 500, {
      status: 'error',
      error: 'RecordingClearFailed',
      message: err && err.message ? err.message : String(err),
    })
  }
}

/**
 * Request router.
 */
async function requestListener(req, res) {
  let url
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  } catch (_err) {
    return sendJson(res, 400, {
      status: 'error',
      error: 'BadRequest',
      message: 'Malformed URL',
    })
  }

  const { pathname } = url

  // Health
  if (req.method === 'GET' && pathname === '/health') {
    return handleHealth(req, res)
  }

  // Stream
  if (req.method === 'GET' && pathname === '/stream') {
    return handleStream(req, res, url)
  }

  // Screenshot
  if (req.method === 'GET' && pathname === '/screenshot') {
    return handleScreenshot(req, res)
  }

  // Recordings
  if (pathname === '/recordings/start' && req.method === 'POST') {
    return handleStartRecording(req, res)
  }

  if (pathname === '/recordings/clear' && req.method === 'POST') {
    return handleClearRecordings(req, res)
  }

  if (pathname.startsWith('/recordings/') && pathname !== '/recordings/start') {
    const parts = pathname.split('/').filter(Boolean) // e.g. ["recordings", "<id>", "stop"|"status"]
    if (parts.length === 3 && parts[0] === 'recordings') {
      const recordingId = parts[1]
      const action = parts[2]

      if (action === 'stop' && req.method === 'POST') {
        return handleStopRecording(req, res, recordingId)
      }

      if (action === 'status' && req.method === 'GET') {
        return handleRecordingStatus(req, res, recordingId)
      }
    }
  }

  // Root
  if (req.method === 'GET' && pathname === '/') {
    return sendJson(res, 200, {
      service: config.serviceName,
      status: 'ok',
      message: 'sidecar-ffmpeg service',
      endpoints: [
        '/health',
        '/stream',
        '/stream?maxFps=15',
        '/screenshot',
        '/recordings/start',
        '/recordings/clear',
        '/recordings/:id/stop',
        '/recordings/:id/status',
      ],
    })
  }

  // Fallback 404
  sendJson(res, 404, {
    status: 'error',
    error: 'NotFound',
    path: pathname,
  })
}

// Create and start the HTTP server
const server = http.createServer((req, res) => {
  // Wrap in a catch-all in case async handlers throw
  Promise.resolve(requestListener(req, res)).catch((err) => {
    const msg = String(err && err.message ? err.message : err)
    log.sidecar.error(`Unexpected error while handling request error="${msg}"`)
    if (!res.headersSent) {
      sendJson(res, 500, {
        status: 'error',
        error: 'InternalServerError',
      })
    } else {
      res.destroy()
    }
  })
})

server.listen(config.port, config.host, () => {
  const enabled = !!(config.logIngestEnabled && config.logIngestUrl)
  const ingestUrl = enabled ? config.logIngestUrl : 'disabled'
  log.sidecar.info(
    `sidecar listening host=${config.host} port=${config.port} env=${config.env} logIngestEnabled=${enabled} logIngestUrl=${ingestUrl}`
  )
})
