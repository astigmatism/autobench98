#!/usr/bin/env bash
# macOS local launcher for sidecar + orchestrator with tidy shutdown (no watch)
set -euo pipefail

# --- helpers -----------------------------------------------------------------
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

log() { printf "\033[1;36m[autobench98]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[autobench98]\033[0m %s\n" "$*"; }
err() { printf "\033[1;31m[autobench98]\033[0m %s\n" "$*\n" >&2; }
die() { err "$1"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Missing '$1'. Please install it."; }

# Kill a whole process group (children too)
kill_tree() {
  local pid="${1:-}" name="${2:-proc}" grace="${3:-5}"
  [[ -z "$pid" ]] && return 0
  if ! kill -0 "$pid" 2>/dev/null; then return 0; fi

  local pgid target
  pgid="$(/bin/ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  target="$pid"
  [[ -n "${pgid:-}" ]] && target="-$pgid"

  kill -TERM "$target" 2>/dev/null || true

  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 0.2
    waited=$((waited+1))
    (( waited >= grace*5 )) && break
  done

  if kill -0 "$pid" 2>/dev/null; then
    log "Force killing ${name}..."
    kill -KILL "$target" 2>/dev/null || true
  fi
}

# --- sanity checks ------------------------------------------------------------
need node
need npm
need npx
command -v lsof >/dev/null 2>&1 || die "Missing 'lsof'. Install via 'brew install lsof'."

# --- optional .env loader (safe) ---------------------------------------------
if [[ -f .env ]]; then
  log "Loading .env"
  set -a
  sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' .env > .env.__clean
  # shellcheck disable=SC1091
  . ./.env.__clean
  rm -f .env.__clean
  set +a
else
  log "No .env found (that’s fine). Using defaults."
fi

# --- ensure CF imager scripts are executable (if configured) -----------------
if [[ -n "${CF_IMAGER_READ_SCRIPT:-}" || -n "${CF_IMAGER_WRITE_SCRIPT:-}" ]]; then
  log "Ensuring CF imager scripts are executable (macOS)"
  (
    cd services/orchestrator || exit 0

    if [[ -n "${CF_IMAGER_READ_SCRIPT:-}" ]]; then
      if [[ -f "$CF_IMAGER_READ_SCRIPT" ]]; then
        chmod +x "$CF_IMAGER_READ_SCRIPT" 2>/dev/null || \
          warn "Failed to chmod +x CF_IMAGER_READ_SCRIPT ($CF_IMAGER_READ_SCRIPT)"
      else
        warn "CF_IMAGER_READ_SCRIPT not found: $CF_IMAGER_READ_SCRIPT"
      fi
    fi

    if [[ -n "${CF_IMAGER_WRITE_SCRIPT:-}" ]]; then
      if [[ -f "$CF_IMAGER_WRITE_SCRIPT" ]]; then
        chmod +x "$CF_IMAGER_WRITE_SCRIPT" 2>/dev/null || \
          warn "Failed to chmod +x CF_IMAGER_WRITE_SCRIPT ($CF_IMAGER_WRITE_SCRIPT)"
      else
        warn "CF_IMAGER_WRITE_SCRIPT not found: $CF_IMAGER_WRITE_SCRIPT"
      fi
    fi
  )
fi

# --- ensure CF_IMAGER_ROOT exists and is writable ----------------------------
if [[ -n "${CF_IMAGER_ROOT:-}" ]]; then
  # Expand leading ~ to $HOME if present
  CF_ROOT="${CF_IMAGER_ROOT/#\~/$HOME}"
  log "CF_IMAGER_ROOT => ${CF_ROOT}"

  if [[ -e "$CF_ROOT" ]]; then
    if [[ ! -d "$CF_ROOT" ]]; then
      die "CF_IMAGER_ROOT exists but is not a directory: ${CF_ROOT}"
    fi
  else
    log "Creating CF_IMAGER_ROOT directory at ${CF_ROOT}"
    mkdir -p "$CF_ROOT" || die "Failed to create CF_IMAGER_ROOT directory: ${CF_ROOT}"
  fi

  # Ensure it is writable by the current user
  if [[ ! -w "$CF_ROOT" ]]; then
    warn "CF_IMAGER_ROOT is not writable by $(id -un). Attempting to adjust permissions..."
    chmod u+rwx "$CF_ROOT" 2>/dev/null || warn "Failed to chmod CF_IMAGER_ROOT (${CF_ROOT}); CF operations may fail with EACCES."
  fi
else
  warn "CF_IMAGER_ROOT is not set. CfImagerService will use its default root (if any)."
fi

# --- host-friendly defaults ---------------------------------------------------
: "${API_PORT:=3000}"
: "${SIDECAR_PORT:=3100}"
: "${DATA_DIR:=./data/orchestrator}"

# Reduce periodic device noise by default (override in .env if you want)
: "${SERIAL_SUMMARY_MS:=0}"

mkdir -p "$DATA_DIR"

log "DATA_DIR => $DATA_DIR"
log "Orchestrator => http://localhost:${API_PORT}"
log "Sidecar      => http://localhost:${SIDECAR_PORT}"

# --- build once (idempotent) --------------------------------------------------
log "Building shared logging package"
npm -w packages/logging run build

log "Building web app"
npm -w apps/web run build

# --- start services locally (no Docker, no watch) ----------------------------
SIDE_PID=""
ORCH_PID=""
STOPPING=0

graceful_shutdown() {
  (( STOPPING )) && return 0
  STOPPING=1
  log "Stopping services..."
  kill_tree "${ORCH_PID:-}" "orchestrator" 5
  kill_tree "${SIDE_PID:-}" "sidecar" 5
  log "All services stopped."
}

trap graceful_shutdown INT TERM

# Refuse to start if ports are already bound
if lsof -iTCP:"${SIDECAR_PORT}" -sTCP:LISTEN -nP >/dev/null 2>&1; then
  die "Port ${SIDECAR_PORT} already in use. Stop the existing process or change SIDECAR_PORT."
fi
if lsof -iTCP:"${API_PORT}" -sTCP:LISTEN -nP >/dev/null 2>&1; then
  die "Port ${API_PORT} already in use. Stop the existing process or change API_PORT."
fi

# Start sidecar (plain node, no watch)
log "Starting sidecar-ffmpeg (host)"
(
  cd services/sidecar-ffmpeg
  exec node src/server.js
) &
SIDE_PID=$!

sleep 0.2

# Start orchestrator (tsx execute, no watch)
log "Starting orchestrator (host)"
(
  cd services/orchestrator
  export DATA_DIR SERIAL_SUMMARY_MS
  exec npx tsx src/server.ts
) &
ORCH_PID=$!

log "Sidecar PID: ${SIDE_PID}"
log "Orchestrator PID: ${ORCH_PID}"
log "Press Ctrl-C to stop."

# Exit on the FIRST child exit, then tidy shutdown the other.
while :; do
  side_alive=0; orch_alive=0
  [[ -n "${SIDE_PID}" ]] && kill -0 "${SIDE_PID}" 2>/dev/null && side_alive=1
  [[ -n "${ORCH_PID}" ]] && kill -0 "${ORCH_PID}" 2>/dev/null && orch_alive=1
  total=$((side_alive + orch_alive))
  if (( total < 2 )); then
    break
  fi
  sleep 0.3
done

graceful_shutdown
exit 0