import os
import json
import threading
from typing import Optional

import paho.mqtt.client as mqtt
from dotenv import load_dotenv

load_dotenv()

MQTT_BROKER = os.getenv("MQTT_BROKER", "127.0.0.1")
MQTT_PORT   = int(os.getenv("MQTT_PORT", 1883))
MQTT_USER   = os.getenv("MQTT_USER")
MQTT_PASS   = os.getenv("MQTT_PASS")


class SimulatedDevice:
    """Base class for a fake device that speaks exactly the same MQTT
    schema a real ESP32 running device_base.h would: same topics, same LWT,
    same retained status/announce, same command handling. The backend can't
    tell it apart from real hardware.

    Subclass this and override `read_telemetry()` to generate values, and
    `on_command()` if the device needs capabilities beyond the shared
    defaults (IDENTIFY / ALTER are handled here already).

    Usage:
        dev = AnemometerSimulator(device_id="SIM-ANEMOMETER-01", zone="outdoor")
        dev.start()   # connect, announce, start publishing telemetry
        ...
        dev.stop()    # graceful — publishes "offline" itself, no LWT
        dev.crash()   # ungraceful — kills the socket, broker fires the LWT
    """

    def __init__(
        self,
        device_id: str,
        zone: str,
        device_type: str,
        capabilities: Optional[dict] = None,
        fw: str = "sim-0.1",
        script_name: Optional[str] = None,
        telemetry_interval: float = 1.0,
        enabled: bool = True,
        broker: str = MQTT_BROKER,
        port: int = MQTT_PORT,
        user: Optional[str] = MQTT_USER,
        password: Optional[str] = MQTT_PASS,
    ):
        self.device_id = device_id
        self.zone = zone
        self.device_type = device_type
        self.capabilities = capabilities or {"publishes": [], "subscribes": ["IDENTIFY", "ALTER"]}
        self.fw = fw
        self.script_name = script_name or device_id
        self.telemetry_interval = telemetry_interval
        # Just a convenience flag the runner script checks before calling
        # start() — doesn't do anything by itself, see run_simulation.py.
        self.enabled = enabled

        self._broker = broker
        self._port = port
        self._user = user
        self._password = password

        # Same topic shape as topics.py / device_base.h.
        self._status_topic     = f"installation/{zone}/{device_id}/status"
        self._announce_topic   = f"installation/{zone}/{device_id}/announce"
        self._telemetry_topic  = f"installation/{zone}/{device_id}/telemetry"
        self._cmd_prefix       = f"installation/{zone}/{device_id}/cmd/"
        self._broadcast_prefix = f"installation/broadcast/{device_type}/cmd/"

        self._client: Optional[mqtt.Client] = None
        self._running = False
        self._telemetry_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    @property
    def is_running(self) -> bool:
        return self._running

    def _build_client(self) -> mqtt.Client:
        """A fresh paho Client every time we (re)connect. mqtt.Client.connect()
        is really meant for the *first* connection — reusing a client object
        that's already been through a disconnect (via stop() or crash()) is
        a known-flaky path in paho, where the previous session's internal
        state doesn't always clear cleanly and on_connect can misbehave.
        Building a brand new client sidesteps that entirely instead of
        relying on paho's reconnect semantics being clean."""
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=self.device_id)
        if self._user and self._password:
            client.username_pw_set(self._user, self._password)
        client.will_set(self._status_topic, payload="offline", qos=1, retain=True)
        client.on_connect = self._on_connect
        client.on_message = self._on_message
        return client

    # ── lifecycle ────────────────────────────────────────────────────────
    def start(self):
        """Connects, publishes retained status/announce (via _on_connect),
        starts the telemetry loop in a background thread."""
        if self._running:
            return
        self._client = self._build_client()
        self._client.connect(self._broker, self._port, keepalive=30)
        self._client.loop_start()
        self._running = True
        print(f"[{self.device_id}] started")

    def stop(self):
        """Graceful shutdown: publishes 'offline' itself and disconnects
        cleanly, so the LWT never fires for this path. Note real hardware
        doesn't really have this mode — a physical device only ever
        disappears via crash() (power loss). This is here purely as a
        convenient way to take a sim device down without exercising the
        LWT/staleness path."""
        if not self._running:
            return
        self._stop_event.set()
        if self._telemetry_thread:
            self._telemetry_thread.join(timeout=2)
        # publish() is non-blocking — without waiting for it to actually go
        # out, disconnect() right after can close the socket before this
        # message is transmitted at all.
        info = self._client.publish(self._status_topic, "offline", qos=1, retain=True)
        info.wait_for_publish(timeout=2)
        self._client.disconnect()
        self._client.loop_stop()
        self._running = False
        self._stop_event.clear()
        print(f"[{self.device_id}] stopped")

    def crash(self):
        """Simulates power loss: yanks the socket without a clean MQTT
        disconnect, so the broker's Last Will fires and publishes
        'offline' on this device's behalf — this is what actually exercises
        the backend's LWT-based offline detection, unlike stop()."""
        if not self._running:
            return
        self._stop_event.set()
        if self._telemetry_thread:
            self._telemetry_thread.join(timeout=2)
        try:
            # Reaching into paho's internals on purpose — there's no public
            # API for "abandon the connection without saying goodbye".
            self._client._sock.close()
        except Exception:
            pass
        self._client.loop_stop()
        self._running = False
        self._stop_event.clear()
        print(f"[{self.device_id}] crashed (LWT should fire 'offline')")

    # ── MQTT plumbing ────────────────────────────────────────────────────
    def _on_connect(self, client, userdata, flags, reason_code, properties):
        client.subscribe(self._cmd_prefix + "#")
        client.subscribe(self._broadcast_prefix + "#")

        client.publish(self._status_topic, "online", qos=1, retain=True)
        client.publish(self._announce_topic, json.dumps({
            "type": self.device_type,
            "fw": self.fw,
            "sn": self.script_name,
            "capabilities": self.capabilities,
        }), qos=1, retain=True)

        self._stop_event.clear()
        self._telemetry_thread = threading.Thread(target=self._telemetry_loop, daemon=True)
        self._telemetry_thread.start()

    def _on_message(self, client, userdata, msg):
        if msg.topic.startswith(self._cmd_prefix):
            capability = msg.topic[len(self._cmd_prefix):]
        elif msg.topic.startswith(self._broadcast_prefix):
            capability = msg.topic[len(self._broadcast_prefix):]
        else:
            return
        if not capability:
            return

        try:
            params = json.loads(msg.payload) if msg.payload else {}
        except json.JSONDecodeError:
            print(f"[{self.device_id}] bad command payload on {msg.topic}")
            return

        self.on_command(capability, params)

    def _telemetry_loop(self):
        while not self._stop_event.is_set():
            data = self.read_telemetry()
            if data:
                data["sim"] = True
                self._client.publish(self._telemetry_topic, json.dumps(data))
            self._stop_event.wait(self.telemetry_interval)

    # ── override in subclasses ──────────────────────────────────────────
    def read_telemetry(self) -> dict:
        """Return this tick's telemetry dict. Override in subclasses —
        base implementation publishes nothing."""
        return {}

    def on_command(self, capability: str, params: dict):
        """Handle an incoming command (capability comes straight off the
        topic, params is the raw payload). Override to add capabilities
        beyond these shared defaults; call super() to keep them."""
        print(f"[{self.device_id}] CMD {capability} {params}")
        if capability == "IDENTIFY":
            duration = params.get("duration", 2000)
            print(f"[{self.device_id}] *blinks* for {duration}ms")
        elif capability == "ALTER":
            duration = params.get("duration", 3000)
            print(f"[{self.device_id}] *altered* for {duration}ms")
