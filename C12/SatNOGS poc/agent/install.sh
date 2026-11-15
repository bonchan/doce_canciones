#!/usr/bin/env bash
# Sets up a display computer of the installation (Linux Mint / XFCE). Run as the desktop user:
#
#   bash install.sh            the agent: kiosk browsers on the screens + device on core2's bus
#   bash install.sh --server   also the installation server and the SatNOGS listener, for the
#                              computer that runs them (needs Node 20+ and pnpm already installed)
#
# Safe to run again after changing things.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
POC="$(dirname "$HERE")"
WEBAPP="$POC/installationwebapp"
USER_NAME="$(id -un)"
UNITS="$HOME/.config/systemd/user"
SERVER=false
[[ "${1:-}" == "--server" ]] && SERVER=true

echo "== packages"
sudo apt-get update
sudo apt-get install -y --no-install-recommends python3-paho-mqtt x11-xserver-utils smartmontools util-linux
if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null; then
  sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser
fi

echo "== permissions: wake alarm, disk health, power off / reboot"
sudo tee /etc/sudoers.d/satnogs-agent >/dev/null <<EOF
# SatNOGS installation agent ($HERE/agent.py)
$USER_NAME ALL=(root) NOPASSWD: /usr/sbin/rtcwake, /usr/sbin/smartctl, /usr/bin/systemctl poweroff, /usr/bin/systemctl reboot
EOF
sudo chmod 440 /etc/sudoers.d/satnogs-agent
sudo visudo -cf /etc/sudoers.d/satnogs-agent >/dev/null

if [[ ! -f "$HERE/agent.ini" ]]; then
  cp "$HERE/agent.example.ini" "$HERE/agent.ini"
  echo "!! created $HERE/agent.ini: set the broker, this computer's name and its screens, then run again"
fi

echo "== agent service"
mkdir -p "$UNITS"
cat > "$UNITS/satnogs-agent.service" <<EOF
[Unit]
Description=SatNOGS installation agent (kiosk screens + core2 device)
After=graphical-session.target

[Service]
WorkingDirectory=$HERE
ExecStart=/usr/bin/python3 "$HERE/agent.py"
Environment=DISPLAY=:0
Environment=XAUTHORITY=$HOME/.Xauthority
Environment=PYTHONUNBUFFERED=1
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

if $SERVER; then
  echo "== listener and installation server"
  sudo apt-get install -y --no-install-recommends python3-requests python3-dotenv python3-numpy \
    python3-scipy python3-soundfile python3-pil python3-cbor2 python3-sgp4
  NODE_BIN="$(dirname "$(command -v node)")"
  PNPM="$(command -v pnpm)"
  (cd "$WEBAPP" && "$PNPM" install && "$PNPM" build)

  cat > "$UNITS/satnogs-installation.service" <<EOF
[Unit]
Description=SatNOGS installation server (timeline for every display)

[Service]
WorkingDirectory=$WEBAPP
ExecStart="$PNPM" start
Environment=PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

  cat > "$UNITS/satnogs-listener.service" <<EOF
[Unit]
Description=SatNOGS listener (downloads passes)

[Service]
WorkingDirectory=$POC
ExecStart=/usr/bin/python3 "$POC/listener.py"
Environment=PYTHONUNBUFFERED=1
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
EOF
  # run them from boot, not only once someone logs in
  sudo loginctl enable-linger "$USER_NAME"
fi

systemctl --user daemon-reload
systemctl --user enable --now satnogs-agent.service
if $SERVER; then
  systemctl --user enable --now satnogs-installation.service satnogs-listener.service
fi

echo
echo "done. Logs: journalctl --user -u satnogs-agent -f"
$SERVER && echo "      journalctl --user -u satnogs-installation -f / -u satnogs-listener -f"
echo "Set up automatic login (Login Window > Users) so the screens start without a keyboard."
