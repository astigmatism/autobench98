// src/log.js
// Shared logging wrapper for the sidecar.
//
// - Uses @autobench98/logging (same as orchestrator)
// - Fans logs out to the orchestrator's /api/logs/ingest endpoint (fire-and-forget)
// - Exposes three channels: sidecar, ffmpeg, stream
// - Forces all logs to be single-line key=value style by disallowing metadata objects.

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
      port: url.port ? Number(url.port) : isHttps ? 443 : 80,
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (config.logIngestToken) {
      ingestBaseOptions.headers.Authorization = `Bearer ${config.logIngestToken}`;
    }
  } catch {
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
      // Drain response; we do not read body
      res.on('data', () => {});
      res.on('end', () => {});
    });

    req.on('error', () => {
      // Best-effort only
    });

    req.write(payload);
    req.end();
  } catch {
    // Never throw from logging
  }
}

/**
 * Wrap a channel logger so every call:
 *   - ALWAYS logs a single string message (no objects)
 *   - Fan-outs to /api/logs/ingest
 *
 * This guarantees pino-pretty never emits multi-line logs.
 */
function makeChannelWithIngest(channelId) {
  const baseLogger = channel(channelId);

  const wrap = (level) => (msg) => {
    // Force type to string
    const text = typeof msg === 'string' ? msg : String(msg);

    // Local stdout via pino-pretty
    baseLogger[level](text);

    // Remote ingest
    sendLogToIngest({
      ts: Date.now(),
      level,        // "info" | "warn" | ...
      channel: channelId,
      message: text,
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
