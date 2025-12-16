#!/usr/bin/env bash
set -euo pipefail

# Ensure common sbin paths are on PATH for non-root users so we can find tools
# like blockdev and lsblk even when sudo is not used.
export PATH="/usr/sbin:/sbin:$PATH"

# write-image-linux.sh
#
# Usage:
#   write-image-linux.sh <SRC_IMG_PATH> <DEVICE_PATH> [PART_TABLE_PATH]
#
# Stdout protocol (for Node/CfImagerService to consume):
#   CAPACITY bytes=<totalBytesToWrite>
#   BEGIN_WRITE source=<src-img-path> dest=<device>
#   DD_STATUS <raw status line>        # here: any non-numeric stderr from pv
#   PROGRESS bytes=<n> total=<totalBytesToWrite> pct=<pct> rate=<bps?> elapsed=<secs?>
#   ...
#   WRITE_COMPLETE dest=<device>
#
# Stderr:
#   Human-oriented logs, including any error explanation.
#
# Notes:
#   - Non-interactive: no prompts.
#   - DEVICE_PATH should be the whole CF device node (e.g. /dev/sda).
#   - The image is assumed to contain the contents of a single partition, while
#     the matching .part file holds the partition table. On write, we:
#       * apply the partition table (if available) via sfdisk
#       * write the image into the first partition on the device
#     If the .part file is missing or sfdisk is unavailable, we fall back to
#     writing directly to the whole device (previous behavior).
#   - Safety check: ensure image size <= total capacity of the target device.
#   - Progress:
#       * Uses `pv -n -s TOTAL_BYTES` to emit a numeric percentage to stderr.
#       * We derive "bytes" from pct * TOTAL_BYTES.
#       * Rate/elapsed are left blank (can be extended if needed later).

log() { printf '[cf-write-linux] %s\n' "$*" >&2; }

if [[ $# -lt 2 ]]; then
  log "Usage: $0 <SRC_IMG_PATH> <DEVICE_PATH> [PART_TABLE_PATH]"
  exit 1
fi

SRC_IMG="$1"
DEVICE="$2"
PART_TABLE="${3:-}"

# Keep the third arg for parity with read scripts.
if [[ -z "$PART_TABLE" ]]; then
  PART_TABLE="${SRC_IMG%.img}.part"
fi

# ---------------------------------------------------------------------------
# Basic validation
# ---------------------------------------------------------------------------

if [[ ! -f "$SRC_IMG" ]]; then
  log "ERROR: SRC_IMG_PATH '$SRC_IMG' does not exist or is not a regular file"
  exit 1
fi

if [[ ! -b "$DEVICE" ]]; then
  log "ERROR: DEVICE_PATH '$DEVICE' is not a block device"
  exit 1
fi

SRC_DIR="$(dirname "$SRC_IMG")"
if [[ ! -d "$SRC_DIR" ]]; then
  log "ERROR: source directory '$SRC_DIR' does not exist"
  exit 1
fi

if ! command -v pv >/dev/null 2>&1; then
  log "ERROR: pv is required for streaming progress. Install it (e.g. 'sudo apt-get install pv')."
  exit 1
fi

# Helpful but not strictly required; we'll fall back to /sys if missing.
if ! command -v blockdev >/dev/null 2>&1; then
  log "WARNING: 'blockdev' not found; will fall back to /sys/block for capacity."
fi

if ! command -v lsblk >/dev/null 2>&1; then
  log "WARNING: 'lsblk' not found; will not attempt automatic unmount of partitions."
fi

# Optional: warn if not root (writing raw block devices usually needs root).
if [[ $EUID -ne 0 ]]; then
  log "WARNING: not running as root; writing to ${DEVICE} may fail with 'Permission denied'"
fi

# ---------------------------------------------------------------------------
# Determine total bytes to WRITE (size of the image file).
# This is what the consumer will see as "total" for progress.
# ---------------------------------------------------------------------------

TOTAL_BYTES="$(stat -c %s "$SRC_IMG" 2>/dev/null || echo "0")"

if ! [[ "$TOTAL_BYTES" =~ ^[0-9]+$ ]] || [[ "$TOTAL_BYTES" -le 0 ]]; then
  log "ERROR: failed to determine image size for '$SRC_IMG' (TOTAL_BYTES=$TOTAL_BYTES)"
  exit 1
fi

# ---------------------------------------------------------------------------
# Determine total capacity (bytes) for the target device.
# Prefer blockdev --getsize64; fall back to /sys/block if needed.
# ---------------------------------------------------------------------------

get_device_size_bytes() {
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

  # For things like "sda1" or "nvme0n1p1", fall back to both:
  #   /sys/block/<name>/size
  #   /sys/block/<disk>/size (where <disk> strips partition suffix)
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

DEVICE_CAPACITY_BYTES="$(get_device_size_bytes "$DEVICE")"
if [[ "$DEVICE_CAPACITY_BYTES" =~ ^[0-9]+$ ]] && [[ "$DEVICE_CAPACITY_BYTES" -gt 0 ]]; then
  if (( TOTAL_BYTES > DEVICE_CAPACITY_BYTES )); then
    log "ERROR: image ($TOTAL_BYTES bytes) is larger than target device ($DEVICE_CAPACITY_BYTES bytes)"
    exit 1
  fi
else
  log "WARNING: unable to determine capacity of '${DEVICE}'; skipping size check"
fi

# Emit capacity FIRST so the consumer can capture it.
# Here, "capacity" means the total bytes we intend to write (image size).
echo "CAPACITY bytes=${TOTAL_BYTES}"

# ---------------------------------------------------------------------------
# Announce write beginning
# ---------------------------------------------------------------------------

echo "BEGIN_WRITE source=${SRC_IMG} dest=${DEVICE}"

# ---------------------------------------------------------------------------
# Best-effort unmount of any partitions on the target device, if lsblk exists.
#
# We look for any entries under the given DEVICE that have a mountpoint and
# attempt to umount them to avoid "device is busy" errors.
# ---------------------------------------------------------------------------

if command -v lsblk >/dev/null 2>&1; then
  # Collect "NAME MOUNTPOINT" for this device and its children.
  # Example rows:
  #   /dev/sdb      ...
  #   /dev/sdb1     /media/user/CF_CARD
  while IFS= read -r line; do
    dev_path="$(printf '%s\n' "$line" | awk '{print $1}')"
    mnt_pt="$(printf '%s\n' "$line" | awk '{print $2}')"
    [[ -z "$mnt_pt" || "$mnt_pt" = "-" ]] && continue

    log "Attempting to unmount ${dev_path} (mounted at ${mnt_pt})"
    if ! umount "$dev_path" >/dev/null 2>&1; then
      log "WARNING: failed to unmount ${dev_path}; write may hit 'device busy'"
    fi
  done < <(lsblk -lnpo NAME,MOUNTPOINT "$DEVICE" 2>/dev/null || true)
else
  log "WARNING: lsblk not available; skipping automatic unmount of partitions"
fi

# ---------------------------------------------------------------------------
# Apply partition table from .part (if present) and determine write target.
#
# If we successfully apply the .part via sfdisk, we look up the first
# partition node and write the image into that partition. This mirrors the
# read script behavior (imaging a single partition + saving the layout).
#
# If .part is missing or sfdisk is unavailable, we fall back to writing
# to the whole device (previous behavior).
# ---------------------------------------------------------------------------

TARGET="$DEVICE"

if [[ -f "$PART_TABLE" ]]; then
  if command -v sfdisk >/dev/null 2>&1; then
    log "Applying partition table from '${PART_TABLE}' to '${DEVICE}'"
    if ! sfdisk "$DEVICE" < "$PART_TABLE"; then
      log "ERROR: failed to apply partition table from '${PART_TABLE}' to '${DEVICE}'"
      exit 1
    fi

    # After re-partitioning, locate the first partition and treat it as the
    # primary write target, matching the semantics of the read script.
    if command -v lsblk >/dev/null 2>&1; then
      first_part="$(
        lsblk -lnpo NAME,TYPE "$DEVICE" 2>/dev/null | awk '$2=="part" {print $1; exit}'
      )"
      if [[ -n "$first_part" ]]; then
        TARGET="$first_part"
        log "Writing image into first partition ${TARGET}"
      else
        log "WARNING: no partitions visible on ${DEVICE} after applying table; writing to whole device"
      fi
    else
      log "WARNING: lsblk not available; cannot locate partition node; writing to whole device"
    fi
  else
    log "WARNING: sfdisk not found; cannot apply partition table file '${PART_TABLE}'"
  fi
else
  log "WARNING: partition table file '${PART_TABLE}' not found; using existing layout on ${DEVICE}"
fi

# ---------------------------------------------------------------------------
# Run pv and stream progress.
#
# We use:
#   pv -n -s TOTAL_BYTES "$SRC_IMG" > "$TARGET"
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
  pv -n -s "$TOTAL_BYTES" "$SRC_IMG" > "$TARGET"
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
      # rate / elapsed left blank; we can extend in a future revision if needed.
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

echo "WRITE_COMPLETE dest=${DEVICE}"
exit 0
