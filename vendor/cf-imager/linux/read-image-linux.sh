#!/usr/bin/env bash
set -euo pipefail

# Ensure common sbin paths are on PATH for non-root users so we can find tools
# like sfdisk even when sudo is not used.
export PATH="/usr/sbin:/sbin:$PATH"

# read-image-linux.sh
#
# Usage:
#   read-image-linux.sh <DEVICE_PATH> <DEST_IMG_PATH> [PART_TABLE_PATH]
#
# Stdout protocol (for Node/CfImagerService to consume):
#   CAPACITY bytes=<totalBytes>
#   BEGIN_READ source=<partition> dest=<dest-img-path>
#   DD_STATUS <raw status line>        # here: any non-numeric stderr from pv
#   PROGRESS bytes=<n> total=<totalBytes> pct=<pct> rate=<bps?> elapsed=<secs?>
#   ...
#   READ_COMPLETE dest=<dest-img-path>
#
# Stderr:
#   Human-oriented logs, including any error explanation.
#
# Notes:
#   - Non-interactive: no prompts.
#   - DEVICE_PATH is the whole CF device (e.g. /dev/sda) OR a partition (e.g. /dev/sda1).
#   - If DEVICE_PATH is a whole-disk node, we image the first partition.
#   - Progress:
#       * Uses `pv -n -s TOTAL_BYTES` to emit a numeric percentage to stderr.
#       * We derive "bytes" from pct * TOTAL_BYTES.
#       * Rate/elapsed are left blank (can be extended if needed later).

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

if ! command -v pv >/dev/null 2>&1; then
  log "ERROR: pv is required for streaming progress. Install it (e.g. 'sudo apt-get install pv')."
  exit 1
fi

if ! command -v lsblk >/dev/null 2>&1; then
  log "ERROR: lsblk is required to discover partitions"
  exit 1
fi

# ---------------------------------------------------------------------------
# Determine what to image: either DEVICE (if already a partition) or its
# first partition via lsblk.
# ---------------------------------------------------------------------------

PARTITION="$DEVICE"

# Heuristic: if the device name ends with a digit (e.g. /dev/sda1, /dev/nvme0n1p1),
# assume it's already a partition.
if [[ "$DEVICE" =~ [0-9]$ ]]; then
  log "Using DEVICE as partition: $PARTITION"
else
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

  # Try blockdev first
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
  local name blkdir sizefile sectors

  name="${dev#/dev/}"

  for blkdir in "/sys/block/$name" "/sys/block/${name%%[0-9]*}"; do
    if [[ -d "$blkdir" ]]; then
      # Partition-style: /sys/block/<disk>/<part>/size
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

      # Disk-style: /sys/block/<disk>/size
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
# Run pv and stream progress.
#
# We use:
#   pv -n -s TOTAL_BYTES "$PARTITION" > "$DEST_IMG"
#
# - `-n` makes pv emit a bare numeric percentage (0–100) to stderr.
# - `-s TOTAL_BYTES` gives pv the total size for ETA and accurate percent.
#
# We redirect that stderr through a loop that:
#   - treats numeric lines as percentages -> PROGRESS
#   - treats anything else as DD_STATUS (for completeness/future-proofing)
# ---------------------------------------------------------------------------

copy_rc=0

{
  pv -n -s "$TOTAL_BYTES" "$PARTITION" > "$DEST_IMG"
  copy_rc=$?
} 2> >(
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue

    # Numeric-only lines from `pv -n` are percentages.
    if [[ "$line" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
      pct="$line"
      bytes=0
      if [[ "$TOTAL_BYTES" -gt 0 ]]; then
        bytes="$(
          awk -v p="$pct" -v t="$TOTAL_BYTES" 'BEGIN {
            printf "%.0f", (p / 100.0) * t;
          }'
        )"
      fi
      # rate / elapsed left blank; can be filled in later if needed.
      echo "PROGRESS bytes=${bytes} total=${TOTAL_BYTES} pct=${pct} rate= elapsed="
    else
      # Fallback: anything non-numeric becomes a DD_STATUS line.
      echo "DD_STATUS $line"
    fi
  done
)

if [[ $copy_rc -ne 0 ]]; then
  log "ERROR: pv copy failed with exit code $copy_rc"
  exit "$copy_rc"
fi

sync || true

# ---------------------------------------------------------------------------
# Save the partition table to a .part file next to the .img
# ---------------------------------------------------------------------------

if command -v sfdisk >/dev/null 2>&1; then
  # Determine the parent disk device for the partition/device we imaged
  DISK_DEV="$DEVICE"

  if [[ "$DEVICE" =~ [0-9]$ ]]; then
    base="${DEVICE#/dev/}"
    if [[ "$base" =~ ^nvme[0-9]+n[0-9]+p[0-9]+$ ]]; then
      # /dev/nvme0n1p1 -> /dev/nvme0n1
      DISK_DEV="/dev/${base%p[0-9]*}"
    else
      # /dev/sda1 -> /dev/sda
      DISK_DEV="/dev/${base%%[0-9]*}"
    fi
  fi

  log "Saving partition table from '$DISK_DEV' to '$PART_TABLE'"

  if ! sfdisk -d "$DISK_DEV" > "$PART_TABLE" 2>/dev/null; then
    log "WARNING: failed to write partition table to $PART_TABLE"
  fi
else
  log "NOTE: sfdisk not found; skipping partition table dump"
fi

echo "READ_COMPLETE dest=${DEST_IMG}"
exit 0
