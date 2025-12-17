// src/log.js
//
// Minimal logging wrapper for the sidecar.
// Sends logs BOTH to stdout AND to the orchestrator's /api/logs/ingest,
// using the same channel names used by the orchestrator log system.
//
// Channels supported here:
//   - sidecar  (lifecycle + server behavior)
//   - stream   (client connections, screenshots, MJPEG events)
//   - ffmpeg   (ffmpeg start/stop/errors/metrics)

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { config } = require('./config');

// ---------------------------------------------------------------------------
// stdout logger — very simple, human readable
// ---------------------------------------------------------------------------
function stdoutLog(level, channel, msg) {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${ts}] [${channel}] [${level}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Orchestrator ingest setup
// ---------------------------------------------------------------------------
let ingestClient = null;

(function initIngest() {
  if (!config.logIngestEnabled || !config.logIngestUrl) {
    return; // disabled
  }

  try {
    const url = new URL(config.logIngestUrl);
    const isHttps = url.protocol === 'https:';

    ingestClient = {
      module: isHttps ? https : http,
      hostname: url.hostname,
      port: url.port
        ? Number(url.port)
        : isHttps
        ? 443
        : 80,
      path: url.pathname + (url.search || ''),
      token: config.logIngestToken || '',
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Invalid LOG_INGEST_URL:', config.logIngestUrl);
    ingestClient = null;
  }
})();

// ---------------------------------------------------------------------------
// Send a log entry to /api/logs/ingest
// Fire-and-forget, MUST NOT affect sidecar operation.
// ---------------------------------------------------------------------------
function sendToOrchestrator(level, channel, message) {
  if (!ingestClient) return;

  const entry = JSON.stringify({
    ts: Date.now(),
    level,
    channel,
    message,
  });

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(entry),
  };

  if (ingestClient.token) {
    headers.Authorization = `Bearer ${ingestClient.token}`;
  }

  const opts = {
    hostname: ingestClient.hostname,
    port: ingestClient.port,
    path: ingestClient.path,
    method: 'POST',
    headers,
  };

  try {
    const req = ingestClient.module.request(opts, (res) => {
      // Drain the response; we don't use it.
      res.on('data', () => {});
      res.on('end', () => {});
    });

    req.on('error', () => {
      /* swallow */
    });

    req.write(entry);
    req.end();
  } catch {
    /* swallow */
  }
}

// ---------------------------------------------------------------------------
// Logger factory for each channel
// ---------------------------------------------------------------------------
function makeChannelLogger(channel) {
  const wrap = (level) => (msg, extra) => {
    // Format message if extra object exists
    let finalMsg = msg;
    if (extra && typeof extra === 'object') {
      finalMsg = `${msg} ${JSON.stringify(extra)}`;
    }

    // Local stdout
    stdoutLog(level, channel, finalMsg);

    // Remote ingest
    sendToOrchestrator(level, channel, finalMsg);
  };

  return {
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
    fatal: wrap('fatal'),
  };
}

// ---------------------------------------------------------------------------
// Export loggers
// ---------------------------------------------------------------------------
module.exports = {
  log: {
    sidecar: makeChannelLogger('sidecar'),
    stream: makeChannelLogger('stream'),
    ffmpeg: makeChannelLogger('ffmpeg'),
  },
};
