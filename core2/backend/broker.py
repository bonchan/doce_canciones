import os
import json
import time
import asyncio
from typing import Optional, Callable

import paho.mqtt.client as mqtt
import requests
from dotenv import load_dotenv

from logger import logger
from topics import (
    TOPIC_STATUS_WILD,
    TOPIC_ANNOUNCE_WILD,
    TOPIC_TELEMETRY_WILD,
    TOPIC_CONFIG_WILD,
    TOPIC_AUDIO_ACK_WILD,
    cmd_topic,
    broadcast_topic,
    parse_topic,
)

load_dotenv()

MQTT_BROKER   = os.getenv("MQTT_BROKER", "127.0.0.1")
MQTT_PORT     = int(os.getenv("MQTT_PORT", 1883))
MQTT_USER     = os.getenv("MQTT_USER")
MQTT_PASS     = os.getenv("MQTT_PASS")
STALE_TIMEOUT = int(os.getenv("STALE_TIMEOUT", 15))  # seconds of total silence before we force a device offline
TICK_SECONDS  = 3


# ── registry ──────────────────────────────────────────────────────────────
# In-memory only for now — no persistence layer exists yet in core2. All
# mutation happens on the asyncio loop (see _handle below), so this is safe
# to touch from request handlers directly without extra locking.
class Registry:
    def __init__(self):
        self.devices: dict[str, dict] = {}
        self.ws_clients: set = set()
        # Optional external hook, fired only on an actual online/offline
        # flip (not on every message) — wired up in main.py to the Firebase
        # history pusher, kept out of broker.py itself so this module has no
        # idea Firebase exists.
        self.on_transition: Optional[Callable[[dict], None]] = None

    def _get(self, device_id: str, zone: str) -> dict:
        dev = self.devices.get(device_id)
        if not dev:
            dev = {
                "device_id": device_id,
                "zone": zone,
                "type": None,
                "capabilities": {"publishes": [], "subscribes": []},
                "fw": None,
                "online": False,
                "last_seen": None,
                "telemetry": {},
                "config": {},
                "meta": {},
                "job": None,
            }
            self.devices[device_id] = dev
        return dev

    @staticmethod
    def _seen_ts(retained: bool) -> float:
        """Timestamp to stamp as 'last_seen'. A retained message is a replay
        of whatever was last published — possibly from before a brain or
        broker restart — not proof the device is live right now. Backdating
        it to just past the staleness threshold means a device that's
        actually still connected corrects this within one tick (it publishes
        its own fresh, non-retained confirmation almost immediately), while
        a device that never reconnects gets flagged offline right away
        instead of enjoying a full STALE_TIMEOUT grace period it didn't earn."""
        now = time.time()
        return now - STALE_TIMEOUT if retained else now

    def _set_online(self, dev: dict, online: bool):
        """Updates online state, firing on_transition only when it actually
        flips — the history log should record state changes, not every
        heartbeat that happens to reconfirm the same state."""
        changed = dev["online"] != online
        dev["online"] = online
        if changed and self.on_transition:
            try:
                self.on_transition(dict(dev))
            except Exception as e:
                logger.error(f"on_transition callback failed for {dev['device_id']}: {e}")

    def on_status(self, zone: str, device_id: str, payload: str, retained: bool = False):
        dev = self._get(device_id, zone)
        dev["zone"] = zone
        self._set_online(dev, payload == "online")
        dev["last_seen"] = self._seen_ts(retained)
        logger.info(f"[status] {device_id} -> {payload}{' (retained)' if retained else ''}")

    def on_announce(self, zone: str, device_id: str, data: dict, retained: bool = False):
        dev = self._get(device_id, zone)
        dev["zone"] = zone
        dev["type"] = data.get("type")
        dev["capabilities"] = data.get("capabilities", {"publishes": [], "subscribes": []})
        dev["fw"] = data.get("fw")
        # Anything beyond the standard identity fields is device-specific
        # extra data a sketch chose to advertise (e.g. geometry constants a
        # page needs to scale itself) — passed through as-is rather than
        # hardcoding field names into the registry.
        dev["meta"] = {k: v for k, v in data.items() if k not in ("type", "fw", "sn", "capabilities")}
        dev["last_seen"] = self._seen_ts(retained)
        logger.info(f"[announce] {device_id} type={dev['type']} caps={dev['capabilities']}")

    def on_telemetry(self, zone: str, device_id: str, data: dict, retained: bool = False):
        dev = self._get(device_id, zone)
        dev["zone"] = zone
        dev["telemetry"] = data
        self._set_online(dev, True)
        dev["last_seen"] = self._seen_ts(retained)

    def on_config(self, zone: str, device_id: str, data: dict, retained: bool = False):
        # Not every device type publishes this — only ones with configurable
        # module parameters (currently just esp32C3_organismo, see its
        # organismo_config.h). The device always sends its *whole* current
        # config, not a diff, so replacing outright is correct — this isn't
        # a liveness signal the way telemetry is, so online/last_seen are
        # untouched here.
        dev = self._get(device_id, zone)
        dev["zone"] = zone
        dev["config"] = data
        logger.info(f"[config] {device_id} -> {data}")

    def enforce_staleness(self):
        """Backup net: if a device has been silent (no status, announce, or
        telemetry) for STALE_TIMEOUT seconds, force it offline even if the
        LWT never fired — e.g. broker restart lost the will registration, or
        the device hung without cleanly disconnecting."""
        now = time.time()
        for dev in self.devices.values():
            if dev["online"] and dev["last_seen"] and (now - dev["last_seen"]) > STALE_TIMEOUT:
                self._set_online(dev, False)
                logger.warning(f"[stale] {dev['device_id']} forced offline (silent {STALE_TIMEOUT}s+)")

    def snapshot(self) -> dict:
        return {"type": "STATE", "data": self.devices}

    async def broadcast(self):
        if not self.ws_clients:
            return
        payload = self.snapshot()
        dead = []
        for ws in self.ws_clients:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.ws_clients.discard(ws)


registry = Registry()

# ── audio staging ────────────────────────────────────────────────────────
# device_id -> filename staged on file_server/server.py (routes.py's
# /audio upload endpoint PUTs it there, not to local disk — see that
# file's docstring). Cleared out once the device's audio_ack confirms it
# saved its own copy (see _on_audio_ack below) — this is just bookkeeping
# for that one handoff, not part of the registry's device state.
AUDIO_SERVER_URL = os.getenv("AUDIO_SERVER_URL", "http://127.0.0.1:8090").rstrip("/")

pending_audio: dict[str, str] = {}


def register_pending_audio(device_id: str, filename: str):
    """Called by routes.py's /audio upload endpoint right after staging a
    file on the file server. If that device already had an unacknowledged
    upload (e.g. it was offline, or two uploads happened before the first
    was picked up), the older staged file would otherwise leak there —
    clean it up now instead."""
    old = pending_audio.get(device_id)
    if old and old != filename:
        try:
            requests.delete(f"{AUDIO_SERVER_URL}/{old}", timeout=5)
        except requests.RequestException as e:
            logger.warning(f"could not remove stale staged audio {old} from file server: {e}")
    pending_audio[device_id] = filename


def _on_audio_ack(device_id: str):
    filename = pending_audio.pop(device_id, None)
    if not filename:
        return  # nothing staged — a stale or duplicate ack, nothing to clean up
    try:
        requests.delete(f"{AUDIO_SERVER_URL}/{filename}", timeout=5)
        logger.info(f"[audio_ack] {device_id} confirmed — removed staged {filename} from file server")
    except requests.RequestException as e:
        logger.warning(f"[audio_ack] {device_id} confirmed but couldn't remove {filename} from file server: {e}")


# ── MQTT client ───────────────────────────────────────────────────────────
client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
if MQTT_USER and MQTT_PASS:
    client.username_pw_set(MQTT_USER, MQTT_PASS)

_loop: Optional[asyncio.AbstractEventLoop] = None
_ticker_task: Optional[asyncio.Task] = None


def _handle(zone: str, device_id: str, kind: str, payload_bytes: bytes, retained: bool):
    """Runs on the asyncio loop regardless of which thread the MQTT callback
    fired on (paho runs its network loop on its own thread) — keeps the
    registry single-writer instead of touched from two threads at once."""
    try:
        if kind == "status":
            registry.on_status(zone, device_id, payload_bytes.decode(), retained)
        elif kind == "announce":
            registry.on_announce(zone, device_id, json.loads(payload_bytes), retained)
        elif kind == "telemetry":
            registry.on_telemetry(zone, device_id, json.loads(payload_bytes), retained)
        elif kind == "config":
            registry.on_config(zone, device_id, json.loads(payload_bytes), retained)
        elif kind == "audio_ack":
            _on_audio_ack(device_id)
        else:
            return
    except Exception as e:
        logger.error(f"error handling {kind} from {device_id}: {e}")
        return
    asyncio.ensure_future(registry.broadcast())


def _on_connect(c, userdata, flags, reason_code, properties):
    logger.info(f"MQTT connected (rc={reason_code})")
    c.subscribe(TOPIC_STATUS_WILD)
    c.subscribe(TOPIC_ANNOUNCE_WILD)
    c.subscribe(TOPIC_TELEMETRY_WILD)
    c.subscribe(TOPIC_CONFIG_WILD)
    c.subscribe(TOPIC_AUDIO_ACK_WILD)


def _on_message(c, userdata, msg):
    parsed = parse_topic(msg.topic)
    if not parsed:
        return
    zone, device_id, kind = parsed
    if _loop is None:
        return
    _loop.call_soon_threadsafe(_handle, zone, device_id, kind, msg.payload, msg.retain)


client.on_connect = _on_connect
client.on_message = _on_message


def publish_command(device_id: str, capability: str, params: Optional[dict] = None):
    dev = registry.devices.get(device_id)
    if not dev:
        raise KeyError(f"unknown device {device_id}")
    topic = cmd_topic(dev["zone"], device_id, capability)
    client.publish(topic, json.dumps(params or {}), qos=1)


def publish_broadcast_command(device_type: str, capability: str, params: Optional[dict] = None):
    topic = broadcast_topic(device_type, capability)
    client.publish(topic, json.dumps(params or {}), qos=1)


# ── periodic tick ─────────────────────────────────────────────────────────
# Independent of incoming MQTT traffic — this is what catches a total
# blackout (broker/wifi/NUC drop) where no device ever gets to publish an
# offline message and nothing would otherwise trigger a rebroadcast.
async def _state_ticker():
    while True:
        await asyncio.sleep(TICK_SECONDS)
        registry.enforce_staleness()
        await registry.broadcast()


async def start(loop: asyncio.AbstractEventLoop):
    """Connects to the broker and starts the background tasks. Call once
    from the FastAPI lifespan handler, on the running event loop. Raises if
    the connect attempt fails — callers (main.py) are responsible for
    retrying; the actual socket connect runs in an executor so a slow/failed
    attempt doesn't block the event loop."""
    global _loop, _ticker_task
    _loop = loop
    await loop.run_in_executor(None, client.connect, MQTT_BROKER, MQTT_PORT, 30)
    client.loop_start()
    _ticker_task = loop.create_task(_state_ticker())


def stop():
    if _ticker_task:
        _ticker_task.cancel()
    client.loop_stop()
    client.disconnect()
