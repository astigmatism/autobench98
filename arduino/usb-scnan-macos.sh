#!/usr/bin/env bash
# usb-scan-macos.sh — list USB devices + serial ports on macOS
set -euo pipefail

cyan()  { printf "\033[1;36m%s\033[0m\n" "$*"; }
bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
have()  { command -v "$1" >/dev/null 2>&1; }

cyan "▶ USB Device Tree (from system_profiler)"
if have system_profiler; then
  # Fast, human-readable tree; remove extra blank lines to keep it compact
  system_profiler SPUSBDataType -detailLevel mini 2>/dev/null | sed -E '/^[[:space:]]*$/d' || true
else
  echo "system_profiler not found."
fi
echo

cyan "▶ Concise USB Table (from ioreg)"
if have ioreg; then
  # Parse ioreg for a terse table: Product, VID, PID, Vendor, Serial, Location
  ioreg -p IOUSB -w0 -l | awk '
    /"USB Product Name"/    {prod=$0; sub(/.*= /,"",prod); gsub(/"/,"",prod)}
    /"USB Vendor Name"/     {vend=$0; sub(/.*= /,"",vend); gsub(/"/,"",vend)}
    /"USB Serial Number"/   {ser=$0; sub(/.*= /,"",ser);  gsub(/"/,"",ser)}
    /"idVendor"/            {vid=$0; sub(/.*= /,"",vid)}
    /"idProduct"/           {pid=$0; sub(/.*= /,"",pid)}
    /"locationID"/          {loc=$0; sub(/.*= /,"",loc)}
    /^\}$/ {
      if (prod || vend || vid || pid || ser || loc) {
        # Convert numeric fields to hex if possible
        v = (vid+0); p = (pid+0); l = (loc+0);
        if (v>0 && p>0) {
          printf "%-36s  VID: %04x  PID: %04x  Vendor: %-20s  SN: %-18s  Loc: 0x%08x\n",
                  prod, v, p, vend, ser, l
        } else {
          printf "%-36s  VID: %s  PID: %s  Vendor: %-20s  SN: %-18s  Loc: %s\n",
                  prod, vid, pid, vend, ser, loc
        }
      }
      prod=vend=ser=""; vid=pid=loc=""
    }
  ' || true
else
  echo "ioreg not found."
fi
echo

cyan "▶ Serial Ports (tty/cu) likely relevant to Arduinos"
# Common Arduino-style device nodes
found=0
for d in /dev/tty.usb* /dev/cu.usb*; do
  if [[ -e "$d" ]]; then
    if [[ $found -eq 0 ]]; then
      printf "%-30s  %-s\n" "Device Node" "Owner/Group (permissions)"
      printf "%-30s  %-s\n" "-----------" "------------------------"
      found=1
    fi
    ls -l "$d" | awk '{printf "%-30s  %s %s (%s)\n", $9, $3, $4, $1}'
  fi
done
if [[ $found -eq 0 ]]; then
  echo "No /dev/tty.usb* or /dev/cu.usb* nodes found."
  echo "• If boards are connected but missing here: try a different cable/port or power cycle the boards."
  echo "• On Apple Silicon, some boards enumerate as tty.usbmodem*; others as tty.usbserial*."
fi
echo

cyan "▶ Quick tips"
cat <<'TIPS'
• Expect Arduinos to appear as /dev/{tty,cu}.usbmodem* or /dev/{tty,cu}.usbserial*.
• If multiple boards are connected, you should see multiple device nodes.
• VID/PID for official Arduino (e.g., 2341/8036 or similar) can help confirm identity.
• To sanity-check a port (non-invasively), try:   stty -f /dev/tty.usbmodemXXXX 9600
• If permission denied on Linux (not macOS), you’d add your user to dialout; macOS doesn’t need that.

TIPS