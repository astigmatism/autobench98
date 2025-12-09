# macOS Disk Access Configuration for CompactFlash Imager
This guide explains how to allow your macOS user account to access raw disk devices (`/dev/disk*` and `/dev/rdisk*`) **without requiring sudo**.  
These steps are required so the CompactFlash Imager service can run read/write scripts without elevated privileges.

---

## ⚠️ Important Disclaimer
Granting non-root access to disk devices is powerful and potentially dangerous.  
A user with this access can read or overwrite *any* non-system disk.

Use these steps **only on development machines** or controlled environments.

---

# ✅ Overview of Steps
1. Create a dedicated group (e.g., `diskaccess`)
2. Add your macOS user to this group
3. Define persistent `devfs` rules in `/etc/devfs.rules`
4. Define permissions in `/etc/devfs.conf`
5. Install a `launchd` service to apply the rules at boot
6. Reboot

After reboot, the user will have permission to run CF Imager scripts **without sudo**.

---

# 1. Create the `diskaccess` Group

```bash
sudo dscl . -create /Groups/diskaccess
sudo dscl . -create /Groups/diskaccess PrimaryGroupID 5010
```

Check you used an unused GID:

```bash
dscl . -list /Groups PrimaryGroupID
```

---

# 2. Add Your User to This Group

```bash
sudo dscl . -append /Groups/diskaccess GroupMembership "$USER"
```

Verify:

```bash
id -nG "$USER"
```

Expected output includes:

```
diskaccess
```

---

# 3. Create `/etc/devfs.rules`

This file defines what devices should inherit special permissions.

```bash
sudo nano /etc/devfs.rules
```

Add:

```
[localrules=10]
add path 'disk*' group diskaccess mode 0660
add path 'rdisk*' group diskaccess mode 0660
```

---

# 4. Create `/etc/devfs.conf`

This ensures device permissions persist across boots.

```bash
sudo nano /etc/devfs.conf
```

Add:

```
own disk* root:diskaccess
perm disk* 0660

own rdisk* root:diskaccess
perm rdisk* 0660
```

---

# 5. Create a LaunchDaemon to Apply Rules at Boot

```bash
sudo nano /Library/LaunchDaemons/local.devfs.rules.plist
```

Paste:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
"http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.devfs.rules</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/sbin/devfs</string>
    <string>rule</string>
    <string>-s</string>
    <string>10</string>
    <string>applyset</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
```

Load it immediately:

```bash
sudo launchctl load -w /Library/LaunchDaemons/local.devfs.rules.plist
```

---

# 6. Reboot (Required)

```bash
sudo reboot
```

After reboot, verify permissions:

```bash
ls -l /dev/disk4
```

You should see something like:

```
brw-rw----  1 root  diskaccess  …  /dev/disk4
```

---

# ✔️ macOS is Now Ready for CF Imager Operation Without sudo

Your CompactFlash Imager scripts can now run normally under your user account without elevated privileges.

---

# 📄 Version
Prepared for Autobench98 CompactFlash Imager — December 2025
