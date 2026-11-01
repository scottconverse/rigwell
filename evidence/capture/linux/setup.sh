#!/bin/bash
# One-time setup as root, while the Windows drive is still mounted. Copies inputs in, then turns
# off Windows drive mounts and Windows program launching for this distro.
set -e
SRC=/mnt/c/Users/scott/AppData/Local/Temp/claude/C--Users-scott-Desktop-Code-rea-work/4a497df5-a669-424d-9416-429e3129dec1/scratchpad
id cap >/dev/null 2>&1 || useradd -m -s /bin/bash cap
mkdir -p /opt/droid /opt/cap
cp "$SRC/droid-linux-pkg/x/package/bin/droid" /opt/droid/droid
chmod 755 /opt/droid/droid
cp "$SRC/capture/linux/fake_anthropic.py" "$SRC/capture/linux/inner.sh" /opt/cap/
sed -i 's/\r$//' /opt/cap/*
chmod 755 /opt/cap/inner.sh
mkdir -p /home/cap/out && chown -R cap:cap /home/cap
cat > /etc/wsl.conf <<'EOF'
[boot]
systemd=false
[automount]
enabled=false
mountFsTab=false
[interop]
enabled=false
appendWindowsPath=false
[user]
default=root
EOF
sha256sum /opt/droid/droid
ls -la /opt/droid /opt/cap
