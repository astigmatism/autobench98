#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="autobench98"

cd "$HOME/autobench98"

# Always talk to the default tmux server (same one Byobu is using)
TMUX_CMD=("/usr/bin/tmux")

# If the tmux session already exists, exit quietly
if "${TMUX_CMD[@]}" has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "tmux session '$SESSION_NAME' already exists; nothing to do."
  exit 0
fi

# Create a new detached tmux session and run the app in a shell wrapper
# so that if it exits, we can still see the output and exit code.
"${TMUX_CMD[@]}" new-session -d -s "$SESSION_NAME" \
  "cd /home/astigmatism/autobench98 && \
   /home/astigmatism/autobench98/linux-start.sh --no-env-ask; \
   EXIT_CODE=\$?; \
   echo; \
   echo \"linux-start.sh exited with code \$EXIT_CODE\"; \
   echo \"Press Enter to close this window...\"; \
   read"