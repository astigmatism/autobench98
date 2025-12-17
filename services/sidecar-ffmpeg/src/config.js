// src/config.js
// Centralized configuration loader using dotenv
//
// IMPORTANT:
// - The macOS and Linux launchers already load a root .env and set SIDECAR_PORT, API_PORT, etc.
// - We just consume those values here.
// - When running the sidecar directly (node src/server.js), we also load the same root .env
//   so you still only maintain a single .env file at the repo root.

const path = require('path');
const dotenv = require('dotenv');

// Load .env from the repo root (next to the launcher script).
dotenv.config({
  path: path.resolve(__dirname, '..', '..', '.env'),
});

/**
 * Helper to read an env var with a default.
 */
function envOrDefault(name, defaultValue) {
  const value = process.env[name];
  return value !== undefined && value !== '' ? value : defaultValue;
}

/**
 * Helper to read a boolean env var.
 * Accepts: "1", "true", "yes", "on" (case-insensitive) as true.
 */
function envBool(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

// Port selection:
// - Primary source: process.env.SIDECAR_PORT (set by the launcher or root .env).
// - Fallback: 3100 (matches the launch script’s default).
const portFromEnv = process.env.SIDECAR_PORT;

// Default cap for buffered FFmpeg stdout data (in bytes).
// This is a safety mechanism to avoid unbounded growth if frames
// are malformed or markers are missing.
const defaultMaxCaptureBufferBytes = 8 * 1024 * 1024; // 8 MiB

// Default recordings root: <repo>/data/sidecar-recordings
const defaultRecordingsRoot = path.resolve(
  __dirname,
  '..',
  '..',
  'data',
  'sidecar-recordings'
);

// Orchestrator API port (used for log ingest default).
const defaultApiPort = envOrDefault('API_PORT', '3000');

const config = {
  serviceName: 'sidecar-ffmpeg',

  host: envOrDefault('SIDECAR_HOST', '0.0.0.0'),
  port: Number(portFromEnv || '3100'),

  env: envOrDefault('NODE_ENV', 'development'),

  // Raw FFmpeg argument string, mirroring your existing CaptureDevice behavior.
  // Example:
  //   FFMPEG_ARGS='-f v4l2 -framerate 60 -input_format nv12 -video_size 1280x1024 -i /dev/video0 -c:v mjpeg -b:v 10M -threads auto -f mjpeg'
  ffmpegArgs: envOrDefault('FFMPEG_ARGS', ''),

  // Maximum number of concurrent /stream clients (0 or negative = unlimited).
  maxStreamClients: Number(envOrDefault('SIDECAR_MAX_STREAM_CLIENTS', '100')),

  // Safety cap on the amount of buffered stdout data from FFmpeg (bytes).
  // If exceeded without finding a full frame, the buffer is reset and a warning logged.
  maxCaptureBufferBytes: Number(
    envOrDefault(
      'SIDECAR_MAX_CAPTURE_BUFFER_BYTES',
      String(defaultMaxCaptureBufferBytes)
    )
  ),

  // Root directory where recording files will be written.
  // This should be on a readable/writable filesystem.
  recordingsRoot: path.resolve(
    envOrDefault('SIDECAR_RECORDINGS_ROOT', defaultRecordingsRoot)
  ),

  // Maximum number of concurrent recording FFmpeg processes.
  // Default is 2, but can be raised via SIDECAR_MAX_RECORDINGS if the host can handle more.
  maxRecordings: Number(envOrDefault('SIDECAR_MAX_RECORDINGS', '2')),

  // Orchestrator log ingest wiring:
  //
  // By default, we assume the orchestrator is listening on 127.0.0.1:API_PORT
  // and exposing POST /api/logs/ingest (as in apps/orchestrator/src/app.ts).
  //
  // You can override the URL entirely via LOG_INGEST_URL if needed.
  logIngestEnabled: envBool('LOG_INGEST_ENABLED', true),
  logIngestUrl: envOrDefault(
    'LOG_INGEST_URL',
    `http://127.0.0.1:${defaultApiPort}/api/logs/ingest`
  ),
  // Token must match orchestrator's LOG_INGEST_TOKEN to be accepted (if set there).
  logIngestToken: envOrDefault('LOG_INGEST_TOKEN', ''),
};

module.exports = {
  config,
  envOrDefault,
  envBool,
};
