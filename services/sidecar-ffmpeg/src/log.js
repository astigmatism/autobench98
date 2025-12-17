// src/log.js
// Shared logging wrapper for the sidecar.
//
// - Uses @autobench98/logging (same as orchestrator)
// - Fans logs out to the orchestrator's /api/logs/ingest endpoint (fire-and-forget)
// - Exposes three channels: sidecar, ffmpeg, stream

const http = require('http');
const https = require('https');
const { URL } = require('url');

const { config } = require('./config');
const { createLogger, LogChannel } = require('@autobench98/logging');

// Base logger for this process
const { channel } = createLogger('sidecar');

// Remote log ingest configuration
let ingestModule = null; // http | https
let ingestBaseOptions = null;

(function initLogIngest() {
  if (!config.logIngestEnabled || !config.logIngestUrl) {
    return;
  }

  try {
    const url = new URL(config.logIngestUrl);
    const isHttps = url.protocol === 'https:';

    ingestModule = isHttps ? https : http;
    ingestBaseOptions = {
      hostname: url.hostname,
      port: url.port
        ? Number(url.port)
        : isHttps
        ? 443
        : 80,
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (config.logIngestToken) {
      ingestBaseOptions.headers.Authorization = `Bearer ${config.logIngestToken}`;
    }
  } catch (_err) {
    // Malformed URL → disable ingest silently
    ingestModule = null;
    ingestBaseOptions = null;
  }
})();

/**
 * Fire-and-forget HTTP POST to orchestrator's /api/logs/ingest.
 */
function sendLogToIngest(entry) {
  if (!ingestModule || !ingestBaseOptions) return;

  try {
    const payload = JSON.stringify(entry);
    const options = {
      ...ingestBaseOptions,
      headers: {
        ...ingestBaseOptions.headers,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = ingestModule.request(options, (res) => {
      // Drain response; we don't care about the body.
      res.on('data', () => {});
      res.on('end', () => {});
    });

    req.on('error', () => {
      // Best-effort only; never throw from logging.
    });

    req.write(payload);
    req.end();
  } catch {
    // Swallow — logging must not break the sidecar.
  }
}

/**
 * Wrap a channel logger so every call also fans out to /api/logs/ingest.
 */
function makeChannelWithIngest(channelId) {
  const baseLogger = channel(channelId);

  const wrap = (level) => (msg, extra) => {
    // Local stdout (pino + pretty + emoji)
    baseLogger[level](msg, extra);

    // Minimal remote entry – orchestrator's normalizeEntry fills emoji/color.
    sendLogToIngest({
      ts: Date.now(),
      level, // 'debug' | 'info' | 'warn' | 'error' | 'fatal'
      channel: channelId,
      message: msg,
    });
  };

  return {
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
    fatal: wrap('fatal'),
  };
}

const log = {
  sidecar: makeChannelWithIngest(LogChannel.sidecar),
  ffmpeg: makeChannelWithIngest(LogChannel.ffmpeg),
  stream: makeChannelWithIngest(LogChannel.stream),
};

module.exports = { log };
