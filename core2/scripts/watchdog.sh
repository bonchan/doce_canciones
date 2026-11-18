#!/usr/bin/env bash
# The watchdog: run every minute by doce-watchdog.timer, as root.
#
# systemd already restarts a service whose process dies (Restart=always). This catches the rest: a
# process that is still there but stopped answering (hung), or a service that is stopped or failed.
# A service has to fail two checks in a row before it is restarted, and one that started less than a
# minute ago is left alone. While an update runs nothing is touched (the update restarts things itself).
#
# It also keeps the Wi-Fi connected, to the preferred network set on the System page (see the bottom).
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

# ---- Wi-Fi ----------------------------------------------------------------------------------------
# Keeps the NUC on the preferred Wi-Fi network (set on the System page, saved in $DATA_DIR/wifi.conf):
#  - connected: checks that the router answers; on another network while the preferred one is in range,
#    moves to it (at most every 10 minutes, or right away when the setting was just changed)
#  - down or the router doesn't answer, two checks in a row (or the setting was just changed): Wi-Fi on,
#    rescan, connect to the preferred network (or any saved one); every 5th failed try it restarts
#    NetworkManager instead
# Without a preferred network it only reconnects when there is no internet connection at all.
WIFI_CONF="$DATA_DIR/wifi.conf"
wifi_setting() { sed -n "s/^$1=//p" "$WIFI_CONF" 2>/dev/null | head -n 1; }
WIFI_PREFERRED="$(wifi_setting ssid)"
WIFI_PASSWORD="$(wifi_setting password)"
# changed on the page since the last check: act now instead of waiting
WIFI_FRESH=false
if [ -f "$WIFI_CONF" ] && [ "$WIFI_CONF" -nt "$STATE/wifi.seen" ]; then
  WIFI_FRESH=true
  touch "$STATE/wifi.seen"
fi

# nmcli -t writes ':' inside a value as '\:'
unescape() { sed -e 's/\\:/:/g' -e 's/\\\\/\\/g'; }

# The saved NetworkManager connection for a Wi-Fi network name (usually named like the network, not always)
wifi_profile() {
  local line name
  while IFS= read -r line; do
    [ "${line##*:}" = 802-11-wireless ] || continue
    name="$(printf '%s' "${line%:*}" | unescape)"
    if [ "$(nmcli -g 802-11-wireless.ssid connection show id "$name" 2>/dev/null | unescape)" = "$1" ]; then
      printf '%s' "$name"
      return
    fi
  done < <(nmcli -t -f NAME,TYPE connection show 2>/dev/null)
}

# Make NetworkManager itself prefer that connection and never give up retrying it
prefer() {
  [ -n "$1" ] || return
  if [ "$(nmcli -g connection.autoconnect-priority connection show id "$1" 2>/dev/null)" != 100 ] \
     || [ "$(nmcli -g connection.autoconnect-retries connection show id "$1" 2>/dev/null)" != 0 ]; then
    nmcli connection modify id "$1" connection.autoconnect yes connection.autoconnect-priority 100 \
      connection.autoconnect-retries 0 >/dev/null 2>&1 \
      && log "Wi-Fi: \"$1\" set as the preferred network"
  fi
}

# Wi-Fi on, rescan, connect: the preferred network if there is one, else any network it has saved
wifi_connect() {
  local dev=$1 profile
  command -v rfkill >/dev/null && rfkill unblock wifi 2>/dev/null
  nmcli radio wifi on >/dev/null 2>&1
  nmcli device wifi rescan ifname "$dev" >/dev/null 2>&1
  sleep 5
  if [ -n "$WIFI_PREFERRED" ]; then
    profile="$(wifi_profile "$WIFI_PREFERRED")"
    if [ -n "$profile" ]; then
      # a password set on the page replaces the saved one (it may have changed)
      if [ -n "$WIFI_PASSWORD" ] && [ -n "$(nmcli -g 802-11-wireless-security.key-mgmt connection show id "$profile" 2>/dev/null)" ] \
         && [ "$(nmcli -s -g 802-11-wireless-security.psk connection show id "$profile" 2>/dev/null)" != "$WIFI_PASSWORD" ]; then
        nmcli connection modify id "$profile" 802-11-wireless-security.psk "$WIFI_PASSWORD" >/dev/null 2>&1 \
          && log "Wi-Fi: saved the new password for \"$WIFI_PREFERRED\""
      fi
      nmcli --wait 30 connection up id "$profile" ifname "$dev" >/dev/null 2>&1 && return 0
    elif [ -n "$WIFI_PASSWORD" ]; then          # never connected to it before: this saves it
      if nmcli --wait 30 device wifi connect "$WIFI_PREFERRED" password "$WIFI_PASSWORD" ifname "$dev" >/dev/null 2>&1; then
        prefer "$(wifi_profile "$WIFI_PREFERRED")"
        return 0
      fi
    else                                        # an open network
      nmcli --wait 30 device wifi connect "$WIFI_PREFERRED" ifname "$dev" >/dev/null 2>&1 && return 0
    fi
  fi
  nmcli --wait 30 device connect "$dev" >/dev/null 2>&1
}

wifi_check() {
  command -v nmcli >/dev/null || return
  local dev
  dev="$(nmcli -t -f DEVICE,TYPE device 2>/dev/null | awk -F: '$2 == "wifi" { print $1; exit }')"
  if [ -z "$dev" ]; then
    [ -n "$WIFI_PREFERRED" ] && summary+=("no Wi-Fi adapter found")
    return
  fi
  [ -n "$WIFI_PREFERRED" ] && prefer "$(wifi_profile "$WIFI_PREFERRED")"

  local fails_file="$STATE/wifi.fails" state ssid gw why=""
  state="$(nmcli -g GENERAL.STATE device show "$dev" 2>/dev/null | cut -d' ' -f1)"     # 100 = connected
  ssid="$(nmcli -t -f IN-USE,SSID device wifi list ifname "$dev" --rescan no 2>/dev/null | sed -n 's/^\*://p' | head -n 1 | unescape)"

  if [ "$state" = 100 ]; then
    gw="$(ip -4 route show default dev "$dev" 2>/dev/null | awk '{ print $3; exit }')"
    if [ -n "$gw" ] && ! ping -c 2 -W 2 -I "$dev" "$gw" >/dev/null 2>&1 \
       && ! ip neigh show "$gw" dev "$dev" 2>/dev/null | grep -q REACHABLE; then
      why="connected to \"$ssid\" but the router ($gw) doesn't answer"
    fi
  else
    why="not connected"
  fi

  if [ -z "$why" ]; then
    if [ "$(cat "$fails_file" 2>/dev/null || echo 0)" -ge 2 ]; then log "Wi-Fi back on \"$ssid\""; fi
    rm -f "$fails_file"
    # on another network while the preferred one is in range: move to it, at most every 10 minutes
    if [ -n "$WIFI_PREFERRED" ] && [ "$ssid" != "$WIFI_PREFERRED" ] \
       && { $WIFI_FRESH || [ -z "$(find "$STATE/wifi.switch" -mmin -10 2>/dev/null)" ]; } \
       && nmcli -t -f SSID device wifi list ifname "$dev" --rescan no 2>/dev/null | unescape | grep -qxF -- "$WIFI_PREFERRED"; then
      touch "$STATE/wifi.switch"
      log "Wi-Fi on \"$ssid\" while \"$WIFI_PREFERRED\" is in range: moving to it"
      if wifi_connect "$dev"; then
        summary+=("Wi-Fi moved to \"$WIFI_PREFERRED\"")
      else
        log "Wi-Fi: could not connect to \"$WIFI_PREFERRED\" (next try in 10 minutes)"
        summary+=("Wi-Fi ok (\"$ssid\"; \"$WIFI_PREFERRED\" didn't connect)")
      fi
      return
    fi
    summary+=("Wi-Fi ok (\"$ssid\")")
    return
  fi

  # no preferred network and the internet comes in some other way (a cable): leave Wi-Fi alone
  local route_dev
  route_dev="$(ip -4 route show default 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')"
  if [ -z "$WIFI_PREFERRED" ] && [ -n "$route_dev" ] && [ "$route_dev" != "$dev" ]; then
    rm -f "$fails_file"
    summary+=("Wi-Fi $why (internet through $route_dev)")
    return
  fi

  local fails=$(( $(cat "$fails_file" 2>/dev/null || echo 0) + 1 ))
  echo "$fails" >"$fails_file"
  if [ "$fails" -lt 2 ] && ! $WIFI_FRESH; then
    summary+=("Wi-Fi $why (reconnect on next check)")
  elif [ $((fails % 5)) = 0 ]; then
    log "Wi-Fi still down after $fails checks ($why): restarting NetworkManager"
    systemctl restart NetworkManager
    summary+=("Wi-Fi down, NetworkManager restarted")
  else
    log "Wi-Fi $why: reconnecting"
    if wifi_connect "$dev"; then
      log "Wi-Fi reconnected"
      rm -f "$fails_file"
      summary+=("Wi-Fi reconnected")
    else
      log "Wi-Fi: reconnect failed (try again in a minute)"
      summary+=("Wi-Fi down, reconnect failed")
    fi
  fi
}
wifi_check

(IFS=';'; echo "${summary[*]}" | sed 's/;/ · /g') >"$LOGS/watchdog.last"
