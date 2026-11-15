#!/usr/bin/env python3
"""
SatNOGS installation agent: one per display computer (Linux Mint / XFCE).

  - opens one full-screen kiosk browser per screen listed in agent.ini, and opens it again
    if it closes or crashes
  - is a device on core2's MQTT bus, type computer.satnogs, in the installation's zone:
      telemetry  CPU, memory, temperature, disk health, and for every screen: plugged in,
                 awake or blanked, browser running, and whether its page is actually drawing
                 (asked to the installation server, which hears from every display)
      commands   SCREEN {"on": bool}                 wake / blank the screens
                 BROWSER {"action": "restart"|"stop"|"start"}
                 POWER {"action": "reboot"|"poweroff", "wake": "HH:MM"}
                       poweroff + wake: turns itself back on at that time (BIOS RTC alarm)
                 IDENTIFY / RELOAD                  only this computer's displays
  - optional schedule in agent.ini: off at `off`, back on at `on`, every day

The topics are core2's device contract (core2/arduino/device_base.h):
  installation/<zone>/<id>/status|announce|telemetry, .../cmd/<CAP>,
  installation/broadcast/<type>/cmd/<CAP>

    python3 agent.py            (install.sh sets it up as a service of the desktop user)
"""

import configparser
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

import paho.mqtt.client as mqtt

FW = "0.1.0"
TYPE = "computer.satnogs"
HERE = Path(__file__).resolve().parent
TELEMETRY_SECONDS = 3  # core2 marks a device offline after 15 s of silence
PROFILE_ROOT = Path("/dev/shm/satnogs-kiosk")  # browser profiles in RAM: no writes to the old disks

cfg = configparser.ConfigParser(inline_comment_prefixes=(";", "#"))
cfg.optionxform = str  # keep output names as written (HDMI-1)
if not cfg.read(HERE / "agent.ini"):
    sys.exit(f"missing {HERE / 'agent.ini'} (copy agent.example.ini)")

NAME = cfg.get("mqtt", "name", fallback=socket.gethostname())
ZONE = cfg.get("mqtt", "zone", fallback="satnogs")
SERVER = cfg.get("installation", "url", fallback="http://localhost:5180").rstrip("/")
BROWSER = cfg.get("browser", "command", fallback="chromium")
SCHEDULE_ON = cfg.get("schedule", "on", fallback="").strip()
SCHEDULE_OFF = cfg.get("schedule", "off", fallback="").strip()
DISPLAYS = dict(cfg.items("displays")) if cfg.has_section("displays") else {}  # output -> url query


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def run(*cmd, timeout=5):
    """Output of a command, or None if it isn't there or fails."""
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return None


def machine_id():
    for p in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        try:
            return Path(p).read_text().strip()
        except OSError:
            pass
    return socket.gethostname()


DEVICE_ID = hashlib.sha1(f"{machine_id()}|{NAME}".encode()).hexdigest()[:12].upper()
BASE = f"installation/{ZONE}/{DEVICE_ID}"
CMD_PREFIX = f"{BASE}/cmd/"
BROADCAST_PREFIX = f"installation/broadcast/{TYPE}/cmd/"


# ── screens ──────────────────────────────────────────────────────────────

def outputs():
    """xrandr's outputs: name -> {connected, active, x, y, w, h}. Active = showing a picture
    (it has a mode); a plugged-in output without one is connected but off."""
    text = run("xrandr", "--query") or ""
    found = {}
    for line in text.splitlines():
        m = re.match(r"^(\S+) (connected|disconnected)(?: primary)?(?: (\d+)x(\d+)\+(\d+)\+(\d+))?", line)
        if not m:
            continue
        name, state, w, h, x, y = m.groups()
        found[name] = {
            "connected": state == "connected",
            "active": w is not None,
            "x": int(x or 0), "y": int(y or 0), "w": int(w or 0), "h": int(h or 0),
        }
    return found


def power_state():
    """The X server's screen power: on, off, standby, suspend (DPMS), None if unknown."""
    m = re.search(r"Monitor is (?:in )?(\w+)", run("xset", "q") or "")
    return m.group(1).lower() if m else None


def keep_awake():
    """No screen saver or idle blanking: the installation is always on screen. SCREEN off still
    blanks them (DPMS stays available, only its timeouts are off)."""
    run("xset", "s", "off")
    run("xset", "s", "noblank")
    run("xset", "dpms", "0", "0", "0")


def set_screens(on: bool):
    if on:
        run("xset", "dpms", "force", "on")
        run("xset", "s", "reset")
    else:
        run("xset", "dpms", "force", "off")


# ── kiosk browsers ───────────────────────────────────────────────────────

def display_id(output):
    return f"{NAME}-{output}"


class Kiosks:
    """One full-screen browser per configured screen, opened again when it exits."""

    def __init__(self):
        self.procs: dict[str, subprocess.Popen] = {}
        self.restarts: dict[str, list[float]] = {}
        self.wanted = True
        self.lock = threading.Lock()

    def url(self, output, query):
        return f"{SERVER}/?{query}&id={display_id(output)}"

    def open(self, output, query, geo):
        profile = PROFILE_ROOT / output
        profile.mkdir(parents=True, exist_ok=True)
        cmd = [
            BROWSER,
            f"--user-data-dir={profile}",
            f"--disk-cache-dir={profile / 'cache'}",
            f"--window-position={geo['x']},{geo['y']}",
            f"--window-size={geo['w'] or 1280},{geo['h'] or 720}",
            "--kiosk",
            "--no-first-run",
            "--no-default-browser-check",
            "--noerrdialogs",
            "--disable-infobars",
            "--disable-session-crashed-bubble",
            "--disable-features=Translate",
            "--autoplay-policy=no-user-gesture-required",
            "--disable-background-networking",
            "--disable-component-update",
            "--password-store=basic",
            self.url(output, query),
        ]
        log("open", output, cmd[-1])
        self.procs[output] = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                              start_new_session=True)

    def tick(self):
        """Opens what should be open: called every few seconds."""
        if not self.wanted:
            return
        with self.lock:
            screens = outputs()
            for output, query in DISPLAYS.items():
                proc = self.procs.get(output)
                if proc and proc.poll() is None:
                    continue
                geo = screens.get(output)
                if not geo or not geo["active"]:
                    continue  # that screen isn't there: nothing to open on it
                # at most 5 restarts a minute, so a browser that can't start doesn't spin
                times = [t for t in self.restarts.get(output, []) if t > time.time() - 60]
                if len(times) >= 5:
                    continue
                self.restarts[output] = times + [time.time()]
                self.open(output, query, geo)

    def running(self, output):
        proc = self.procs.get(output)
        return bool(proc and proc.poll() is None)

    def stop(self):
        with self.lock:
            for output, proc in self.procs.items():
                if proc.poll() is None:
                    try:
                        os.killpg(proc.pid, signal.SIGTERM)
                    except OSError:
                        pass
            for proc in self.procs.values():
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except OSError:
                        pass
            self.procs.clear()


kiosks = Kiosks()


# ── the installation server: is each page drawing? ───────────────────────

def server_displays():
    """id -> the server's report on that display (showing, fps, errors), {} if unreachable."""
    try:
        with urllib.request.urlopen(f"{SERVER}/api/displays", timeout=2) as r:
            return {d["id"]: d for d in json.load(r)}
    except (OSError, ValueError):
        return {}


def server_command(action):
    ids = [display_id(o) for o in DISPLAYS]
    body = json.dumps({"action": action, "ids": ids}).encode()
    req = urllib.request.Request(f"{SERVER}/api/command", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=3).close()
    except OSError as e:
        log(f"{action}: installation server unreachable ({e})")


# ── the computer ─────────────────────────────────────────────────────────

_cpu_last = None


def cpu_percent():
    global _cpu_last
    try:
        fields = [int(x) for x in Path("/proc/stat").read_text().splitlines()[0].split()[1:]]
    except (OSError, ValueError):
        return None
    idle, total = fields[3] + fields[4], sum(fields)
    last, _cpu_last = _cpu_last, (idle, total)
    if not last or total == last[1]:
        return None
    return round(100 * (1 - (idle - last[0]) / (total - last[1])), 1)


def memory_percent():
    try:
        info = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
        total = int(info["MemTotal"].split()[0])
        available = int(info["MemAvailable"].split()[0])
        return round(100 * (1 - available / total), 1)
    except (OSError, KeyError, ValueError):
        return None


def temperature():
    temps = []
    for zone in Path("/sys/class/thermal").glob("thermal_zone*/temp"):
        try:
            temps.append(int(zone.read_text()) / 1000)
        except (OSError, ValueError):
            pass
    return round(max(temps), 1) if temps else None


def uptime():
    try:
        return int(float(Path("/proc/uptime").read_text().split()[0]))
    except (OSError, ValueError):
        return None


def ip_address():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # no packet is sent: picks the outgoing interface
            return s.getsockname()[0]
    except OSError:
        return None


_disk = {"checked": 0.0, "health": None}


def disk_health():
    """smartctl's verdict on the system disk (ok / failing), checked every 10 minutes. Needs
    the sudoers line install.sh adds; None if that or smartctl isn't there."""
    if time.time() - _disk["checked"] > 600:
        _disk["checked"] = time.time()
        root = run("findmnt", "-n", "-o", "SOURCE", "/") or ""
        disk = re.sub(r"p?\d+$", "", root.strip()) or "/dev/sda"
        # not run(): smartctl's exit code is a bit mask that is non-zero for mere warnings
        try:
            out = subprocess.run(["sudo", "-n", "smartctl", "-H", disk], capture_output=True,
                                 text=True, timeout=20).stdout
        except (OSError, subprocess.SubprocessError):
            out = ""
        if "SMART" not in out:
            _disk["health"] = None  # no smartctl, no sudoers line, or a disk without SMART
        elif "PASSED" in out or "OK" in out:
            _disk["health"] = "ok"
        else:
            _disk["health"] = "failing"
    return _disk["health"]


# ── power ────────────────────────────────────────────────────────────────

def next_time(hhmm):
    """The next datetime at HH:MM (today if still ahead, else tomorrow)."""
    h, m = (int(x) for x in hhmm.split(":"))
    now = datetime.now()
    at = now.replace(hour=h, minute=m, second=0, microsecond=0)
    return at if at > now else at + timedelta(days=1)


def set_wake(hhmm):
    """BIOS alarm: the computer turns itself on at HH:MM. Needs rtcwake via sudo (install.sh)."""
    at = next_time(hhmm)
    if run("sudo", "-n", "rtcwake", "-m", "no", "-t", str(int(at.timestamp()))) is None:
        log(f"could not set the wake alarm for {at:%Y-%m-%d %H:%M}: is the sudoers line installed?")
        return None
    log(f"wake alarm set for {at:%Y-%m-%d %H:%M}")
    return at


def power(action, wake=None):
    if action not in ("reboot", "poweroff"):
        return
    if wake:
        set_wake(wake)
    log(f"power: {action}")
    kiosks.wanted = False
    kiosks.stop()
    device.goodbye()
    # systemctl works for the user on the screen; sudo -n is the fallback (install.sh allows it)
    if run("systemctl", action, timeout=15) is None:
        run("sudo", "-n", "systemctl", action, timeout=15)


# ── MQTT ─────────────────────────────────────────────────────────────────

SUBSCRIBES = ["SCREEN", "BROWSER", "POWER", "IDENTIFY", "RELOAD"]


class Device:
    def __init__(self):
        kwargs = {"client_id": f"{NAME}-{DEVICE_ID}"}
        # paho 2.x wants the callback API version; the 1.6 that Mint's apt has doesn't know it
        if hasattr(mqtt, "CallbackAPIVersion"):
            self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, **kwargs)
        else:
            self.client = mqtt.Client(**kwargs)
        user = cfg.get("mqtt", "username", fallback="")
        if user:
            self.client.username_pw_set(user, cfg.get("mqtt", "password", fallback=""))
        self.client.will_set(f"{BASE}/status", "offline", qos=1, retain=True)
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message
        self.client.reconnect_delay_set(min_delay=2, max_delay=30)
        self.publishes = []

    def start(self):
        broker = cfg.get("mqtt", "broker", fallback="localhost")
        port = cfg.getint("mqtt", "port", fallback=1883)
        self.client.connect_async(broker, port, keepalive=30)
        self.client.loop_start()
        log(f"device {TYPE} {DEVICE_ID} zone {ZONE} -> {broker}:{port}")

    def on_connect(self, client, *args):
        log("mqtt connected")
        client.subscribe([(f"{CMD_PREFIX}#", 1), (f"{BROADCAST_PREFIX}#", 1)])
        client.publish(f"{BASE}/status", "online", qos=1, retain=True)
        announce = {
            "type": TYPE,
            "fw": FW,
            "sn": NAME,
            "capabilities": {"publishes": self.publishes, "subscribes": SUBSCRIBES},
            "screens": list(DISPLAYS),
            "schedule": {"on": SCHEDULE_ON, "off": SCHEDULE_OFF} if SCHEDULE_ON and SCHEDULE_OFF else None,
            "server": SERVER,
        }
        client.publish(f"{BASE}/announce", json.dumps(announce), qos=1, retain=True)

    def on_message(self, client, userdata, msg):
        topic = msg.topic
        if topic.startswith(CMD_PREFIX):
            cap = topic[len(CMD_PREFIX):]
        elif topic.startswith(BROADCAST_PREFIX):
            cap = topic[len(BROADCAST_PREFIX):]
        else:
            return
        try:
            params = json.loads(msg.payload or b"{}")
            if not isinstance(params, dict):
                params = {}
        except ValueError:
            params = {}
        log("CMD", cap, params)
        # off the network thread: power and browser restarts take a while
        threading.Thread(target=handle, args=(cap, params), daemon=True).start()

    def publish(self, telemetry):
        if self.client.is_connected():
            self.client.publish(f"{BASE}/telemetry", json.dumps(telemetry))

    def goodbye(self):
        if self.client.is_connected():
            try:
                self.client.publish(f"{BASE}/status", "offline", qos=1, retain=True).wait_for_publish(2)
            except (RuntimeError, ValueError, TypeError):
                pass  # the last will says it anyway


def handle(cap, params):
    if cap == "SCREEN":
        set_screens(bool(params.get("on", True)))
    elif cap == "BROWSER":
        action = params.get("action", "restart")
        if action in ("restart", "stop"):
            kiosks.wanted = False
            kiosks.stop()
        if action in ("restart", "start"):
            kiosks.wanted = True
            kiosks.restarts.clear()
            kiosks.tick()
    elif cap == "POWER":
        wake = params.get("wake")
        power(params.get("action", ""), wake if isinstance(wake, str) and re.match(r"^\d{1,2}:\d{2}$", wake) else None)
    elif cap == "IDENTIFY":
        server_command("identify")
    elif cap == "RELOAD":
        server_command("reload")


device = Device()


def telemetry():
    screens = outputs()
    reports = server_displays()
    dpms = power_state()
    rows = []
    for output, query in DISPLAYS.items():
        geo = screens.get(output, {})
        report = reports.get(display_id(output))
        rows.append({
            "output": output,
            "view": query,
            "connected": bool(geo.get("connected")),
            "active": bool(geo.get("active")),
            "power": dpms,  # the X server blanks every screen together
            "browser": kiosks.running(output),
            "page": report is not None,  # its page is connected to the installation server
            "showing": bool(report and report.get("showing")) and dpms in (None, "on"),
            "fps": report.get("fps") if report else None,
            "errors": report.get("errors") if report else None,
        })
    return {
        "host": socket.gethostname(),
        "ip": ip_address(),
        "uptime": uptime(),
        "cpu": cpu_percent(),
        "memory": memory_percent(),
        "temperature": temperature(),
        "disk": disk_health(),
        "server": bool(reports) or None,
        "screens": rows,
        "screens_total": len(rows),
        "screens_showing": sum(1 for r in rows if r["showing"]),
        "browsers": kiosks.wanted,
        "schedule": f"{SCHEDULE_ON}-{SCHEDULE_OFF}" if SCHEDULE_ON and SCHEDULE_OFF else None,
    }


_last_off = {"day": None}


def scheduled_off():
    """At the `off` minute of the schedule: power off, waking up at `on`. Once a day."""
    if not (SCHEDULE_ON and SCHEDULE_OFF):
        return
    now = datetime.now()
    if now.strftime("%H:%M") == next_time(SCHEDULE_OFF).strftime("%H:%M") and _last_off["day"] != now.date():
        _last_off["day"] = now.date()
        power("poweroff", SCHEDULE_ON)


def main():
    if shutil.which(BROWSER) is None:
        log(f"browser '{BROWSER}' not found: set [browser] command in agent.ini")
    # browsers left over from an agent that died: their profiles are ours, start clean
    run("pkill", "-f", str(PROFILE_ROOT))
    device.publishes = list(telemetry().keys())
    device.start()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    awake_at = 0.0
    try:
        while True:
            if time.time() - awake_at > 60:
                keep_awake()  # again now and then: XFCE's power manager may set its own timeouts
                awake_at = time.time()
            kiosks.tick()
            device.publish(telemetry())
            scheduled_off()
            time.sleep(TELEMETRY_SECONDS)
    finally:
        kiosks.stop()
        device.goodbye()


if __name__ == "__main__":
    main()
