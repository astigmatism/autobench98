#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="autobench98"
TMUX_SOCKET="byobu"

cd "$HOME/autobench98"

# Always talk to the same tmux server Byobu uses
TMUX_CMD=(tmux -L "$TMUX_SOCKET")

# If the tmux session already exists, exit quietly
if "${TMUX_CMD[@]}" has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "tmux session '$SESSION_NAME' already exists; nothing to do."
  exit 0
fi

# Create a new detached tmux session and run the app
"${TMUX_CMD[@]}" new-session -d -s "$SESSION_NAME" "./linux-start.sh --no-env-ask"