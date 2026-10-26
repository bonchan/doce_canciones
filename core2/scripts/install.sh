#!/usr/bin/env bash
# One-time setup of the NUC (Ubuntu). Run from the checkout as your normal user, not with sudo:
#   bash core2/scripts/install.sh
# Safe to run again. For later code updates use the System tab's Update button, or by hand:
#   git pull && bash core2/scripts/update.sh
set -euo pipefail

CORE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_MAJOR=22
DATA_DIR="${DOCE_DATA:-$HOME/doce_canciones_data}"

if [ "$(id -u)" = 0 ]; then
  echo "Run this as your normal user (it asks for sudo when it needs it), not as root." >&2
  exit 1
fi

echo "== apt packages"
had_mosquitto=0
dpkg -s mosquitto >/dev/null 2>&1 && had_mosquitto=1
sudo apt-get update
sudo apt-get install -y git curl ca-certificates python3 python3-venv python3-pip \
  avahi-daemon libnss-mdns mosquitto mosquitto-clients iproute2

echo "== MQTT broker"
if [ "$had_mosquitto" = 0 ]; then
  # A fresh mosquitto only listens on this machine; the devices need it on the network.
  echo "mosquitto was just installed: letting devices connect on port 1883 without a password"
  printf 'listener 1883\nallow_anonymous true\n' | sudo tee /etc/mosquitto/conf.d/doce-canciones.conf >/dev/null
  sudo systemctl restart mosquitto
else
  echo "mosquitto was already installed: its configuration is left as it is"
fi
sudo systemctl enable --now mosquitto

echo "== <hostname>.local: answer with the IPv4 address over IPv6 too"
# Some computers (Windows with two networks, for one) only ask over IPv6, and avahi then answers with just
# the link-local IPv6 address, which browsers can't open. This makes it give the IPv4 address as well.
AVAHI_CONF=/etc/avahi/avahi-daemon.conf
if [ -f "$AVAHI_CONF" ] && ! grep -q '^publish-a-on-ipv6=yes' "$AVAHI_CONF"; then
  if grep -q '^#\?publish-a-on-ipv6=' "$AVAHI_CONF"; then
    sudo sed -i 's/^#\?publish-a-on-ipv6=.*/publish-a-on-ipv6=yes/' "$AVAHI_CONF"
  else
    sudo sed -i '/^\[publish\]/a publish-a-on-ipv6=yes' "$AVAHI_CONF"
  fi
fi
sudo systemctl enable --now avahi-daemon
sudo systemctl restart avahi-daemon

echo "== firewall"
if command -v ufw >/dev/null && sudo ufw status | grep -q '^Status: active'; then
  for port in 8000 8090 1883 5353/udp; do sudo ufw allow "$port" >/dev/null; done
  echo "ufw: opened 8000 (webapp), 8090 (file server), 1883 (MQTT), 5353/udp (.local names)"
else
  echo "ufw not active, nothing to open"
fi

echo "== Node $NODE_MAJOR + pnpm"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo corepack enable          # provides pnpm, the version pinned in frontend/package.json

echo "== backend settings"
if [ ! -f "$CORE_DIR/backend/.env" ]; then
  cp "$CORE_DIR/backend/.env.example" "$CORE_DIR/backend/.env"
  echo "!! created core2/backend/.env from .env.example: edit it (API_KEY, Firebase) and run update.sh again"
else
  echo "core2/backend/.env already there"
fi

echo "== old ways of running it"
if systemctl is-active --quiet doce-brain 2>/dev/null; then
  echo "doce-brain is already a service: it gets replaced by the new one"
elif ss -ltn 2>/dev/null | grep -qE '[:.]8000\s'; then
  echo "!! something else already listens on port 8000 (a backend started by hand?). Stop it, or the new"
  echo "   service can't start; the watchdog keeps retrying until the port is free."
fi

echo "== dependencies, webapp build, services"
DOCE_DATA="$DATA_DIR" bash "$CORE_DIR/scripts/update.sh" --no-restart

echo "== start"
sudo systemctl restart doce-brain.service doce-files.service
sudo systemctl restart doce-watchdog.timer

echo
echo "Done. From another computer open:"
echo "  http://$(hostname).local:8000"
for ip in $(hostname -I); do
  case "$ip" in
    fe80:*) ;;                                     # link-local: browsers can't open these
    *:*) echo "  http://[$ip]:8000" ;;
    *)   echo "  http://$ip:8000" ;;
  esac
done
echo "Logs:      journalctl -u doce-brain -f      (also doce-files, doce-watchdog, doce-update)"
echo "Watchdog:  $DATA_DIR/logs/watchdog.log"
