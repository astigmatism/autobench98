#!/usr/bin/env bash
set -euo pipefail

# read-image-macos.sh
#
# Usage:
#   read-image-macos.sh <DEVICE_PATH> <DEST_IMG_PATH> [PART_TABLE_PATH]
#
# Stdout protocol (for Node/CfImagerService to consume):
#   CAPACITY bytes=<totalBytes>
#   BEGIN_READ source=<partition> dest=<dest-img-path>
#   DD_STATUS <raw dd status line>
#   PROGRESS bytes=<n> total=<totalBytes> pct=<pct> rate=<bps> elapsed=<secs>
#   ...
#   READ_COMPLETE dest=<dest-img-path>
#
# Stderr:
#   Human-oriented logs, including any error explanation.

log() { printf '[cf-read-macos] %s\n' "$*" >&2; }

if [[ $# -lt 2 ]]; then
  log "Usage: $0 <DEVICE_PATH> <DEST_IMG_PATH> [PART_TABLE_PATH]"
  exit 1
fi

DEVICE="$1"
DEST_IMG="$2"
PART_TABLE="${3:-}"

if [[ -z "$PART_TABLE" ]]; then
  PART_TABLE="${DEST_IMG%.img}.part"
fi

if [[ ! -e "$DEVICE" ]]; then
  log "ERROR: DEVICE_PATH '$DEVICE' does not exist"
  exit 1
fi

DEST_DIR="$(dirname "$DEST_IMG")"
if [[ ! -d "$DEST_DIR" ]]; then
  log "ERROR: destination directory '$DEST_DIR' does not exist"
  exit 1
fi

if ! command -v diskutil >/dev/null 2>&1; then
  log "ERROR: diskutil is required on macOS"
  exit 1
fi

if ! command -v plutil >/dev/null 2>&1; then
  log "ERROR: plutil is required on macOS"
  exit 1
fi

# ---------------------------------------------------------------------------
# Determine what to image: either DEVICE (if it's already a slice),
# or first slice derived from diskutil if DEVICE is a whole disk.
# ---------------------------------------------------------------------------

PARTITION="$DEVICE"

if [[ "$DEVICE" =~ ^/dev/disk[0-9]+s[0-9]+$ ]]; then
  log "Using DEVICE as partition: $PARTITION"
else
  disk_id="${DEVICE#/dev/}"

  PARTITION="$(
    diskutil list "$DEVICE" 2>/dev/null \
    | awk -v did="$disk_id" '
        # Lines like: "   2:   FDisk_partition_scheme   *63.9 GB   disk4s1"
        /disk[0-9]+s[0-9]+$/ {
          part = $NF
          if (part ~ "^" did "s[0-9]+$") {
            print "/dev/" part
            exit
          }
        }
      '
  )"

  if [[ -z "$PARTITION" ]]; then
    log "ERROR: no partition slice found on '$DEVICE'"
    exit 1
  fi

  log "Using first slice '"$PARTITION"' on device '"$DEVICE"'"
fi

# ---------------------------------------------------------------------------
# Determine total capacity (bytes) for the partition using diskutil + plutil
# ---------------------------------------------------------------------------

get_partition_size_bytes() {
  local dev="$1"
  local json size

  # Get JSON plist from diskutil
  if ! json="$(diskutil info -plist "$dev" 2>/dev/null | plutil -convert json -r -o - - 2>/dev/null)"; then
    echo "0"
    return
  fi

  # Try TotalSize first
  size="$(printf '%s\n' "$json" | awk -F: '/"TotalSize"/ { gsub(/[^0-9]/,"",$2); print $2; exit }')"
  if [[ -z "$size" ]]; then
    # Fallback to Size (older layouts)
    size="$(printf '%s\n' "$json" | awk -F: '/"Size"/ { gsub(/[^0-9]/,"",$2); print $2; exit }')"
  fi

  if [[ -z "$size" ]]; then
    echo "0"
  else
    echo "$size"
  fi
}

TOTAL_BYTES="$(get_partition_size_bytes "$PARTITION")"
if [[ "$TOTAL_BYTES" =~ ^[0-9]+$ ]] && [[ "$TOTAL_BYTES" -gt 0 ]]; then
  :
else
  TOTAL_BYTES=0
fi

# Emit capacity FIRST so the consumer can capture it before progress lines.
echo "CAPACITY bytes=${TOTAL_BYTES}"

# ---------------------------------------------------------------------------
# Announce read beginning
# ---------------------------------------------------------------------------

echo "BEGIN_READ source=${PARTITION} dest=${DEST_IMG}"

# ---------------------------------------------------------------------------
# Unmount disk so dd doesn't hit 'Resource busy'
# ---------------------------------------------------------------------------

disk_for_unmount="${PARTITION#/dev/}"
disk_for_unmount="${disk_for_unmount%s*}"   # strip trailing 'sN' if present
log "Unmounting /dev/${disk_for_unmount} before imaging"
if ! diskutil unmountDisk force "/dev/${disk_for_unmount}" >/dev/null 2>&1; then
  log "WARNING: failed to unmount /dev/${disk_for_unmount}; dd may hit 'Resource busy'"
fi

# ---------------------------------------------------------------------------
# Run dd and stream progress
# ---------------------------------------------------------------------------

tmp_err="$(mktemp)"
trap 'rm -f "$tmp_err"' EXIT

# Helper: parse a dd "bytes transferred..." line into a PROGRESS line.
emit_progress_from_line() {
  local line="$1"
  local bytes elapsed rate pct

  # Example line:
  #   880803840 bytes transferred in 22.196709 secs (39681731 bytes/sec)
  if [[ "$line" =~ ^([0-9]+)\ bytes\ transferred\ in\ ([0-9.]+)\ secs\ \(([0-9]+)\ bytes/sec\) ]]; then
    bytes="${BASH_REMATCH[1]}"
    elapsed="${BASH_REMATCH[2]}"
    rate="${BASH_REMATCH[3]}"

    if [[ "$TOTAL_BYTES" -gt 0 ]]; then
      pct="$(
        awk -v b="$bytes" -v t="$TOTAL_BYTES" 'BEGIN {
          if (t > 0) printf "%.3f", (b * 100.0) / t;
          else print "0.000";
        }'
      )"
    else
      pct=""
    fi

    echo "PROGRESS bytes=${bytes} total=${TOTAL_BYTES} pct=${pct} rate=${rate} elapsed=${elapsed}"
  fi
}

# Start dd in the background, sending stderr to the temp file.
dd if="$PARTITION" of="$DEST_IMG" bs=4m conv=sync,noerror \
  2> "$tmp_err" &
dd_pid=$!

# Background: periodically send SIGINFO to dd so it prints a status line.
(
  while kill -0 "$dd_pid" 2>/dev/null; do
    # SIGINFO is "INFO" for kill(1) on macOS
    kill -INFO "$dd_pid" 2>/dev/null || true
    sleep 1
  done
) &
info_pinger_pid=$!

# Background: follow dd's stderr and echo as DD_STATUS + PROGRESS lines.
(
  tail -F "$tmp_err" 2>/dev/null | while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    echo "DD_STATUS $line"
    emit_progress_from_line "$line"
  done
) &
status_watcher_pid=$!

# Wait for dd to finish.
wait "$dd_pid"
dd_rc=$?

# Stop helpers if still running.
for pid in "$info_pinger_pid" "$status_watcher_pid"; do
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
done

# One more drain of stderr so we don't miss the final summary.
if [[ -s "$tmp_err" ]]; then
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    echo "DD_STATUS $line"
    emit_progress_from_line "$line"
  done < "$tmp_err"
fi

if [[ $dd_rc -ne 0 ]]; then
  log "ERROR: dd failed with exit code $dd_rc"
  if [[ -s "$tmp_err" ]]; then
    log "dd stderr (tail):"
    tail -n 10 "$tmp_err" >&2
  fi
  exit "$dd_rc"
fi

sync || true

echo "READ_COMPLETE dest=${DEST_IMG}"
exit 0