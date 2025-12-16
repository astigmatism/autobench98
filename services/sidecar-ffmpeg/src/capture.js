// src/capture.js
// FFmpeg-based capture pipeline that reads from the configured device using
// FFMPEG_ARGS (mirroring your existing CaptureDevice), produces MJPEG frames,
// and fans them out to connected HTTP clients as multipart/x-mixed-replace.
// Also maintains a lastFrame cache for optional screenshot support.

const { spawn } = require('child_process');
const { config } = require('./config');
const { state } = require('./state');

// Boundary string mirroring your existing implementation.
// NOTE: In your TS code, boundary = '--frameboundary', header uses that value
// directly, and each part writes `--${boundary}`, which yields lines like
// "----frameboundary". We reproduce that behavior exactly here.
const BOUNDARY = '--frameboundary';

// Safety cap for the buffered stdout data before we've sliced frames.
// This comes from config, with a sensible default (8 MiB).
const MAX_BUFFER_BYTES =
  typeof config.maxCaptureBufferBytes === 'number' &&
  !Number.isNaN(config.maxCaptureBufferBytes)
    ? config.maxCaptureBufferBytes
    : 8 * 1024 * 1024;

// Track connected MJPEG clients: Set<{ id, req, res }>
const streamClients = new Set();
let nextClientId = 1;

// Buffer used to assemble JPEG frames from FFmpeg stdout
let frameBufferParts = [];

// Reference to the current FFmpeg child process
let ffmpegProc = null;

// Simple guard to avoid overlapping restart timers
let restartTimer = null;

// JPEG markers
const START_MARKER = Buffer.from([0xff, 0xd8]); // SOI
const END_MARKER = Buffer.from([0xff, 0xd9]);   // EOI

/**
 * Parse a single line of FFmpeg stderr to update capture metrics.
 * Mirrors the regex logic from your parseFFMPEGOutput method, but
 * stores it into state.capture.metrics instead of sending messages.
 */
function parseFfmpegOutputLine(line) {
  const frameRegex = /frame=\s*(\d+)/;
  const fpsRegex = /fps=\s*([\d.]+)/;
  const qualityRegex = /q=\s*([\d.]+)/;
  const sizeRegex = /size=\s*([\d]+kB)/;
  const timeRegex = /time=\s*([\d]{2}:[\d]{2}:[\d]{2}\.[\d]{2})/;
  const bitrateRegex = /bitrate=\s*([\d.]+\skbits\/s)/;

  const metrics = state.capture.metrics;

  const frameMatch = line.match(frameRegex);
  if (frameMatch) metrics.frame = frameMatch[1];

  const fpsMatch = line.match(fpsRegex);
  if (fpsMatch) metrics.fps = fpsMatch[1];

  const qMatch = line.match(qualityRegex);
  if (qMatch) metrics.quality = qMatch[1];

  const sizeMatch = line.match(sizeRegex);
  if (sizeMatch) metrics.size = sizeMatch[1];

  const timeMatch = line.match(timeRegex);
  if (timeMatch) metrics.time = timeMatch[1];

  const bitrateMatch = line.match(bitrateRegex);
  if (bitrateMatch) metrics.bitrate = bitrateMatch[1];
}

/**
 * Broadcast a single JPEG frame buffer to all connected clients.
 *
 * We:
 * - Update lastFrame / lastFrameTs for screenshot support.
 * - Write the multipart chunk to each connected client.
 * - Only drop clients on actual errors or if their socket is closed.
 *
 * We deliberately DO NOT drop clients just because res.write() returns false;
 * for your expected client counts (a handful of viewers), Node and the OS
 * can handle backpressure without us aggressively killing connections.
 */
function broadcastFrame(frameBuffer) {
  const now = Date.now();
  state.capture.lastFrameTs = now;

  // Cache the most recent frame for screenshot/lastFrame use.
  state.capture.lastFrame = Buffer.from(frameBuffer);

  if (streamClients.size === 0) {
    return;
  }

  const header =
    `--${BOUNDARY}\r\n` +
    `Content-Type: image/jpeg\r\n\r\n`;
  const footer = '\r\n';

  for (const client of Array.from(streamClients)) {
    const { res, id } = client;
    if (res.writableEnded || res.destroyed) {
      streamClients.delete(client);
      continue;
    }

    try {
      res.write(header);
      res.write(frameBuffer);
      res.write(footer);
    } catch (err) {
      console.error(`[capture] Failed to write frame to client ${id}:`, err);
      try {
        res.end();
      } catch (_) {
        // ignore
      }
      streamClients.delete(client);
    }
  }
}

/**
 * Handle an incoming stdout chunk from FFmpeg and slice it into frames.
 * Mirrors your frameBuffer + START/END marker logic, with a safety cap
 * to prevent unbounded buffer growth.
 */
function handleStdoutChunk(chunk) {
  // Append the new chunk to the frame buffer
  frameBufferParts.push(chunk);

  // Convert to a single buffer for easier processing
  let bufferedData = Buffer.concat(frameBufferParts);

  // Safety: cap the maximum buffered size to avoid runaway memory usage
  if (bufferedData.length > MAX_BUFFER_BYTES) {
    console.warn(
      `[capture] Buffered data exceeded cap (${bufferedData.length} > ${MAX_BUFFER_BYTES}); resetting buffer`
    );
    state.capture.lastError = `capture_buffer_overflow_${bufferedData.length}`;
    bufferedData = Buffer.alloc(0);
  }

  while (true) {
    const start = bufferedData.indexOf(START_MARKER);
    if (start === -1) {
      break;
    }

    const end = bufferedData.indexOf(END_MARKER, start + START_MARKER.length);
    if (end === -1) {
      break;
    }

    // Extract frame (including end marker)
    const frame = bufferedData.slice(start, end + END_MARKER.length);

    // Broadcast to clients and update lastFrame
    broadcastFrame(frame);

    // Trim processed data
    bufferedData = bufferedData.slice(end + END_MARKER.length);
  }

  // Keep leftover data for next chunk
  frameBufferParts = [bufferedData];
}

/**
 * Schedule a restart of the FFmpeg capture process with a small backoff.
 */
function scheduleRestart(reason) {
  console.error('[capture] Scheduling FFmpeg restart:', reason);
  if (restartTimer) {
    return; // already scheduled
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    state.capture.restartCount += 1;
    startCapture();
  }, 2000);
}

/**
 * Start the FFmpeg capture process if it isn't already running.
 * Uses FFMPEG_ARGS from config, appending "pipe:" exactly as in your TS code.
 */
function startCapture() {
  if (ffmpegProc && !ffmpegProc.killed) {
    return; // already running
  }

  if (!config.ffmpegArgs || !config.ffmpegArgs.trim()) {
    const msg = 'FFMPEG_ARGS is not configured; capture cannot start.';
    console.error('[capture]', msg);
    state.capture.running = false;
    state.capture.lastError = msg;
    return;
  }

  const args = config.ffmpegArgs.split(' ').filter(Boolean);
  args.push('pipe:');

  console.log('[capture] Starting FFmpeg with args:', args.join(' '));

  frameBufferParts = [];
  state.capture.running = false;
  state.capture.lastError = null;
  state.capture.lastFrame = null;
  state.capture.lastFrameTs = null;

  ffmpegProc = spawn('ffmpeg', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  ffmpegProc.stdout.on('data', (chunk) => {
    handleStdoutChunk(chunk);
  });

  ffmpegProc.stderr.on('data', (chunk) => {
    const line = chunk.toString();
    process.stderr.write(`[ffmpeg] ${line}`);
    parseFfmpegOutputLine(line);
  });

  ffmpegProc.on('error', (err) => {
    const msg = `FFmpeg process error: ${err && err.message ? err.message : String(err)}`;
    console.error('[capture]', msg);
    state.capture.running = false;
    state.capture.lastError = msg;
    ffmpegProc = null;
    scheduleRestart('process_error');
  });

  ffmpegProc.on('close', (code, signal) => {
    const msg = `FFmpeg process exited with code=${code}, signal=${signal || 'null'}`;
    console.error('[capture]', msg);
    state.capture.running = false;
    state.capture.lastError = msg;
    ffmpegProc = null;
    scheduleRestart('process_exit');
  });

  state.capture.running = true;
}

/**
 * Stop the FFmpeg capture process, if running.
 */
function stopCapture() {
  if (!ffmpegProc) return;
  try {
    ffmpegProc.kill('SIGTERM');
  } catch (err) {
    console.error('[capture] Error killing FFmpeg:', err);
  }
}

/**
 * Attach an HTTP response as an MJPEG stream client.
 * Mirrors your proxyRequest header/cleanup behavior, adapted from Node's
 * IncomingMessage/ServerResponse.
 */
function addStreamClient(req, res) {
  if (config.maxStreamClients > 0 && streamClients.size >= config.maxStreamClients) {
    console.log('[capture] Maximum client limit reached, new connection closed.');
    res.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'close',
    });
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
    );
    return;
  }

  // Set up the response headers for MJPEG streaming
  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Pragma': 'no-cache',
  });

  const id = nextClientId++;
  console.log(
    `[capture] New stream client ${id} connected (total=${streamClients.size + 1})`
  );

  const client = { id, req, res };
  streamClients.add(client);

  const removeClient = () => {
    if (streamClients.delete(client)) {
      console.log(
        `[capture] Stream client ${id} disconnected (total=${streamClients.size})`
      );
    }
  };

  // Clean up on disconnect/error (req + res)
  req.on('close', removeClient);
  req.on('error', (_err) => {
    removeClient();
  });

  res.on('close', removeClient);
  res.on('error', (_err) => {
    removeClient();
  });

  // Disable timeouts to keep stream alive as long as needed
  if (typeof res.setTimeout === 'function') res.setTimeout(0);
  if (typeof req.setTimeout === 'function') req.setTimeout(0);
}

module.exports = {
  startCapture,
  stopCapture,
  addStreamClient,
  BOUNDARY,
};
