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

import broker
from broker import registry
from logger import logger
from routes import require_api_key

CORE_DIR = Path(__file__).resolve().parent.parent          # core2/
DATA_DIR = Path(os.getenv("DOCE_DATA", str(Path.home() / "doce_canciones_data")))
LOGS_DIR = DATA_DIR / "logs"

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


def addresses() -> list[dict] | None:
    """Every network interface with its IPv4 and IPv6 addresses, so you can see how to reach the NUC."""
    out = run("ip", "-j", "addr", "show")
    if not out:
        return None
    try:
        data = json.loads(out)
    except ValueError:
        return None
    result = []
    for iface in data:
        name = iface.get("ifname", "")
        if name == "lo" or "UP" not in iface.get("flags", []):
            continue
        addrs = [{"family": "ipv4" if a.get("family") == "inet" else "ipv6",
                  "address": a.get("local"), "scope": a.get("scope")}
                 for a in iface.get("addr_info", []) if a.get("family") in ("inet", "inet6")]
        if addrs:
            result.append({"name": name, "addresses": addrs})
    return result


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
        "temperature": temperature(),
        "cpu": {"usage": cpu, "cores": os.cpu_count()} if cpu is not None else None,
        "memory": memory(),
        "disk": {"total": disk.total, "used": disk.used, "free": disk.free},
        "network": addresses(),
        "services": services(),
        "watchdog": watchdog(),
        "mqtt": {"connected": broker.client.is_connected(), "broker": f"{broker.MQTT_BROKER}:{broker.MQTT_PORT}"},
        "file_server": {"url": broker.AUDIO_SERVER_URL, "ok": file_server_ok()},
        "devices": {"total": len(devices), "online": sum(1 for d in devices if d.get("online"))},
    }


@router.get("")
def get_system() -> dict:
    return info()


@router.post("/{action}", dependencies=[Depends(require_api_key)])
def power(action: Literal["restart-app", "restart-files", "restart-mqtt", "reboot", "poweroff"]) -> dict:
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
