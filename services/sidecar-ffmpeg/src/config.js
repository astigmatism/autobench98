// src/config.js
// Centralized configuration loader using dotenv
//
// IMPORTANT:
// - The macOS launcher already loads a root .env and sets SIDECAR_PORT, API_PORT, etc.
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

const config = {
  serviceName: 'sidecar-ffmpeg',

  host: envOrDefault('SIDECAR_HOST', '0.0.0.0'),
  port: Number(portFromEnv || '3100'),

  env: envOrDefault('NODE_ENV', 'development'),

  // Raw FFmpeg argument string, mirroring your existing orchestrator CaptureDevice.
  // Example (from your previous work, conceptually):
  //   FFMPEG_ARGS="-f v4l2 -input_format yuyv422 -framerate 30 -video_size 1280x720 -i /dev/video0 -f mjpeg -q:v 5"
  ffmpegArgs: envOrDefault('FFMPEG_ARGS', ''),

  // Optional: maximum number of concurrent /stream clients (0 or negative = unlimited)
  maxStreamClients: Number(envOrDefault('SIDECAR_MAX_STREAM_CLIENTS', '100')),
};

module.exports = {
  config,
  envOrDefault,
  envBool,
};
