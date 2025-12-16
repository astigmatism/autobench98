#!/usr/bin/env bash
set -euo pipefail

# write-image-macos.sh
#
# Usage:
#   write-image-macos.sh <SRC_IMG_PATH> <DEVICE_PATH> [PART_TABLE_PATH]
#
# Stdout protocol (for Node/CfImagerService to consume):
#   CAPACITY bytes=<totalBytesToWrite>
#   BEGIN_WRITE source=<src-img-path> dest=<device>
#   DD_STATUS <raw dd status line>
#   PROGRESS bytes=<n> total=<totalBytesToWrite> pct=<pct> rate=<bps> elapsed=<secs>
#   ...
#   WRITE_COMPLETE dest=<device>
#
# Stderr:
#   Human-oriented logs, including any error explanation.
#
# Notes:
#   - Non-interactive: no prompts.
#   - DEVICE_PATH should normally be the whole disk node (e.g. /dev/disk6).
#   - The image is assumed to contain its own filesystem contents; the
#     Linux workflow can additionally use a .part sidecar for geometry.
#   - Safety check: ensure image size <= total capacity of the target device.

log() { printf '[cf-write-macos] %s\n' "$*" >&2; }

if [[ $# -lt 2 ]]; then
  log "Usage: $0 <SRC_IMG_PATH> <DEVICE_PATH> [PART_TABLE_PATH]"
  exit 1
fi

SRC_IMG="$1"
DEVICE="$2"
PART_TABLE="${3:-}"

if [[ -z "$PART_TABLE" ]]; then
  PART_TABLE="${SRC_IMG%.img}.part"
fi

# Basic validation
if [[ ! -f "$SRC_IMG" ]]; then
  log "ERROR: SRC_IMG_PATH '$SRC_IMG' does not exist or is not a regular file"
  exit 1
fi

if [[ ! -e "$DEVICE" ]]; then
  log "ERROR: DEVICE_PATH '$DEVICE' does not exist"
  exit 1
fi

SRC_DIR="$(dirname "$SRC_IMG")"
if [[ ! -d "$SRC_DIR" ]]; then
  log "ERROR: source directory '$SRC_DIR' does not exist"
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

if ! command -v dd >/dev/null 2>&1; then
  log "ERROR: dd is required on macOS"
  exit 1
fi

# Optional: warn if not root (dd to raw disks usually needs root).
if [[ $EUID -ne 0 ]]; then
  log "WARNING: not running as root; dd may fail with 'Permission denied' on ${DEVICE}"
fi

# ---------------------------------------------------------------------------
# Derive the "base disk" for capacity checks and unmount operations.
#
# Examples:
#   DEVICE=/dev/disk6    -> base_disk=disk6
#   DEVICE=/dev/disk6s1  -> base_disk=disk6
# ---------------------------------------------------------------------------

base_disk="${DEVICE#/dev/}"
if [[ "$base_disk" =~ ^disk[0-9]+s[0-9]+$ ]]; then
  # Strip the slice suffix 'sN' only if it actually looks like diskNsM.
  base_disk="${base_disk%s[0-9]*}"
fi
BASE_DEV="/dev/${base_disk}"

log "Target device for write: ${DEVICE} (base disk: ${BASE_DEV})"

# ---------------------------------------------------------------------------
# Determine total bytes to WRITE (size of the image file).
# This is what the consumer will see as "total" for progress.
# ---------------------------------------------------------------------------

TOTAL_BYTES="$(stat -f%z "$SRC_IMG" 2>/dev/null || echo "0")"

if ! [[ "$TOTAL_BYTES" =~ ^[0-9]+$ ]] || [[ "$TOTAL_BYTES" -le 0 ]]; then
  log "ERROR: failed to determine image size for '$SRC_IMG' (TOTAL_BYTES=$TOTAL_BYTES)"
  exit 1
fi

# ---------------------------------------------------------------------------
# Safety check: ensure the target device's total capacity is >= image size.
# We use diskutil info -plist on the base disk (whole device).
# ---------------------------------------------------------------------------

get_device_size_bytes() {
  local dev="$1"
  local json size

  if ! json="$(diskutil info -plist "$dev" 2>/dev/null | plutil -convert json -r -o - - 2>/dev/null)"; then
    echo "0"
    return
  fi

  size="$(printf '%s\n' "$json" | awk -F: '/"TotalSize"/ { gsub(/[^0-9]/,"",$2); print $2; exit }')"
  if [[ -z "$size" ]]; then
    size="$(printf '%s\n' "$json" | awk -F: '/"Size"/ { gsub(/[^0-9]/,"",$2); print $2; exit }')"
  fi

  if [[ -z "$size" ]]; then
    echo "0"
  else
    echo "$size"
  fi
}

DEVICE_CAPACITY_BYTES="$(get_device_size_bytes "$BASE_DEV")"
if [[ "$DEVICE_CAPACITY_BYTES" =~ ^[0-9]+$ ]] && [[ "$DEVICE_CAPACITY_BYTES" -gt 0 ]]; then
  if (( TOTAL_BYTES > DEVICE_CAPACITY_BYTES )); then
    log "ERROR: image ($TOTAL_BYTES bytes) is larger than target device ($DEVICE_CAPACITY_BYTES bytes)"
    exit 1
  fi
else
  log "WARNING: unable to determine capacity of '${BASE_DEV}'; skipping size check"
fi

# Emit capacity FIRST so the consumer can capture it before progress lines.
# Here, "capacity" means the total bytes we intend to write (image size).
echo "CAPACITY bytes=${TOTAL_BYTES}"

# ---------------------------------------------------------------------------
# Announce write beginning
# ---------------------------------------------------------------------------

echo "BEGIN_WRITE source=${SRC_IMG} dest=${DEVICE}"

# ---------------------------------------------------------------------------
# Partition-table sidecar handling (informational on macOS).
#
# On Linux, the .part file is an sfdisk-compatible dump and the write script
# can reapply it. There is no direct, safe macOS analog for that format, so
# we *do not* attempt to auto-apply it here. Instead, we log its presence and
# rely on the disk already being partitioned appropriately.
# ---------------------------------------------------------------------------

if [[ -f "$PART_TABLE" ]]; then
  log "Partition table sidecar '${PART_TABLE}' found."
  log "NOTE: write-image-macos.sh does not automatically apply this file."
  log "      Ensure ${BASE_DEV} is pre-partitioned to match the original layout."
else
  log "WARNING: partition table sidecar '${PART_TABLE}' not found; proceeding with existing layout on ${BASE_DEV}"
fi

# ---------------------------------------------------------------------------
# Unmount the whole disk so dd doesn't hit 'Resource busy'
# ---------------------------------------------------------------------------

log "Unmounting ${BASE_DEV} before writing image"
if ! diskutil unmountDisk force "${BASE_DEV}" >/dev/null 2>&1; then
  log "WARNING: failed to unmount ${BASE_DEV}; dd may hit 'Resource busy'"
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
dd if="$SRC_IMG" of="$DEVICE" bs=4m conv=sync \
  2> "$tmp_err" &
dd_pid=$!

# Background: periodically send SIGINFO to dd so it prints a status line.
(
  while kill -0 "$dd_pid" 2>/dev/null; do
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

echo "WRITE_COMPLETE dest=${DEVICE}"
exit 0
