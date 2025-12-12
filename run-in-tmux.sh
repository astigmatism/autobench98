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

# Create a new detached tmux session and run the app in a shell wrapper
"${TMUX_CMD[@]}" new-session -d -s "$SESSION_NAME" \
  "cd '$PROJECT_DIR' && \
   '$START_SCRIPT' --no-env-ask; \
   EXIT_CODE=\$?; \
   echo; \
   echo \"start-linux.sh exited with code \$EXIT_CODE\"; \
   echo \"Press Enter to close this window...\"; \
   read"