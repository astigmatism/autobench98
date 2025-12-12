#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="autobench98"
PROJECT_DIR="/home/astigmatism/autobench98"
START_SCRIPT="$PROJECT_DIR/start-linux.sh"

cd "$PROJECT_DIR"

# Ensure the start script is executable (handle git pulls that reset permissions)
if [[ -f "$START_SCRIPT" ]]; then
  chmod +x "$START_SCRIPT"
else
  echo "ERROR: $START_SCRIPT not found."
  exit 1
fi

# Always talk to the default tmux server (same one Byobu is using)
TMUX_CMD=("/usr/bin/tmux")

# If the tmux session already exists, exit quietly
if "${TMUX_CMD[@]}" has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "tmux session '$SESSION_NAME' already exists; nothing to do."
  exit 0
fi

# 1) Create a new detached tmux session running your *normal* login shell
#    in the project directory. This makes PATH, Node, etc. behave just like
#    when you SSH in.
"${TMUX_CMD[@]}" new-session -d -s "$SESSION_NAME" \
  "cd '$PROJECT_DIR' && exec \"\${SHELL:-/bin/bash}\" -l"

# 2) In that shell, type the start command and press Enter.
"${TMUX_CMD[@]}" send-keys -t "$SESSION_NAME" "./start-linux.sh --no-env-ask" C-m