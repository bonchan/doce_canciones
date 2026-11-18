"""The machine the brain runs on (the NUC): health, services, network, and the restart / reboot buttons.

Everything here reads Linux files or quick commands and returns None where they don't exist (e.g. when
running on a laptop or Windows for development), so the page just leaves those rows out.
"""

import json
import os
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Literal

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import broker
from broker import registry
from logger import logger
from routes import require_api_key

CORE_DIR = Path(__file__).resolve().parent.parent          # core2/
DATA_DIR = Path(os.getenv("DOCE_DATA", str(Path.home() / "doce_canciones_data")))
LOGS_DIR = DATA_DIR / "logs"
# The preferred Wi-Fi (lines "ssid=..." and "password=..."), written by the System page and read by
# scripts/watchdog.sh every minute. Only readable by this user (and root, which the watchdog runs as).
WIFI_FILE = DATA_DIR / "wifi.conf"

BRAIN = "doce-brain"
FILES = "doce-files"
WATCHDOG = "doce-watchdog"
# what the page shows, in this order (the units scripts/update.sh installs, plus the MQTT broker)
SERVICES = [
    (BRAIN, "Backend (this app)"),
    (FILES, "File server"),
    ("mosquitto", "MQTT broker"),
    (f"{WATCHDOG}.timer", "Watchdog"),
]

# --no-block: systemctl only queues the job, so this answer isn't cut short when our own service stops.
# These exact command lines are allowed without a password by /etc/sudoers.d/doce-canciones (install.sh).
POWER_COMMANDS = {
    "restart-app": ["systemctl", "restart", "--no-block", f"{BRAIN}.service"],
    "restart-files": ["systemctl", "restart", "--no-block", f"{FILES}.service"],
    "restart-mqtt": ["systemctl", "restart", "--no-block", "mosquitto.service"],
    "sync-clock": ["systemctl", "restart", "--no-block", "systemd-timesyncd.service"],
    "run-watchdog": ["systemctl", "start", "--no-block", f"{WATCHDOG}.service"],
    "reboot": ["systemctl", "--no-block", "reboot"],
    "poweroff": ["systemctl", "--no-block", "poweroff"],
}

MEMINFO = Path("/proc/meminfo")
UPTIME = Path("/proc/uptime")
STAT = Path("/proc/stat")
THERMAL = Path("/sys/class/thermal")

router = APIRouter(prefix="/api/system", tags=["system"])


def run(*cmd: str, timeout: float = 5) -> str | None:
    """A quick read-only command's output, None when it is missing or fails."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def git_version() -> dict | None:
    out = run("git", "-C", str(CORE_DIR), "log", "-1", "--format=%h%x1f%s%x1f%ct")
    if not out:
        return None
    short, subject, ts = out.split("\x1f", 2)
    return {"short": short, "subject": subject, "time": int(ts)}


def temperature() -> float | None:
    """CPU temperature in °C: the CPU package sensor if there is one (Intel NUC), else the hottest zone."""
    temps: dict[str, float] = {}
    try:
        for zone in THERMAL.glob("thermal_zone*"):
            try:
                kind = (zone / "type").read_text().strip()
                temps[kind] = int((zone / "temp").read_text().strip()) / 1000
            except (OSError, ValueError):
                continue
    except OSError:
        return None
    if not temps:
        return None
    return temps.get("x86_pkg_temp", max(temps.values()))


def memory() -> dict | None:
    """RAM in bytes; used = what new programs could not get (the page cache counts as free)."""
    try:
        kb = {}
        for line in MEMINFO.read_text().splitlines():
            name, _, rest = line.partition(":")
            if rest.split():
                kb[name] = int(rest.split()[0])
        total, available = kb["MemTotal"] * 1024, kb["MemAvailable"] * 1024
    except (OSError, ValueError, KeyError):
        return None
    return {"total": total, "used": total - available}


def cpu_times() -> tuple[int, int] | None:
    try:
        first = STAT.read_text().splitlines()[0]
        user, nice, system_, idle, iowait, irq, softirq, steal = map(int, first.split()[1:9])
    except (OSError, ValueError, IndexError):
        return None
    total = user + nice + system_ + idle + iowait + irq + softirq + steal
    return total - idle - iowait, total


_cpu_last: tuple[float, int, int] | None = None


def cpu_usage() -> float | None:
    """Share of all cores in use since the previous call (the page's polling interval)."""
    global _cpu_last
    now, times = time.time(), cpu_times()
    if times is None:
        return None
    if _cpu_last and 0.5 <= now - _cpu_last[0] <= 60:
        before = _cpu_last[1:]
    else:
        time.sleep(0.5)
        before, now, times = times, time.time(), cpu_times()
        if times is None:
            return None
    _cpu_last = (now, *times)
    busy, total = times[0] - before[0], times[1] - before[1]
    return round(busy / total, 3) if total > 0 else None


def uptime() -> float | None:
    try:
        return float(UPTIME.read_text().split()[0])
    except (OSError, ValueError, IndexError):
        return None


def clock_synced() -> bool | None:
    return {"yes": True, "no": False}.get(run("timedatectl", "show", "--property=NTPSynchronized", "--value") or "")


TIMESYNC_CLOCK = Path("/var/lib/systemd/timesync/clock")    # systemd-timesyncd touches it on every sync


def show(*cmd: str) -> dict:
    """`timedatectl show`-style KEY=value lines as a dict ({} when the command fails)."""
    return dict(line.split("=", 1) for line in (run(*cmd) or "").splitlines() if "=" in line)


def clock() -> dict | None:
    """Whether the clock is set from the internet, and why not: the time service off, no time server
    answering yet, how often it asks, when it last got the time."""
    td = show("timedatectl", "show")
    if not td:
        return None
    ts = show("timedatectl", "show-timesync")       # only with systemd-timesyncd (Ubuntu's default)
    try:
        poll = int(ts.get("PollIntervalUSec", "0")) / 1e6 or None
    except ValueError:
        poll = None
    try:
        last_sync = TIMESYNC_CLOCK.stat().st_mtime
    except OSError:
        last_sync = None
    return {
        "synced": td.get("NTPSynchronized") == "yes",
        "ntp_enabled": td.get("NTP") == "yes",           # `timedatectl set-ntp true` turns it on
        "service": run("systemctl", "is-active", "systemd-timesyncd"),
        "server": ts.get("ServerName") or None,          # empty while no server has answered
        "server_address": ts.get("ServerAddress") or None,
        "poll_interval": poll,
        "last_sync": last_sync,
    }


def split_nmcli(line: str) -> list[str]:
    """nmcli -t separates fields with ':' and writes a ':' inside a value as '\\:'."""
    fields, cur, i = [], "", 0
    while i < len(line):
        if line[i] == "\\" and i + 1 < len(line):
            cur += line[i + 1]
            i += 2
            continue
        if line[i] == ":":
            fields.append(cur)
            cur = ""
        else:
            cur += line[i]
        i += 1
    fields.append(cur)
    return fields


def connections() -> dict[str, dict]:
    """What each interface is connected to, from NetworkManager: type, connection name, and for Wi-Fi the
    network name and signal. {} where there is no NetworkManager (the page then shows addresses only)."""
    result: dict[str, dict] = {}
    for line in (run("nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device") or "").splitlines():
        parts = split_nmcli(line)
        if len(parts) == 4:
            device, kind, state, name = parts
            result[device] = {"type": kind, "state": state, "connection": name or None}
    # the Wi-Fi network in use on each device: "*" in IN-USE (--rescan no: don't scan, just read)
    for line in (run("nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,DEVICE", "device", "wifi", "list",
                     "--rescan", "no") or "").splitlines():
        parts = split_nmcli(line)
        if len(parts) == 4 and parts[0].strip() == "*" and parts[3] in result:
            result[parts[3]]["ssid"] = parts[1] or None
            result[parts[3]]["signal"] = int(parts[2]) if parts[2].isdigit() else None
    return result


def default_route() -> dict | None:
    """The interface the NUC reaches the internet through (lowest metric default route)."""
    out = run("ip", "-j", "route", "show", "default")
    try:
        routes = json.loads(out) if out else []
    except ValueError:
        return None
    if not routes:
        return None
    best = min(routes, key=lambda r: r.get("metric", 0))
    return {"dev": best.get("dev"), "gateway": best.get("gateway")}


def addresses() -> list[dict] | None:
    """Every network interface with its IPv4 and IPv6 addresses, so you can see how to reach the NUC, plus
    what it is connected to (Wi-Fi network and signal, or the wired connection) and whether the internet
    goes through it."""
    out = run("ip", "-j", "addr", "show")
    if not out:
        return None
    try:
        data = json.loads(out)
    except ValueError:
        return None
    conns = connections()
    route = default_route()
    result = []
    for iface in data:
        name = iface.get("ifname", "")
        if name == "lo" or "UP" not in iface.get("flags", []):
            continue
        addrs = [{"family": "ipv4" if a.get("family") == "inet" else "ipv6",
                  "address": a.get("local"), "scope": a.get("scope")}
                 for a in iface.get("addr_info", []) if a.get("family") in ("inet", "inet6")]
        if not addrs:
            continue
        conn = conns.get(name, {})
        kind = conn.get("type") or ("wifi" if Path(f"/sys/class/net/{name}/wireless").exists() else None)
        result.append({
            "name": name,
            "addresses": addrs,
            "type": kind,                                 # "wifi", "ethernet", ...
            "connection": conn.get("connection"),         # NetworkManager's name for it
            "ssid": conn.get("ssid"),
            "signal": conn.get("signal"),                 # Wi-Fi signal, 0-100
            "internet": bool(route and route["dev"] == name),
            "gateway": route["gateway"] if route and route["dev"] == name else None,
        })
    return result


def wifi_settings() -> dict:
    """The preferred Wi-Fi network and its password, as saved from the System page (WIFI_FILE)."""
    values: dict[str, str] = {}
    try:
        for line in WIFI_FILE.read_text(encoding="utf-8").splitlines():
            key, _, value = line.partition("=")
            values.setdefault(key, value)
    except OSError:
        pass
    return {"ssid": values.get("ssid") or None, "password": values.get("password") or None}


def wifi() -> dict | None:
    """The Wi-Fi the watchdog keeps the NUC on and whether it's on it now (never the password itself).
    None where there's no Wi-Fi adapter and nothing set."""
    saved = wifi_settings()
    preferred = saved["ssid"]
    conns = connections()
    device = next((name for name, c in conns.items() if c.get("type") == "wifi"), None)
    if device is None and preferred is None:
        return None
    conn = conns.get(device, {})
    return {
        "preferred": preferred,
        "has_password": saved["password"] is not None,
        "device": device,
        "state": conn.get("state"),                       # "connected", "disconnected", "unavailable", ...
        "ssid": conn.get("ssid"),
        "on_preferred": preferred is not None and conn.get("ssid") == preferred,
    }


def services() -> list[dict] | None:
    """Each service: running or not, since when, and how many times systemd had to restart it."""
    if not shutil.which("systemctl"):
        return None
    up = uptime() or 0
    result = []
    for unit, label in SERVICES:
        out = run("systemctl", "show", unit, "--property=LoadState,ActiveState,SubState,NRestarts,"
                                              "ActiveEnterTimestampMonotonic") or ""
        props = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
        since = None
        try:
            mono = int(props.get("ActiveEnterTimestampMonotonic", "0")) / 1e6
            if mono > 0 and up:
                since = time.time() - (up - mono)
        except ValueError:
            pass
        result.append({
            "unit": unit, "label": label,
            "installed": props.get("LoadState") == "loaded",
            "active": props.get("ActiveState"), "sub": props.get("SubState"),
            "restarts": int(props["NRestarts"]) if props.get("NRestarts", "").isdigit() else None,
            "since": since,
        })
    return result


def watchdog() -> dict:
    """What scripts/watchdog.sh last did: when it last checked, and the restarts it made."""
    last = LOGS_DIR / "watchdog.last"
    log = LOGS_DIR / "watchdog.log"
    try:
        checked_at = last.stat().st_mtime
        state = last.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        checked_at, state = None, None
    try:
        lines = log.read_text(encoding="utf-8", errors="replace").splitlines()[-50:]
    except OSError:
        lines = []
    return {"checked_at": checked_at, "state": state, "log": lines}


def file_server_ok() -> bool:
    try:
        return requests.get(broker.AUDIO_SERVER_URL + "/", timeout=2).ok
    except requests.RequestException:
        return False


def info() -> dict:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    disk = shutil.disk_usage(DATA_DIR)
    cpu = cpu_usage()
    devices = list(registry.devices.values())
    return {
        "hostname": socket.gethostname(),
        "version": git_version(),
        "core_dir": str(CORE_DIR),
        "data_dir": str(DATA_DIR),
        "uptime": uptime(),
        "clock_synced": clock_synced(),
        "clock": clock(),
        "temperature": temperature(),
        "cpu": {"usage": cpu, "cores": os.cpu_count()} if cpu is not None else None,
        "memory": memory(),
        "disk": {"total": disk.total, "used": disk.used, "free": disk.free},
        "network": addresses(),
        "wifi": wifi(),
        "services": services(),
        "watchdog": watchdog(),
        "mqtt": {"connected": broker.client.is_connected(), "broker": f"{broker.MQTT_BROKER}:{broker.MQTT_PORT}"},
        "file_server": {"url": broker.AUDIO_SERVER_URL, "ok": file_server_ok()},
        "devices": {"total": len(devices), "online": sum(1 for d in devices if d.get("online"))},
    }


@router.get("")
def get_system() -> dict:
    return info()


class WifiSettings(BaseModel):
    ssid: str = ""                 # empty: no preferred network
    password: str | None = None    # empty or left out: keep the saved one (same network) / none


@router.post("/wifi", dependencies=[Depends(require_api_key)])
def set_wifi(body: WifiSettings) -> dict:
    """Save the preferred Wi-Fi network and have the watchdog check it right away."""
    ssid = body.ssid.strip()
    password = body.password or None
    if any(c in ssid + (password or "") for c in "\r\n\0"):
        raise HTTPException(422, "line breaks aren't allowed")
    if len(ssid.encode()) > 32:
        raise HTTPException(422, "a Wi-Fi network name is at most 32 bytes")
    if password is not None and not 8 <= len(password) <= 63:
        raise HTTPException(422, "a Wi-Fi (WPA) password is 8 to 63 characters")
    old = wifi_settings()
    if password is None and ssid == old["ssid"]:
        password = old["password"]

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if ssid:
        tmp = WIFI_FILE.with_suffix(".tmp")
        tmp.unlink(missing_ok=True)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)   # created private: it holds the password
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(f"ssid={ssid}\n" + (f"password={password}\n" if password else ""))
        os.replace(tmp, WIFI_FILE)
    else:
        WIFI_FILE.unlink(missing_ok=True)
    logger.warning(f"preferred Wi-Fi set to {ssid!r} from the web page" if ssid else "preferred Wi-Fi cleared")

    # run the watchdog now instead of within the minute
    applied_now = run("sudo", "-n", "-l", *POWER_COMMANDS["run-watchdog"]) is not None
    if applied_now:
        subprocess.Popen(["sudo", "-n", *POWER_COMMANDS["run-watchdog"]],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return {"ssid": ssid or None, "has_password": password is not None, "applied_now": applied_now}


@router.post("/{action}", dependencies=[Depends(require_api_key)])
def power(action: Literal["restart-app", "restart-files", "restart-mqtt", "sync-clock", "run-watchdog",
                          "reboot", "poweroff"]) -> dict:
    """Restart a service, reboot or power off the NUC. Needs the sudoers rule install.sh writes."""
    cmd = ["sudo", "-n", *POWER_COMMANDS[action]]
    check = run("sudo", "-n", "-l", *POWER_COMMANDS[action])
    if check is None:
        raise HTTPException(409, "not allowed: run scripts/install.sh on the NUC (it sets up the sudo rule)")
    logger.warning(f"{action} requested from the web page")
    # a second's delay so this answer reaches the page before anything stops
    subprocess.Popen(["sh", "-c", "sleep 1; exec \"$@\"", "sh", *cmd],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return {"action": action}
