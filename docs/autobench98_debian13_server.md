# AutoBench98 Workstation Setup Guide — Debian 13 “Trixie” (Server, No GUI)

## Overview

This guide configures a clean **Debian 13 (Trixie) non‑GUI server installation** to run AutoBench98 as a stable, headless benchmark orchestration system. It replaces all Ubuntu‑specific steps and includes Debian‑appropriate serial/FTDI optimizations.

## 1. Base OS Setup

### 1.1 Update system and install essentials

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git vim net-tools htop byobu openssh-server lsof ffmpeg build-essential python3 make g++ unzip
```

### 1.2 Enable SSH (default enabled on server installs)

```bash
sudo systemctl enable ssh
sudo systemctl start ssh
```

### 1.3 Configure static IP using systemd-networkd

Edit:

```bash
sudo nano /etc/systemd/network/20-wired.network
```

Contents:

```
[Match]
Name=en*

[Network]
Address=192.168.1.17/24
Gateway=192.168.1.1
DNS=8.8.8.8 1.1.1.1
```

Apply:

```bash
sudo systemctl restart systemd-networkd
```

---

## 2. Disable Power Saving / USB Autosuspend

### 2.1 Disable autosuspend globally

Edit GRUB:

```bash
sudo nano /etc/default/grub
```

Add to `GRUB_CMDLINE_LINUX_DEFAULT`:

```
usbcore.autosuspend=-1
```

Apply:

```bash
sudo update-grub
sudo reboot
```

---

## 3. Remove ModemManager (interferes with serial devices)

```bash
sudo apt remove --purge modemmanager -y
```

---

## 4. Install Git + GitHub Access

```bash
sudo apt install -y git
ssh-keygen -t ed25519
cat ~/.ssh/id_ed25519.pub
```

Add key to GitHub → test:

```bash
ssh -T git@github.com
```

---

## 5. Clone AutoBench98

```bash
cd ~
git clone git@github.com:astigmatism/autobench98.git
cd autobench98
```

---

## 6. Install Node.js using NVM

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install --lts
nvm alias default 'lts/*'
```

---

## 7. Configure Environment Variables

```bash
cp .env.example .env
nano .env
```

---

## 8. Install Dependencies

```bash
npm install
```

---

## 9. Build and Run

```bash
npm -w packages/logging run build
npm -w apps/web run build
./start-linux.sh
```

---

## 10. Permissions

```bash
sudo usermod -aG dialout "$USER"
newgrp dialout
```

---

## 11. Optional udev rules to stabilize FTDI device

```bash
sudo tee /etc/udev/rules.d/99-ftdi.rules >/dev/null <<EOF
ATTRS{idVendor}=="0403", MODE="0666", GROUP="dialout"
EOF
sudo udevadm control --reload-rules
sudo udevadm trigger
```

---

## 12. Updating AutoBench98

```bash
git pull --rebase
npm install
./start-linux.sh
```

...and more:

sudo apt-get install pv

read the linux-disk-access doc!

System ready.
