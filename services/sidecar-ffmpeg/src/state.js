// src/state.js
// Centralized in-memory state for the sidecar.
//
// This captures high-level service and capture status that /health will expose.

const startedAt = Date.now();

const state = {
  service: {
    startedAt,
  },
  capture: {
    running: false,          // true when FFmpeg capture process is alive
    lastFrameTs: null,       // unix ms of last decoded frame
    lastError: null,         // string or error summary from the last failure
    restartCount: 0,         // how many times we've restarted capture
    // Optional metrics parsed from ffmpeg stderr:
    metrics: {
      frame: undefined,
      fps: undefined,
      quality: undefined,
      size: undefined,
      time: undefined,
      bitrate: undefined,
    },
  },
};

module.exports = {
  state,
};
