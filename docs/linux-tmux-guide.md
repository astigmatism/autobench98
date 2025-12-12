# Autobench98 Debian Server Setup Guide

## Prerequisites

-   Debian server with SSH access
-   Repository cloned to: `/home/<user>/autobench98`
-   Manual testing verified by running:
    ```bash
    ./start-linux.sh --no-env-ask
    ```

## Step 1 — Ensure `run-in-tmux.sh` Is Executable

```bash
cd ~/autobench98
chmod +x run-in-tmux.sh
```

## Step 2 — Create the `run-in-tmux.sh` Boot Launcher

Place this file at:

```
~/autobench98/run-in-tmux.sh
```

### Contents:

```bash
#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="autobench98"
PROJECT_DIR="/home/astigmatism/autobench98"
START_SCRIPT="$PROJECT_DIR/start-linux.sh"

cd "$PROJECT_DIR"

# Ensure start script is executable after git pulls
if [[ -f "$START_SCRIPT" ]]; then
  chmod +x "$START_SCRIPT"
else
  echo "ERROR: $START_SCRIPT not found."
  exit 1
fi

# Use Byobu’s tmux wrapper
TMUX_CMD=("/usr/bin/byobu-tmux")

# If session exists, exit
if "${TMUX_CMD[@]}" has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "tmux session '$SESSION_NAME' already exists; nothing to do."
  exit 0
fi

# Create a new detached session running login shell
"${TMUX_CMD[@]}" new-session -d -s "$SESSION_NAME"   "cd '$PROJECT_DIR' && exec "${SHELL:-/bin/bash}" -l"

# Run the application inside that shell
"${TMUX_CMD[@]}" send-keys -t "$SESSION_NAME" "./start-linux.sh --no-env-ask" C-m
```

## Step 3 — Create the Systemd User Service

Place this file at:

```
~/.config/systemd/user/autobench98.service
```

### Contents:

```ini
[Unit]
Description=Autobench98 tmux session

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=%h/autobench98
ExecStart=%h/autobench98/run-in-tmux.sh

[Install]
WantedBy=default.target
```

## Step 4 — Reload User Systemd

```bash
systemctl --user daemon-reload
```

## Step 5 — Enable the Service to Start on Boot

```bash
systemctl --user enable autobench98.service
```

## Step 6 — Allow User Services to Run at Boot (Linger)

```bash
sudo loginctl enable-linger <your-username>
```

Example:

```bash
sudo loginctl enable-linger astigmatism
```

## Step 7 — Test the Service Manually

```bash
systemctl --user start autobench98.service
tmux ls
```

Expected:

```
autobench98: 1 windows
```

## Step 8 — Reboot Test

```bash
sudo reboot
```

After SSH login:

-   You should land in normal Byobu session.
-   Application should be running.
-   You may inspect it with:
    ```bash
    tmux switch-client -t autobench98
    ```

## Notes

-   Exiting the `autobench98` tmux shell ends the session; this is expected.
-   Restarting the app manually inside the session is done via:
    ```bash
    ./start-linux.sh --no-env-ask
    ```
-   The systemd service will re-create the session automatically on next reboot.
