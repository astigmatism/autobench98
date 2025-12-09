#!/usr/bin/env bash
set -euo pipefail

# read-image-linux.sh
#
# Usage:
#   read-image-linux.sh <DEVICE_PATH> <DEST_IMG_PATH> [PART_TABLE_PATH]
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
#
# Notes:
#   - Non-interactive: no prompts, no zenity.
#   - DEVICE_PATH is the whole CF device (e.g. /dev/sdc) OR a partition (e.g. /dev/sdc1).
#   - If DEVICE_PATH is a whole-disk node, we image the first partition.
#   - Progress:
#       * Uses `dd bs=4M status=progress` and forwards stderr lines as
#         "DD_STATUS <raw-line>" on stdout, plus parsed "PROGRESS ..." lines.
#   - Partition table is dumped with sfdisk -d DEVICE_PATH into a .part file.

log() { printf '[cf-read-linux] %s\n' "$*" >&2; }

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

if [[ ! -b "$DEVICE" ]]; then
  log "ERROR: DEVICE_PATH '$DEVICE' is not a block device"
  exit 1
fi

DEST_DIR="$(dirname "$DEST_IMG")"
if [[ ! -d "$DEST_DIR" ]]; then
  log "ERROR: destination directory '$DEST_DIR' does not exist"
  exit 1
fi

# ---------------------------------------------------------------------------
# Determine what to image: either DEVICE (if already a partition) or its
# first partition via lsblk.
# ---------------------------------------------------------------------------

PARTITION="$DEVICE"

# Heuristic: if the device name ends with a digit (e.g. /dev/sdc1, /dev/nvme0n1p1),
# assume it's already a partition (common Linux naming).
if [[ "$DEVICE" =~ [0-9]$ ]]; then
  log "Using DEVICE as partition: $PARTITION"
else
  if ! command -v lsblk >/dev/null 2>&1; then
    log "ERROR: lsblk is required to discover partitions"
    exit 1
  fi

  PARTITION="$(
    lsblk -lnpo NAME,TYPE "$DEVICE" 2>/dev/null | awk '$2=="part" {print $1; exit}'
  )"

  if [[ -z "$PARTITION" ]]; then
    log "ERROR: no partition found on '$DEVICE'"
    exit 1
  fi

  log "Using first partition '$PARTITION' on device '$DEVICE'"
fi

# ---------------------------------------------------------------------------
# Determine total capacity (bytes) for the partition.
# Prefer blockdev --getsize64; fall back to /sys/block if needed.
# ---------------------------------------------------------------------------

get_partition_size_bytes() {
  local dev="$1"

  # First try blockdev if available
  if command -v blockdev >/dev/null 2>&1; then
    local sz
    if sz="$(blockdev --getsize64 "$dev" 2>/dev/null)"; then
      if [[ "$sz" =~ ^[0-9]+$ ]] && [[ "$sz" -gt 0 ]]; then
        echo "$sz"
        return 0
      fi
    fi
  fi

  # Fallback: /sys/block
  # dev might be /dev/sdc1 or /dev/nvme0n1p1, etc.
  local name base blkdir sizefile sectors

  name="${dev#/dev/}"

  # If this is a partition, /sys/block/<parent>/<name>/size usually exists,
  # e.g. /sys/block/sdc/sdc1/size
  # For whole disk, /sys/block/<name>/size exists, e.g. /sys/block/sdc/size
  # Try partition-style path first, then disk-style.

  # Parent is everything up to the first digit (covers sdX, mmcblk0, nvme0n1, etc.)
  base="$name"
  # /sys/block parent directory (heuristic)
  # We don't strictly need parent; we can probe a couple of likely paths.

  # Try /sys/block/<disk>/<part>/size
  for blkdir in "/sys/block/$name" "/sys/block/${name%%[0-9]*}"; do
    if [[ -d "$blkdir" ]]; then
      # Partition-style dir
      if [[ -d "$blkdir/$name" ]]; then
        sizefile="$blkdir/$name/size"
        if [[ -f "$sizefile" ]]; then
          sectors="$(cat "$sizefile" 2>/dev/null || echo "0")"
          if [[ "$sectors" =~ ^[0-9]+$ ]] && [[ "$sectors" -gt 0 ]]; then
            echo $(( sectors * 512 ))
            return 0
          fi
        fi
      fi

      # Disk-style dir
      sizefile="$blkdir/size"
      if [[ -f "$sizefile" ]]; then
        sectors="$(cat "$sizefile" 2>/dev/null || echo "0")"
        if [[ "$sectors" =~ ^[0-9]+$ ]] && [[ "$sectors" -gt 0 ]]; then
          echo $(( sectors * 512 ))
          return 0
        fi
      fi
    fi
  done

  echo "0"
  return 0
}

TOTAL_BYTES="$(get_partition_size_bytes "$PARTITION")"
if ! [[ "$TOTAL_BYTES" =~ ^[0-9]+$ ]] || [[ "$TOTAL_BYTES" -le 0 ]]; then
  TOTAL_BYTES=0
fi

# Emit capacity FIRST so the consumer can capture it.
echo "CAPACITY bytes=${TOTAL_BYTES}"

# ---------------------------------------------------------------------------
# Announce read beginning
# ---------------------------------------------------------------------------

echo "BEGIN_READ source=${PARTITION} dest=${DEST_IMG}"

# ---------------------------------------------------------------------------
# Run dd and stream progress
# ---------------------------------------------------------------------------

tmp_err="$(mktemp)"
trap 'rm -f "$tmp_err"' EXIT

# Helper: parse a Linux dd "bytes copied" line into a PROGRESS line.
# Typical line:
#   1073741824 bytes (1.1 GB, 1.0 GiB) copied, 10 s, 107 MB/s
emit_progress_from_line() {
  local line="$1"
  local bytes elapsed rate pct

  if [[ "$line" =~ ^([0-9]+)\ bytes.*\ copied,\ ([0-9.]+)\ s,\ ([0-9]+)\ bytes/s ]]; then
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

# Start dd; redirect its stderr to a temp file
dd if="$PARTITION" of="$DEST_IMG" bs=4M status=progress conv=fsync \
  2> "$tmp_err" &
dd_pid=$!

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

# Stop watcher if still running.
if kill -0 "$status_watcher_pid" 2>/dev/null; then
  kill "$status_watcher_pid" 2>/dev/null || true
fi

# One last drain of stderr so we don't miss the final summary.
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

# ---------------------------------------------------------------------------
# Dump partition table with sfdisk (if available)
# ---------------------------------------------------------------------------

if command -v sfdisk >/dev/null 2>&1; then
  log "Saving partition table for '$DEVICE' to '$PART_TABLE'"
  if ! sfdisk -d "$DEVICE" > "$PART_TABLE" 2>/dev/null; then
    log "WARNING: failed to save partition table with sfdisk; continuing"
  fi
else
  log "WARNING: sfdisk not available; partition table will not be saved"
fi

echo "READ_COMPLETE dest=${DEST_IMG}"
exit 0