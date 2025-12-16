// src/server.js
// HTTP server exposing /health, / (root), and /stream for MJPEG video.

const http = require('http');
const { URL } = require('url');
const os = require('os');
const { config } = require('./config');
const { state } = require('./state');
const { startCapture, addStreamClient } = require('./capture');

const startedAt = state.service.startedAt;

/**
 * Basic JSON response helper
 */
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Compute service uptime in seconds.
 */
function getUptimeSec() {
  const uptimeMs = Date.now() - startedAt;
  return Math.round(uptimeMs / 1000);
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
  const reasons = [];

  if (!config.ffmpegArgs || !config.ffmpegArgs.trim()) {
    reasons.push('ffmpeg_args_missing');
  }

  if (!state.capture.running) {
    reasons.push('capture_not_running');
  } else {
    const now = Date.now();
    const lastFrameTs = state.capture.lastFrameTs;
    if (lastFrameTs !== null && now - lastFrameTs > 5000) {
      reasons.push('no_recent_frames');
    }
  }

  const ok = reasons.length === 0;

  return {
    ok,
    reasons,
  };
}

/**
 * Handles the /health endpoint.
 */
async function handleHealth(_req, res) {
  const { ok, reasons } = evaluateHealth();

  const payload = {
    service: config.serviceName,
    status: ok ? 'ok' : 'unhealthy',
    timestamp: new Date().toISOString(),
    uptimeSec: getUptimeSec(),
    hostname: os.hostname(),
    env: {
      nodeEnv: config.env,
      port: config.port,
      host: config.host,
      ffmpegArgsConfigured: Boolean(config.ffmpegArgs && config.ffmpegArgs.trim()),
      maxStreamClients: config.maxStreamClients,
    },
    capture: {
      running: state.capture.running,
      lastFrameTs: state.capture.lastFrameTs,
      lastError: state.capture.lastError,
      restartCount: state.capture.restartCount,
      metrics: state.capture.metrics,
    },
    reasons,
  };

  sendJson(res, ok ? 200 : 503, payload);
}

/**
 * Handle /stream MJPEG endpoint.
 */
async function handleStream(req, res) {
  // Ensure the capture pipeline is running.
  startCapture();

  // Attach this request/response as a stream client.
  addStreamClient(req, res);
}

/**
 * Request router.
 */
async function requestListener(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_err) {
    return sendJson(res, 400, {
      status: 'error',
      error: 'Bad Request',
      message: 'Malformed URL',
    });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return handleHealth(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/stream') {
    return handleStream(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return sendJson(res, 200, {
      service: config.serviceName,
      status: 'ok',
      message: 'sidecar-ffmpeg service',
      endpoints: ['/health', '/stream'],
    });
  }

  // Fallback 404
  sendJson(res, 404, {
    status: 'error',
    error: 'Not Found',
    path: url.pathname,
  });
}

// Create and start the HTTP server
const server = http.createServer((req, res) => {
  // Wrap in a catch-all in case async handlers throw
  Promise.resolve(requestListener(req, res)).catch((err) => {
    console.error('Unexpected error while handling request:', err);
    if (!res.headersSent) {
      sendJson(res, 500, {
        status: 'error',
        error: 'Internal Server Error',
      });
    } else {
      res.destroy();
    }
  });
});

server.listen(config.port, config.host, () => {
  console.log(
    `[${config.serviceName}] Listening on http://${config.host}:${config.port} (env=${config.env})`
  );
});
