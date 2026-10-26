#!/usr/bin/env bash
# The watchdog: run every minute by doce-watchdog.timer, as root.
#
# systemd already restarts a service whose process dies (Restart=always). This catches the rest: a
# process that is still there but stopped answering (hung), or a service that is stopped or failed.
# A service has to fail two checks in a row before it is restarted, and one that started less than a
# minute ago is left alone. While an update runs nothing is touched (the update restarts things itself).
#
# To keep it from restarting things while you work on the NUC by hand:  touch $DOCE_DATA/watchdog.pause
set -uo pipefail

DATA_DIR="${DOCE_DATA:-/var/lib/doce_canciones}"
LOGS="$DATA_DIR/logs"
STATE=/run/doce-watchdog          # failure counters; cleared on reboot
mkdir -p "$STATE"
if [ ! -d "$LOGS" ]; then
  mkdir -p "$LOGS"
  chown "$(stat -c %U:%G "$DATA_DIR")" "$LOGS"
fi

log() {
  echo "$(date '+%F %T') $*" >>"$LOGS/watchdog.log"
  echo "$*"                                   # also in: journalctl -u doce-watchdog
  # keep the log short
  if [ "$(wc -l <"$LOGS/watchdog.log")" -gt 1000 ]; then
    tail -n 500 "$LOGS/watchdog.log" >"$LOGS/watchdog.log.tmp" && mv "$LOGS/watchdog.log.tmp" "$LOGS/watchdog.log"
  fi
}

if [ -e "$DATA_DIR/watchdog.pause" ]; then
  echo "paused ($DATA_DIR/watchdog.pause exists)" >"$LOGS/watchdog.last"
  exit 0
fi
if systemctl is-active --quiet doce-update; then
  echo "update running, nothing checked" >"$LOGS/watchdog.last"
  exit 0
fi

summary=()

# check <unit> <label> <command that succeeds when it is healthy>
check() {
  local unit=$1 label=$2; shift 2
  local fails_file="$STATE/$unit.fails"

  if ! systemctl cat "$unit" >/dev/null 2>&1; then
    summary+=("$label not installed")
    return
  fi

  local active
  active="$(systemctl is-active "$unit")"
  if [ "$active" = activating ] || [ "$active" = deactivating ]; then
    summary+=("$label $active")
    return
  fi

  # started less than 60 s ago: still coming up
  if [ "$active" = active ]; then
    local since now_mono
    since="$(systemctl show "$unit" --property=ActiveEnterTimestampMonotonic --value)"
    now_mono="$(awk '{printf "%d", $1 * 1000000}' /proc/uptime)"
    if [ -n "$since" ] && [ "$since" -gt 0 ] && [ $((now_mono - since)) -lt 60000000 ]; then
      summary+=("$label starting")
      return
    fi
  fi

  if [ "$active" = active ] && "$@" >/dev/null 2>&1; then
    rm -f "$fails_file"
    summary+=("$label ok")
    return
  fi

  local fails=$(( $(cat "$fails_file" 2>/dev/null || echo 0) + 1 ))
  echo "$fails" >"$fails_file"
  if [ "$active" != active ] || [ "$fails" -ge 2 ]; then
    if [ "$active" != active ]; then
      log "$label ($unit) is $active: starting it"
    else
      log "$label ($unit) did not answer twice in a row: restarting it"
    fi
    systemctl reset-failed "$unit" 2>/dev/null || true
    systemctl restart "$unit"
    rm -f "$fails_file"
    summary+=("$label restarted")
  else
    summary+=("$label not answering (restart on next failure)")
  fi
}

check doce-brain Backend curl -fsS -m 10 -o /dev/null http://127.0.0.1:8000/api/health
check doce-files "File server" curl -fsS -m 10 -o /dev/null http://127.0.0.1:8090/
check mosquitto MQTT timeout 5 bash -c '</dev/tcp/127.0.0.1/1883'

(IFS=';'; echo "${summary[*]}" | sed 's/;/ · /g') >"$LOGS/watchdog.last"
