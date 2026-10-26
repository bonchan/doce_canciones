#!/usr/bin/env bash
# After `git pull`: refresh dependencies, rebuild the webapp, refresh the services, restart them.
#   bash scripts/update.sh               normal use, as your normal user (asks for your sudo password)
#   bash scripts/update.sh --no-restart  used by install.sh, which starts the services itself
# The Update button on the System tab runs this too, through self_update.sh (as root, see doce-update.service).
set -euo pipefail

CORE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$(id -u)" = 0 ]; then
  APP_USER="${DOCE_USER:?run this as your normal user, not with sudo}"
  APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
  as_user() { runuser -u "$APP_USER" -- env HOME="$APP_HOME" PATH="$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"; }
  as_root() { "$@"; }
else
  APP_USER="$USER"
  APP_HOME="$HOME"
  as_user() { "$@"; }
  as_root() { sudo "$@"; }
fi
DATA_DIR="${DOCE_DATA:-$APP_HOME/doce_canciones_data}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0     # let corepack fetch pnpm without asking

echo "== backend"
as_user bash -c "cd '$CORE_DIR/backend' && { [ -d .venv ] || python3 -m venv .venv; } \
  && .venv/bin/pip install --quiet --upgrade pip && .venv/bin/pip install --quiet -r requirements.txt"

echo "== webapp"
as_user bash -c "cd '$CORE_DIR/frontend' && pnpm install --frozen-lockfile && pnpm build"

echo "== services"
as_user mkdir -p "$DATA_DIR/logs"
UNITS="doce-brain.service doce-files.service doce-watchdog.service doce-watchdog.timer doce-update.service"
for unit in $UNITS; do
  sed -e "s|@USER@|$APP_USER|g" -e "s|@CORE@|$CORE_DIR|g" -e "s|@DATA@|$DATA_DIR|g" \
    "$CORE_DIR/scripts/$unit" | as_root tee "/etc/systemd/system/$unit" >/dev/null
done
as_root systemctl daemon-reload
as_root systemctl enable --quiet doce-brain.service doce-files.service doce-watchdog.timer

echo "== sudo rule for the System tab's buttons"
# Only these exact commands, without a password: start an update, restart a service, reboot, power off.
SYSTEMCTL="$(command -v systemctl)"
RULE="$(mktemp)"
cat >"$RULE" <<EOF
# Written by doce_canciones core2/scripts/update.sh: lets the backend's System tab run these.
$APP_USER ALL=(root) NOPASSWD: $SYSTEMCTL start --no-block doce-update.service, \\
  $SYSTEMCTL restart --no-block doce-brain.service, \\
  $SYSTEMCTL restart --no-block doce-files.service, \\
  $SYSTEMCTL restart --no-block mosquitto.service, \\
  $SYSTEMCTL --no-block reboot, \\
  $SYSTEMCTL --no-block poweroff
EOF
if as_root visudo -cqf "$RULE"; then
  as_root install -m 0440 -o root -g root "$RULE" /etc/sudoers.d/doce-canciones
else
  echo "!! the sudo rule did not validate; the System tab's buttons won't work"
fi
rm -f "$RULE"

if [ "${1:-}" != "--no-restart" ]; then
  echo "== restart"
  as_root systemctl restart doce-brain.service doce-files.service
  as_root systemctl restart doce-watchdog.timer
fi
echo "== updated to $(as_user git -C "$CORE_DIR" rev-parse --short HEAD 2>/dev/null || echo 'uncommitted code')"
