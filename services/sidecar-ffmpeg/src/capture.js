// src/capture.js
// FFmpeg-based capture pipeline that reads from the configured device using
// FFMPEG_ARGS (mirroring your existing CaptureDevice), produces MJPEG frames,
// and fans them out to connected HTTP clients as multipart/x-mixed-replace.
// Also maintains a lastFrame cache for optional screenshot support.

const { spawn } = require('child_process')
const { config } = require('./config')
const { state } = require('./state')
const { log } = require('./log')

// Boundary string mirroring your existing implementation.
// NOTE: In your TS code, boundary = '--frameboundary', header uses that value
// directly, and each part writes `--${boundary}`, which yields lines like
// "----frameboundary". We reproduce that behavior exactly here.
const BOUNDARY = '--frameboundary'

// Precompute part wrappers for efficiency (60fps MJPEG).
const PART_HEADER = `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\n\r\n`
const PART_FOOTER = '\r\n'
const PART_HEADER_BYTES = Buffer.byteLength(PART_HEADER)
const PART_FOOTER_BYTES = Buffer.byteLength(PART_FOOTER)

// Safety cap for the buffered stdout data before we've sliced frames.
// This comes from config, with a sensible default (8 MiB).
const MAX_BUFFER_BYTES =
  typeof config.maxCaptureBufferBytes === 'number' &&
  !Number.isNaN(config.maxCaptureBufferBytes)
    ? config.maxCaptureBufferBytes
    : 8 * 1024 * 1024

// Track connected MJPEG clients: Set<{ id, req, res, diag, stream }>
const streamClients = new Set()
let nextClientId = 1

// Buffer used to assemble JPEG frames from FFmpeg stdout
let frameBufferParts = []

// Reference to the current FFmpeg child process
let ffmpegProc = null

// Simple guard to avoid overlapping restart timers
let restartTimer = null

// JPEG markers
const START_MARKER = Buffer.from([0xff, 0xd8]) // SOI
const END_MARKER = Buffer.from([0xff, 0xd9]) // EOI

// --- Stream diagnostics (exposed via /health) --------------------------------
//
// Important: This cannot tell us "what the browser is currently displaying"
// (native <img> MJPEG does not expose that). But it DOES tell us whether the
// downstream connection is applying backpressure / building a write backlog.
const STREAM_DIAG = {
  // Frame sizing
  lastFrameBytes: 0,
  avgFrameBytes: null, // EWMA
  _ewmaAlpha: 0.05,

  // Backpressure / buffering
  backpressureEvents: 0,
  lastBackpressureTs: null,
  maxClientBufferedBytes: 0,
  maxClientBufferedRatio: 0, // bufferedBytes / writableHighWaterMark

  // Downstream throughput (bytes/sec) based on socket.bytesWritten deltas
  downstreamBps: null,
  downstreamBpsTs: null,

  // Derived estimate (VERY rough): bufferedBytes / downstreamBps
  estBacklogMs: null,

  // Last update time
  lastUpdateTs: null,
}

function ensureCaptureDiagObject() {
  // Attach to state so /health can surface it without extra module exports.
  if (!state.capture) state.capture = {}
  if (!state.capture.streamDiag) {
    state.capture.streamDiag = {
      clients: 0,
      lastFrameBytes: 0,
      avgFrameBytes: null,
      backpressureEvents: 0,
      lastBackpressureTs: null,
      maxClientBufferedBytes: 0,
      maxClientBufferedRatio: 0,
      downstreamBps: null,
      estBacklogMs: null,
      updatedAt: null,
    }
  }
  return state.capture.streamDiag
}

function normalizeMaxFps(maxFps) {
  const n = Number(maxFps)
  if (!Number.isFinite(n) || n <= 0) return null
  // Sidecar capture is typically 60fps; clamp to a sane range.
  return Math.max(1, Math.min(60, Math.floor(n)))
}

function minIntervalMsForMaxFps(maxFps) {
  if (!maxFps) return 0
  // e.g. 15fps => ~66.7ms
  return Math.max(0, Math.round(1000 / maxFps))
}

/**
 * Parse a single line of FFmpeg stderr to update capture metrics.
 * Mirrors the regex logic from your parseFFMPEGOutput method, but
 * stores it into state.capture.metrics instead of sending messages.
 */
function parseFfmpegOutputLine(line) {
  const frameRegex = /frame=\s*(\d+)/
  const fpsRegex = /fps=\s*([\d.]+)/
  const qualityRegex = /q=\s*([\d.]+)/
  const sizeRegex = /size=\s*([\d]+kB)/
  const timeRegex = /time=\s*([\d]{2}:[\d]{2}:[\d]{2}\.[\d]{2})/
  const bitrateRegex = /bitrate=\s*([\d.]+\skbits\/s)/

  const metrics = state.capture.metrics

  const frameMatch = line.match(frameRegex)
  if (frameMatch) metrics.frame = frameMatch[1]

  const fpsMatch = line.match(fpsRegex)
  if (fpsMatch) metrics.fps = fpsMatch[1]

  const qMatch = line.match(qualityRegex)
  if (qMatch) metrics.quality = qMatch[1]

  const sizeMatch = line.match(sizeRegex)
  if (sizeMatch) metrics.size = sizeMatch[1]

  const timeMatch = line.match(timeRegex)
  if (timeMatch) metrics.time = timeMatch[1]

  const bitrateMatch = line.match(bitrateRegex)
  if (bitrateMatch) metrics.bitrate = bitrateMatch[1]
}

/**
 * Update stream diagnostics based on a completed broadcast attempt.
 * This is designed to be cheap and safe at 60fps.
 */
function updateStreamDiag(now, frameBytes) {
  // EWMA for frame size
  STREAM_DIAG.lastFrameBytes = frameBytes
  if (STREAM_DIAG.avgFrameBytes == null) {
    STREAM_DIAG.avgFrameBytes = frameBytes
  } else {
    const a = STREAM_DIAG._ewmaAlpha
    STREAM_DIAG.avgFrameBytes = (1 - a) * STREAM_DIAG.avgFrameBytes + a * frameBytes
  }

  // Client buffering + throughput sampling
  let maxBuffered = 0
  let maxRatio = 0
  let minDownstreamBps = null

  for (const client of streamClients) {
    const res = client.res
    const wl = typeof res.writableLength === 'number' ? res.writableLength : 0
    const hwm =
      typeof res.writableHighWaterMark === 'number' && res.writableHighWaterMark > 0
        ? res.writableHighWaterMark
        : 0

    if (wl > maxBuffered) maxBuffered = wl
    if (hwm > 0) {
      const r = wl / hwm
      if (r > maxRatio) maxRatio = r
    }

    // Socket throughput (bytes/sec), updated ~1Hz per client.
    const sock = res && res.socket
    if (sock && typeof sock.bytesWritten === 'number') {
      if (!client.diag) {
        client.diag = {
          lastBytesWritten: sock.bytesWritten,
          lastBytesWrittenTs: now,
          bps: null,
        }
      } else if (
        typeof client.diag.lastBytesWritten === 'number' &&
        typeof client.diag.lastBytesWrittenTs === 'number'
      ) {
        const dt = now - client.diag.lastBytesWrittenTs
        if (dt >= 1000) {
          const delta = sock.bytesWritten - client.diag.lastBytesWritten
          const bps = dt > 0 ? Math.max(0, Math.round((delta * 1000) / dt)) : 0
          client.diag.bps = bps
          client.diag.lastBytesWritten = sock.bytesWritten
          client.diag.lastBytesWrittenTs = now

          if (minDownstreamBps == null || bps < minDownstreamBps) {
            minDownstreamBps = bps
          }
        } else if (client.diag.bps != null) {
          // Use last-known bps for min calculation if we haven't updated yet.
          const bps = client.diag.bps
          if (minDownstreamBps == null || bps < minDownstreamBps) {
            minDownstreamBps = bps
          }
        }
      }
    }
  }

  STREAM_DIAG.maxClientBufferedBytes = maxBuffered
  STREAM_DIAG.maxClientBufferedRatio = maxRatio

  // For your architecture, the sidecar usually has exactly one client: the orchestrator proxy.
  // We keep minDownstreamBps so multi-client scenarios show worst-case throughput.
  if (minDownstreamBps != null) {
    STREAM_DIAG.downstreamBps = minDownstreamBps
    STREAM_DIAG.downstreamBpsTs = now
  }

  // VERY rough estimate: how long of queued bytes exist in Node's write buffer
  // relative to observed downstream throughput.
  if (STREAM_DIAG.downstreamBps && STREAM_DIAG.downstreamBps > 0) {
    STREAM_DIAG.estBacklogMs = Math.round((maxBuffered / STREAM_DIAG.downstreamBps) * 1000)
  } else {
    STREAM_DIAG.estBacklogMs = null
  }

  STREAM_DIAG.lastUpdateTs = now

  // Mirror into state for /health.
  const out = ensureCaptureDiagObject()
  out.clients = streamClients.size
  out.lastFrameBytes = STREAM_DIAG.lastFrameBytes
  out.avgFrameBytes = STREAM_DIAG.avgFrameBytes != null ? Math.round(STREAM_DIAG.avgFrameBytes) : null
  out.backpressureEvents = STREAM_DIAG.backpressureEvents
  out.lastBackpressureTs = STREAM_DIAG.lastBackpressureTs
  out.maxClientBufferedBytes = STREAM_DIAG.maxClientBufferedBytes
  out.maxClientBufferedRatio = Number.isFinite(STREAM_DIAG.maxClientBufferedRatio)
    ? Number(STREAM_DIAG.maxClientBufferedRatio.toFixed(2))
    : 0
  out.downstreamBps = STREAM_DIAG.downstreamBps
  out.estBacklogMs = STREAM_DIAG.estBacklogMs
  out.updatedAt = new Date(now).toISOString()
}

function clientCanSendNow(client, now) {
  const minIntervalMs = client.stream && typeof client.stream.minIntervalMs === 'number'
    ? client.stream.minIntervalMs
    : 0

  if (!minIntervalMs || minIntervalMs <= 0) return true

  const lastSentTs =
    client.stream && typeof client.stream.lastSentTs === 'number'
      ? client.stream.lastSentTs
      : null

  if (lastSentTs == null) return true

  return now - lastSentTs >= minIntervalMs
}

function markClientPendingLatest(client) {
  // IMPORTANT: use state.capture.lastFrame (a dedicated Buffer copy)
  // rather than the sliced frameBuffer view, to avoid retaining a larger parent buffer.
  const lf = state.capture.lastFrame
  if (lf && Buffer.isBuffer(lf)) {
    client.stream.pendingFrame = lf
  }
}

function tryWritePartToClient(client, frameBuf, now) {
  const { res } = client
  if (res.writableEnded || res.destroyed) return false

  // Write a complete multipart part. If any write returns false,
  // the stream is applying backpressure and we must stop pushing frames
  // to prevent unbounded buffering / multi-second lag.
  let ok = true
  const ok1 = res.write(PART_HEADER)
  const ok2 = res.write(frameBuf)
  const ok3 = res.write(PART_FOOTER)
  ok = ok1 !== false && ok2 !== false && ok3 !== false

  client.stream.lastSentTs = now

  if (!ok) {
    STREAM_DIAG.backpressureEvents += 1
    STREAM_DIAG.lastBackpressureTs = now
    client.stream.backpressured = true
    // Keep only the latest pending frame while backpressured.
    markClientPendingLatest(client)
  }

  return ok
}

function onClientDrain(client) {
  // Socket buffer drained enough to accept more writes.
  // We send at most one "latest" frame and then rely on future broadcasts.
  if (!client || !client.stream) return
  if (client.res.writableEnded || client.res.destroyed) return

  client.stream.backpressured = false

  const now = Date.now()

  // If we have a pending "latest", try to send it (respecting maxFps).
  if (!clientCanSendNow(client, now)) {
    // Keep pending frame; next broadcast will overwrite or eventually send.
    return
  }

  const pending = client.stream.pendingFrame
  if (pending && Buffer.isBuffer(pending)) {
    client.stream.pendingFrame = null
    const ok = tryWritePartToClient(client, pending, now)
    if (!ok) {
      // Still backpressured; pending is already refreshed in tryWritePartToClient.
      return
    }
  }
}

/**
 * Broadcast a single JPEG frame buffer to all connected clients.
 *
 * We:
 * - Update lastFrame / lastFrameTs for screenshot support.
 * - Enforce per-client maxFps (drop frames server-side).
 * - Respect backpressure (no unbounded buffering; keep latest frame only).
 * - Only drop clients on actual errors or if their socket is closed.
 *
 * NOTE: We also record backpressure/buffering diagnostics.
 */
function broadcastFrame(frameBuffer) {
  const now = Date.now()
  state.capture.lastFrameTs = now

  // Cache the most recent frame for screenshot/lastFrame use.
  // This copy is also the safe source for per-client pending frames.
  state.capture.lastFrame = Buffer.from(frameBuffer)

  if (streamClients.size === 0) {
    // Still update diag so UI can tell "no clients" vs "clients but backpressured".
    const diag = ensureCaptureDiagObject()
    diag.clients = 0
    diag.updatedAt = new Date(now).toISOString()
    return
  }

  const frameBytes = frameBuffer.length
  void (PART_HEADER_BYTES + frameBytes + PART_FOOTER_BYTES) // informational only

  for (const client of Array.from(streamClients)) {
    const { res, id } = client
    if (res.writableEnded || res.destroyed) {
      streamClients.delete(client)
      continue
    }

    // Backpressured: do not write; retain only the latest pending frame.
    if (client.stream && client.stream.backpressured) {
      markClientPendingLatest(client)
      continue
    }

    // FPS throttling: if the client is ahead of its interval, don't write.
    // Keep only the latest pending frame (overwrite-only).
    if (!clientCanSendNow(client, now)) {
      markClientPendingLatest(client)
      continue
    }

    try {
      // Write the most recent frame.
      // If a client is not backpressured, we can write the current frameBuffer.
      // This is safe because we are not storing it; storing uses lastFrame copy.
      const ok = tryWritePartToClient(client, frameBuffer, now)
      if (!ok) {
        // Now marked backpressured inside tryWritePartToClient.
        continue
      }

      // If we successfully wrote and there was a pending frame (rare; usually overwritten),
      // clear it so we don’t send stale frames later.
      if (client.stream && client.stream.pendingFrame) {
        client.stream.pendingFrame = null
      }
    } catch (err) {
      const msg = String(err && err.message ? err.message : err)
      log.stream.warn(`Failed to write frame to client clientId=${id} error=${msg}`)
      try {
        res.end()
      } catch (_) {
        // ignore
      }
      streamClients.delete(client)
    }
  }

  // Update health-exposed diagnostics AFTER attempting writes.
  updateStreamDiag(now, frameBytes)
}

/**
 * Handle an incoming stdout chunk from FFmpeg and slice it into frames.
 * Mirrors your frameBuffer + START/END marker logic, with a safety cap
 * to prevent unbounded buffer growth.
 */
function handleStdoutChunk(chunk) {
  // Append the new chunk to the frame buffer
  frameBufferParts.push(chunk)

  // Convert to a single buffer for easier processing
  let bufferedData = Buffer.concat(frameBufferParts)

  // Safety: cap the maximum buffered size to avoid runaway memory usage
  if (bufferedData.length > MAX_BUFFER_BYTES) {
    log.ffmpeg.warn(
      `Buffered data exceeded cap; resetting buffer bufferedBytes=${bufferedData.length} maxBufferBytes=${MAX_BUFFER_BYTES}`
    )
    state.capture.lastError = `capture_buffer_overflow_${bufferedData.length}`
    bufferedData = Buffer.alloc(0)
  }

  while (true) {
    const start = bufferedData.indexOf(START_MARKER)
    if (start === -1) {
      break
    }

    const end = bufferedData.indexOf(END_MARKER, start + START_MARKER.length)
    if (end === -1) {
      break
    }

    // Extract frame (including end marker)
    const frame = bufferedData.slice(start, end + END_MARKER.length)

    // Broadcast to clients and update lastFrame
    broadcastFrame(frame)

    // Trim processed data
    bufferedData = bufferedData.slice(end + END_MARKER.length)
  }

  // Keep leftover data for next chunk
  frameBufferParts = [bufferedData]
}

/**
 * Schedule a restart of the FFmpeg capture process with a small backoff.
 */
function scheduleRestart(reason) {
  log.ffmpeg.warn(`Scheduling FFmpeg restart reason=${reason}`)
  if (restartTimer) {
    return // already scheduled
  }

  restartTimer = setTimeout(() => {
    restartTimer = null
    state.capture.restartCount += 1
    log.ffmpeg.info(`Restarting FFmpeg capture restartCount=${state.capture.restartCount}`)
    startCapture()
  }, 2000)
}

/**
 * Start the FFmpeg capture process if it isn't already running.
 * Uses FFMPEG_ARGS from config, appending "pipe:" exactly as in your TS code.
 */
function startCapture() {
  if (ffmpegProc && !ffmpegProc.killed) {
    return // already running
  }

  if (!config.ffmpegArgs || !config.ffmpegArgs.trim()) {
    const msg = 'FFMPEG_ARGS is not configured; capture cannot start.'
    log.sidecar.error(msg)
    state.capture.running = false
    state.capture.lastError = msg
    return
  }

  const args = config.ffmpegArgs.split(' ').filter(Boolean)
  args.push('pipe:')

  frameBufferParts = []
  state.capture.running = false
  state.capture.lastError = null
  state.capture.lastFrame = null
  state.capture.lastFrameTs = null

  // Ensure stream diag object exists immediately (so /health can show zeros).
  ensureCaptureDiagObject()

  log.ffmpeg.info(`Starting FFmpeg capture args="${args.join(' ')}"`)

  ffmpegProc = spawn('ffmpeg', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  ffmpegProc.stdout.on('data', (chunk) => {
    handleStdoutChunk(chunk)
  })

  ffmpegProc.stderr.on('data', (chunk) => {
    const line = chunk.toString()

    // Always parse for metrics so /health stays useful
    parseFfmpegOutputLine(line)

    // Only surface stderr when it looks like a problem; suppress frame/fps spam.
    const trimmed = line.trim()
    if (!trimmed) return

    if (/\b(error|fail|failed|invalid|no such file|permission denied|unable to)\b/i.test(trimmed)) {
      log.ffmpeg.error(trimmed)
    }
    // Otherwise, ignore normal progress lines entirely.
  })

  ffmpegProc.on('error', (err) => {
    const msg = `FFmpeg process error: ${err && err.message ? err.message : String(err)}`
    log.ffmpeg.error(msg)
    state.capture.running = false
    state.capture.lastError = msg
    ffmpegProc = null
    scheduleRestart('process_error')
  })

  ffmpegProc.on('close', (code, signal) => {
    const msg = `FFmpeg process exited with code=${code}, signal=${signal || 'null'}`
    log.ffmpeg.error(`FFmpeg process exited code=${code} signal=${signal || 'null'}`)
    state.capture.running = false
    state.capture.lastError = msg
    ffmpegProc = null
    scheduleRestart('process_exit')
  })

  state.capture.running = true
}

/**
 * Stop the FFmpeg capture process, if running.
 */
function stopCapture() {
  if (!ffmpegProc) return
  try {
    log.ffmpeg.info('Stopping FFmpeg capture')
    ffmpegProc.kill('SIGTERM')
  } catch (err) {
    const msg = String(err && err.message ? err.message : err)
    log.ffmpeg.error(`Error killing FFmpeg error=${msg}`)
  }
}

/**
 * Attach an HTTP response as an MJPEG stream client.
 * Mirrors your proxyRequest header/cleanup behavior, adapted from Node's
 * IncomingMessage/ServerResponse.
 *
 * Options:
 *   - maxFps: number | null (server-side throttling, drop frames to stay live)
 */
function addStreamClient(req, res, opts) {
  if (config.maxStreamClients > 0 && streamClients.size >= config.maxStreamClients) {
    log.stream.warn(
      `Maximum stream client limit reached; new connection closed maxClients=${config.maxStreamClients} currentClients=${streamClients.size}`
    )

    res.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'close',
    })
    res.end(
      JSON.stringify(
        {
          status: 'error',
          error: 'Too Many Clients',
          maxClients: config.maxStreamClients,
        },
        null,
        2
      )
    )
    return
  }

  // Set up the response headers for MJPEG streaming
  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    Pragma: 'no-cache',
  })

  const id = nextClientId++

  const maxFps = normalizeMaxFps(opts && opts.maxFps)
  const minIntervalMs = minIntervalMsForMaxFps(maxFps)

  const client = {
    id,
    req,
    res,
    diag: null,
    stream: {
      maxFps,
      minIntervalMs,
      lastSentTs: null,
      backpressured: false,
      pendingFrame: null, // latest only (Buffer)
    },
  }
  streamClients.add(client)

  // Initialize per-client diag baseline if available.
  try {
    const sock = res && res.socket
    if (sock && typeof sock.bytesWritten === 'number') {
      client.diag = {
        lastBytesWritten: sock.bytesWritten,
        lastBytesWrittenTs: Date.now(),
        bps: null,
      }
    }
  } catch (_) {
    // ignore
  }

  const remoteAddress = (req.socket && req.socket.remoteAddress) || 'unknown'

  log.stream.info(
    `New stream client connected clientId=${id} totalClients=${streamClients.size} remoteAddress=${remoteAddress} maxFps=${maxFps || 'unlimited'}`
  )

  const drainHandler = () => onClientDrain(client)

  const removeClient = () => {
    // Remove drain handler to avoid leaks.
    try {
      if (typeof res.removeListener === 'function') {
        res.removeListener('drain', drainHandler)
      }
    } catch (_) {
      // ignore
    }

    if (streamClients.delete(client)) {
      log.stream.info(
        `Stream client disconnected clientId=${id} totalClients=${streamClients.size}`
      )
    }
  }

  // Clean up on disconnect/error (req + res)
  req.on('close', removeClient)
  req.on('error', (_err) => {
    removeClient()
  })

  res.on('close', removeClient)
  res.on('error', (_err) => {
    removeClient()
  })

  // Backpressure recovery
  res.on('drain', drainHandler)

  // Disable timeouts to keep stream alive as long as needed
  if (typeof res.setTimeout === 'function') res.setTimeout(0)
  if (typeof req.setTimeout === 'function') req.setTimeout(0)

  // Ensure /health immediately reflects the client count
  const diag = ensureCaptureDiagObject()
  diag.clients = streamClients.size
  diag.updatedAt = new Date(Date.now()).toISOString()
}

module.exports = {
  startCapture,
  stopCapture,
  addStreamClient,
  BOUNDARY,
}
