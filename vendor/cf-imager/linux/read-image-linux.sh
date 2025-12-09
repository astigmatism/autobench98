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

# Heuristic: if the device name ends with a digit (e.g. /dev/sda1, /dev/nvme0n1p1),
# assume it's already a partition.
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
# Helper: parse Linux dd "bytes copied" lines into PROGRESS lines
#
# Typical dd status=progress summary line:
#   1073741824 bytes (1.1 GB, 1.0 GiB) copied, 10 s, 107 MB/s
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Run dd with status=progress, streaming stderr through our parser.
#
# We use stdbuf so dd's output isn't block-buffered when going through a pipe,
# then send stderr+stdout together (2>&1) into a while-loop.
# ---------------------------------------------------------------------------

if ! command -v stdbuf >/dev/null 2>&1; then
  log "ERROR: stdbuf is required for streaming dd progress (usually in coreutils)."
  exit 1
fi

# Foreground pipeline: dd -> while loop
stdbuf -o0 -e0 dd if="$PARTITION" of="$DEST_IMG" bs=4M status=progress conv=fsync 2>&1 |
while IFS= read -r line; do
  # Forward raw dd status
  [[ -z "$line" ]] && continue
  echo "DD_STATUS $line"
  emit_progress_from_line "$line"
done

dd_rc=${PIPESTATUS[0]}

if [[ $dd_rc -ne 0 ]]; then
  log "ERROR: dd failed with exit code $dd_rc"
  exit "$dd_rc"
fi

sync || true

# ---------------------------------------------------------------------------
# Dump partition table (sidecar .part) with sfdisk if available
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