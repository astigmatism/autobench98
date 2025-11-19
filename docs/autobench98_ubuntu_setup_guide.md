# AutoBench98 Workstation Setup Guide (Ubuntu Desktop 24.04 LTS)

## Overview

This guide describes how to configure a clean Ubuntu 24.04 Desktop system to run AutoBench98 as a dedicated headless server.  
It covers OS setup, network configuration, power tuning, SSH access, GitHub integration, Node installation, and application runtime setup.  
All commands are tested directly on Ubuntu Desktop 24.04 LTS.

---

## 1. Base OS Setup

### 1.1 Update and install essentials

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

- **Screen Blank:** Never  
- **Power Mode:** Performance

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

## 10. Reverse Proxy (Expose Port 80)

Keep the app running on port 3000 for safety and use nginx to expose it on port 80.

```bash
sudo apt install -y nginx
sudo tee /etc/nginx/sites-available/autobench >/dev/null <<'NGINX'
server {
    listen 80;
    server_name autobench.local;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX

sudo ln -s /etc/nginx/sites-available/autobench /etc/nginx/sites-enabled/autobench
sudo nginx -t && sudo systemctl reload nginx
```

You can now access AutoBench at:
```
http://autobench.local
```

(Optional: add `192.168.1.17 autobench.local` to `/etc/hosts` on your client system.)

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

## 13. Optional Improvements

- **Byobu:** persistent sessions for monitoring.
  ```bash
  byobu
  ```
- **Logs:** use `journalctl` or `tail -f ./logs/*.log` if available.
- **System start automation:** later, add a systemd service if desired.

---

**System ready.**  
Your Ubuntu 24.04 workstation is now a stable, headless AutoBench98 host.
