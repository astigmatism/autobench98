# AutoBench98 Workstation Setup Guide (Ubuntu Desktop 24.04 LTS)

## Overview

This guide describes how to configure a clean Ubuntu 24.04 Desktop system to run AutoBench98 as a dedicated headless server.  
It covers OS setup, network configuration, power tuning, SSH access, GitHub integration, Node installation, and application runtime setup.  
All commands are tested directly on Ubuntu Desktop 24.04 LTS.

---

## 1. Base OS Setup

### 1.1 Update and install essentials

## Remove BRLTTY to prevent FTDI interference
Some Ubuntu installs include `brltty`, which can interfere with FTDI USB‑serial devices (e.g., WattsUp meters).
Disable it to prevent data stalls:
```bash
sudo apt remove --purge brltty
sudo apt autoremove --purge
```
Unplug/replug devices afterward.

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git vim net-tools htop byobu openssh-server lsof ffmpeg build-essential python3 make g++
```

### 1.2 Enable SSH for headless access

```bash
sudo systemctl enable ssh
sudo systemctl start ssh
sudo systemctl status ssh
```

Once enabled, verify SSH access from another computer:

```bash
ssh <username>@<machine-ip>
```

### 1.3 Configure a static IP address

Identify your network adapter:

```bash
nmcli device
```

Then assign a static IP (replace with your reserved address):

```bash
sudo nmcli connection modify "Wired connection 1"   ipv4.addresses 192.168.1.17/24   ipv4.gateway 192.168.1.1   ipv4.dns "8.8.8.8,1.1.1.1"   ipv4.method manual

sudo nmcli connection up "Wired connection 1"
```

After this step, you can disconnect the monitor, keyboard, and mouse and access the system headlessly over SSH.

---

## 2. Disable Power Saving

Open **Settings → Power** and set:

-   **Screen Blank:** Never
-   **Power Mode:** Performance

This ensures the workstation behaves like a server (no sleep or suspend).

---

## 3. Disable Auto Updates and Desktop Notifications

Ubuntu Desktop enables background updates and nags by default. Disable them for stable unattended operation.

```bash
sudo systemctl disable --now apt-daily.timer apt-daily-upgrade.timer
sudo systemctl mask unattended-upgrades apt-daily apt-daily-upgrade
```

Remove update managers:

```bash
sudo apt remove update-manager update-notifier update-notifier-common -y
```

Disable periodic APT jobs:

```bash
sudo tee /etc/apt/apt.conf.d/10periodic >/dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "0";
APT::Periodic::Download-Upgradeable-Packages "0";
APT::Periodic::AutocleanInterval "0";
APT::Periodic::Unattended-Upgrade "0";
EOF
```

---

## 4. Install and Configure Git + GitHub Access

### 4.1 Install Git

```bash
sudo apt install -y git
```

### 4.2 Generate an SSH key

```bash
ssh-keygen -t ed25519 -C "your@email.example"
cat ~/.ssh/id_ed25519.pub
```

### 4.3 Add the key to GitHub

1. Log into [https://github.com](https://github.com).
2. Go to **Settings → SSH and GPG Keys → New SSH Key**.
3. Paste your key, name it something like `AutoBench98-1`, and save.

### 4.4 Verify connection

```bash
ssh -T git@github.com
```

Expected message:

> Hi <username>! You've successfully authenticated.

---

## 5. Clone the AutoBench98 Project

```bash
cd ~
git clone git@github.com:astigmatism/autobench98.git
cd autobench98
```

---

## 6. Install Node.js and NPM

Install via NVM (Node Version Manager) for easy version control.

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"

nvm install --lts
nvm alias default 'lts/*'
node -v
npm -v
```

Ensure NVM loads automatically on login:

```bash
echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.bashrc
echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' >> ~/.bashrc
```

---

## 7. Configure Local Environment Variables

```bash
cd ~/autobench98
cp .env.example .env
nano .env
```

Adjust as needed (for example):

```
API_PORT=3000
SIDECAR_PORT=3100
DATA_DIR=./data/orchestrator
SERIAL_SUMMARY_MS=0
LOG_LEVEL=info
```

---

## 8. Install Dependencies

```bash
cd ~/autobench98
npm install
```

This installs all workspace packages used by the orchestrator, sidecar, and web frontend.

---

## 9. Build and Run the Application

```bash
npm -w packages/logging run build
npm -w apps/web run build
./start-linux.sh
```

Expected output (example):

```
[autobench98] DATA_DIR => ./data/orchestrator
[autobench98] Orchestrator => http://localhost:3000
[autobench98] Sidecar      => http://localhost:3100
Press Ctrl-C to stop.
```

### Optional: Enable serial access

If you see a dialout warning:

```bash
sudo usermod -aG dialout "$(id -un)" && newgrp dialout
```

---

## 10. Reverse Proxy (Expose via Synology DSM 7)

If you are hosting AutoBench98 behind a Synology NAS running DSM 7, use DSM’s built‑in reverse proxy instead of NGINX. This correctly forwards WebSocket Upgrade headers required by the orchestrator.

### 1. Open DSM Reverse Proxy Settings

1. Log into DSM.
2. Go to **Control Panel → Login Portal → Advanced → Reverse Proxy**.
3. Click **Create** or edit your existing rule for AutoBench98.

### 2. General Tab — Base Forwarding Rule

Configure:

-   **Source**

    -   Protocol: `HTTPS`
    -   Hostname: your domain (e.g. `autobench.local` or your public domain)
    -   Port: `443`

-   **Destination**
    -   Protocol: `HTTP`
    -   Hostname: IP address of your Ubuntu server
    -   Port: `3000` (AutoBench98 orchestrator)

Leave the path blank to forward all traffic.

### 3. Custom Header — Required for WebSockets

This is the critical part.

Add **two custom request headers**:

| Header Name    | Value                 |
| -------------- | --------------------- |
| **Upgrade**    | `$http_upgrade`       |
| **Connection** | `$connection_upgrade` |

These instruct DSM to forward WebSocket upgrade handshakes correctly.

Without these, WS requests arrive as plain HTTP requests with  
`connection: close` and **WebSockets will always fail**.

### 4. Advanced Settings (Optional but Recommended)

Under **Advanced Settings**, enable:

-   **Enable WebSocket** (if your DSM version shows this option)
-   **HTTP/2 enabled** (optional; DSM will still talk HTTP/1.1 to backend)

### 5. Save and Apply

Click **Save**, then refresh the DSM reverse proxy list to ensure the settings applied.

After this, the orchestrator will receive correct WebSocket handshake headers:

```
Connection: Upgrade
Upgrade: websocket
```

and your existing `/ws` Fastify route will successfully switch protocols.

---

## 11. Updating the Project

When new code is available:

```bash
cd ~/autobench98
# Stop the running app (Ctrl+C if in foreground)
git fetch --all --prune
git pull --rebase
npm install
./start-linux.sh
```

---

## 12. Verification

Check running ports:

```bash
ss -tulpn | grep -E ':(80|3000|3100)'
```

Check HTTP response:

```bash
curl -I http://localhost:3000
```

If using nginx:

```bash
curl -I http://localhost
```

---

## 12.5 Ensure serial device permissions (dialout group)

AutoBench98 talks to multiple Arduino-based controllers over USB serial.  
On Ubuntu, access to `/dev/ttyACM*` and `/dev/ttyUSB*` is restricted to the `dialout` group.  
If your user is not in this group, the orchestrator will log errors like:

> Error: Permission denied, cannot open /dev/ttyACM0

To permanently fix this:

1. **Add your user to the `dialout` group:**

    ```bash
    sudo usermod -aG dialout "$USER"
    ```

2. **Log out and back in** (or reboot) so the new group membership is applied.

3. **Verify membership:**
    ```bash
    groups
    ```
    You should see `dialout` in the list, for example:
    ```text
    youruser adm dialout cdrom sudo dip plugdev users lpadmin
    ```

Once this is done, the AutoBench98 orchestrator should be able to open the Arduino serial ports on startup without permission errors.

## 13. Optional Improvements

-   **Byobu:** persistent sessions for monitoring.
    ```bash
    byobu
    ```
-   **Logs:** use `journalctl` or `tail -f ./logs/*.log` if available.
-   **System start automation:** later, add a systemd service if desired.

---

**System ready.**  
Your Ubuntu 24.04 workstation is now a stable, headless AutoBench98 host.
