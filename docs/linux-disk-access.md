# Linux Disk Access Configuration for CompactFlash Imager
This guide explains how to allow your Linux user account to access **USB CompactFlash readers** (e.g., `/dev/sdX`, `/dev/sdX1`) **without requiring sudo**.  
These steps are required so the CompactFlash Imager service can run read/write scripts without elevated privileges.

---

## ⚠️ Important Disclaimer
Granting users access to raw block devices is potentially dangerous.  
A user with this access can read/modify any USB mass‑storage device inserted into the system.

This guide **does not** grant access to internal system disks — only USB‑attached storage.

Use only in controlled development environments.

---

# ✅ Overview of Steps
1. Create a dedicated group (e.g., `cfimager`)
2. Add your user to that group
3. Create a persistent **udev rule** to assign correct permissions to USB CF devices
4. Reload udev and reinsert the reader
5. Verify device permissions

After this, your application can run CF Imager scripts **without sudo**.

---

# 1. Create the `cfimager` Group

```bash
sudo groupadd cfimager
```

Add your user to the group:

```bash
sudo usermod -aG cfimager "$USER"
```

Apply the new group to your session:

```bash
newgrp cfimager
```

Verify:

```bash
id -nG "$USER"
```

Expected output includes:

```
cfimager
```

---

# 2. Create a udev Rule for USB CF Readers

Create the rule file:

```bash
sudo nano /etc/udev/rules.d/99-cfimager.rules
```

Paste this:

```text
# Give CF Imager group access to USB CF/SD storage devices
SUBSYSTEM=="block", ENV{ID_BUS}=="usb", MODE="0660", GROUP="cfimager"
```

### What this does:
- Matches **USB mass‑storage** block devices only  
- Prevents unauthorized access to internal drives  
- Assigns group **cfimager** and permissions **0660**  
- Makes `/dev/sdX` writable by your CF Imager scripts

---

# 3. Reload udev

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
```

You may also reinsert the CompactFlash reader to apply new permissions.

---

# 4. Verify Permissions

After reinserting the device:

```bash
ls -l /dev/sd*
```

Example expected output:

```
brw-rw---- 1 root cfimager 8, 0 Jan 10 12:33 /dev/sdb
brw-rw---- 1 root cfimager 8, 1 Jan 10 12:33 /dev/sdb1
```

If you see `cfimager` as the group owner, the setup is correct.

---

# ✔️ Your Application Can Now Access the CF Reader Without sudo

Example (no sudo required):

```bash
./read-image-linux.sh /dev/sdb ~/cf-card.img
```

---

# 🚫 What NOT to Do

### ❌ Do not add your user to the `disk` group  
This grants full access to system disks — unsafe.

### ❌ Do not `chmod` device nodes manually  
They revert automatically when the device is reattached.

### ❌ Do not make udev rules with `MODE="0666"`  
This would allow any user on the system to overwrite disks.

---

# 📄 Version
Prepared for Autobench98 CompactFlash Imager — December 2025
