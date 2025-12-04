# AutoBench98 Workstation Setup Guide — Debian 13 “Trixie” (Desktop & Server Unified Edition)

## Overview
This unified guide covers **both Debian 13 Desktop and Debian 13 Server** installations and highlights where the steps differ.  
It is optimized for **power‑meter stability**, **USB/FTDI reliability**, **Node.js hosting**, and **headless AutoBench98 orchestration**.

Sections that differ between Desktop and Server are clearly marked:

- 🖥️ **Desktop‑only**
- 🖧 **Server‑only**
- ✔️ **Applies to both**

---

# 1. Base OS Setup

## 1.1 Update and install essential tools ✔️

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git vim net-tools htop byobu openssh-server lsof ffmpeg build-essential python3 make g++ unzip
```

If SSH was already enabled during installation ( Desktop installer option ), no further action is needed.

Verify:

```bash
systemctl status ssh
```

Should show **active (running)**.

---

# 2. Networking

## 2.1 Static IP configuration

### If you are using **Desktop (GNOME + NetworkManager)** 🖥️

```bash
nmcli device
nmcli connection modify "Wired connection 1"   ipv4.addresses 192.168.1.17/24   ipv4.gateway 192.168.1.1   ipv4.dns "8.8.8.8,1.1.1.1"   ipv4.method manual

nmcli connection up "Wired connection 1"
```

### If you are using **Server (no GUI)** 🖧  
NetworkManager is not installed.  
Use systemd-networkd:

```bash
sudo tee /etc/systemd/network/20-wired.network >/dev/null <<EOF
[Match]
Name=en*

[Network]
Address=192.168.1.17/24
Gateway=192.168.1.1
DNS=8.8.8.8
EOF
```

Enable:

```bash
sudo systemctl enable systemd-networkd --now
sudo systemctl restart systemd-networkd
```

---

# 3. Disable Power Saving

## 3.1 GNOME Power Settings (Desktop Only) 🖥️

Open **Settings → Power**:

- Automatic Suspend: **OFF**
- Blank Screen: **Never**
- Power Mode: **Performance**

## 3.2 Server environments do nothing here 🖧  
Server has no GUI power policy to disable.

---

# 4. Disable USB Autosuspend (critical for FTDI stability) ✔️

Edit GRUB:

```bash
sudo nano /etc/default/grub
```

Modify:

```
GRUB_CMDLINE_LINUX_DEFAULT="quiet splash usbcore.autosuspend=-1"
```

Update + reboot:

```bash
sudo update-grub
sudo reboot
```

---

# 5. Remove ModemManager (interferes with FTDI & Prolific devices) ✔️

```bash
sudo apt remove --purge modemmanager -y
```

Confirm:

```bash
systemctl status ModemManager
```

Should say: **Unit not found.**

---

# 6. Configure Git + GitHub SSH ✔️

```bash
sudo apt install -y git
ssh-keygen -t ed25519 -C "your-email"
cat ~/.ssh/id_ed25519.pub
```

Add the key to GitHub → Settings → SSH Keys.

Verify:

```bash
ssh -T git@github.com
```

---

# 7. Clone AutoBench98 ✔️

```bash
cd ~
git clone git@github.com:astigmatism/autobench98.git
cd autobench98
```

---

# 8. Install Node.js via NVM ✔️

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install --lts
nvm alias default 'lts/*'
node -v
npm -v
```

---

# 9. Configure Environment Variables ✔️

```bash
cp .env.example .env
nano .env
```

Typical settings:

```
API_PORT=3000
SIDECAR_PORT=3100
LOG_LEVEL=info
DATA_DIR=./data/orchestrator
```

---

# 10. Install Project Dependencies ✔️

```bash
npm install
```

---

# 11. Build AutoBench98 ✔️

```bash
npm -w packages/logging run build
npm -w apps/web run build
```

---

# 12. Start AutoBench98 ✔️

```bash
./start-linux.sh
```

Expected:

```
Orchestrator => http://localhost:3000
Sidecar      => http://localhost:3100
```

---

# 13. Fix Serial Permissions ✔️

```bash
sudo usermod -aG dialout "$USER"
newgrp dialout
```

Verify:

```bash
groups
```

---

# 14. Add FTDI/Prolific udev Rules (recommended) ✔️

### FTDI:

```bash
sudo tee /etc/udev/rules.d/99-ftdi.rules >/dev/null <<EOF
ATTRS{idVendor}=="0403", MODE="0666", GROUP="dialout"
EOF
```

### Prolific:

```bash
sudo tee /etc/udev/rules.d/99-prolific.rules >/dev/null <<EOF
ATTRS{idVendor}=="067b", MODE="0666", GROUP="dialout"
EOF
```

Apply:

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
```

---

# 15. Optional: Synology DSM 7 Reverse Proxy ✔️

To support WebSockets (`/ws`):

Add custom headers:

| Name      | Value               |
|-----------|---------------------|
| Upgrade   | `$http_upgrade`     |
| Connection| `$connection_upgrade` |

---

# 16. Updating AutoBench98 ✔️

```bash
cd ~/autobench98
git pull --rebase
npm install
./start-linux.sh
```

---

# 17. Verification ✔️

Check ports:

```bash
ss -tulpn | grep -E ':(3000|3100)'
```

Test HTTP:

```bash
curl -I http://localhost:3000
```

---

# 18. System Ready

Whether running **Desktop** or **Server**, your Debian 13 system is now fully optimized for:

- Stable FTDI data streaming  
- Zero USB autosuspend  
- No ModemManager interference  
- Proper Node.js runtime  
- Predictable AutoBench98 operation for long benchmark runs  

Enjoy your improved stability!
