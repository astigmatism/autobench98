# AutoBench98 Workstation Setup Guide — Debian 13 “Trixie” (Desktop)

## Overview
This guide configures **Debian 13 Desktop** for AutoBench98 when a GUI is present. Includes fixes for GNOME/USB autosuspend and serial device interference.

## 1. Base OS Setup
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git vim net-tools htop byobu openssh-server lsof ffmpeg build-essential python3 make g++ unzip
```

Enable SSH:
```bash
sudo systemctl enable ssh --now
```

---

## 2. Disable GNOME Power Saving (prevents USB dropouts)
Settings → Power:

- Automatic Suspend: **OFF**
- Screen Blank: **Never** (optional)
- Power Mode: **Performance**

---

## 3. Disable USB Autosuspend

### 3.1 Kernel-level disable
```bash
sudo nano /etc/default/grub
```

Modify:
```
GRUB_CMDLINE_LINUX_DEFAULT="quiet splash usbcore.autosuspend=-1"
```

Apply:
```bash
sudo update-grub
sudo reboot
```

---

## 4. Remove ModemManager (interferes with FTDI)
```bash
sudo apt remove --purge modemmanager -y
```

---

## 5. Install Git + Setup SSH Keys
```bash
sudo apt install git -y
ssh-keygen -t ed25519
```

Add key to GitHub → verify:
```bash
ssh -T git@github.com
```

---

## 6. Clone AutoBench98
```bash
cd ~
git clone git@github.com:astigmatism/autobench98.git
cd autobench98
```

---

## 7. Install Node.js (NVM)
```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install --lts
```

---

## 8. Configure .env
```bash
cp .env.example .env
nano .env
```

---

## 9. Install Dependencies + Build
```bash
npm install
npm -w packages/logging run build
npm -w apps/web run build
./start-linux.sh
```

---

## 10. Serial Access Permissions
```bash
sudo usermod -aG dialout "$USER"
```
Reboot or re-log.

---

## 11. Optional: FTDI udev rule for better stability
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

System ready.
