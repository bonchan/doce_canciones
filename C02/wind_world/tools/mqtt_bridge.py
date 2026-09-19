#!/usr/bin/env python3
"""
mqtt_bridge.py -- forwards live anemometer readings from MQTT into the
Godot project's WindInput autoload (scripts/wind_input.gd), which listens
for plain UDP text packets: "speed,direction_deg\n" e.g. "3.4,225.0".

Godot never touches the network directly for this: it just has a UDP
socket open. This script is the only thing that needs to know about MQTT,
so if the anemometer's broker, topic or payload shape changes, this is the
one file to edit -- the Godot side is unaffected.

USAGE
  pip install paho-mqtt
  python3 mqtt_bridge.py --broker 192.168.1.50 --topic sensors/wind \
      --speed-field speed --direction-field direction

PAYLOAD FORMATS SUPPORTED (auto-detected per message)
  1. JSON object:      {"speed": 3.4, "direction": 225.0}
     -- field names are configurable with --speed-field/--direction-field,
        for whatever keys your MQTT payload actually uses.
  2. JSON with nested units, e.g. {"wind": {"speed_ms": 3.4, "deg": 225}}
     -- use dotted paths: --speed-field wind.speed_ms --direction-field wind.deg
  3. Plain "speed,direction" text (already the wire format Godot expects)
     -- passed straight through.
  4. Two separate topics, one for speed and one for direction (some
     anemometers publish these independently) -- use --speed-topic and
     --direction-topic instead of --topic, and the bridge remembers the
     latest value of each and forwards a combined packet whenever either
     updates.

UNITS
  If your anemometer reports knots, mph or km/h instead of m/s, pass
  --speed-unit to convert (Godot's WindInput always expects m/s).

  If it reports direction as "wind blowing TOWARD" instead of the more
  common meteorological "wind blowing FROM", pass --direction-mode to.
"""

import argparse
import json
import socket
import sys
import time

try:
	import paho.mqtt.client as mqtt
except ImportError:
	sys.exit(
		"paho-mqtt is required: pip install paho-mqtt --break-system-packages"
	)

SPEED_UNIT_TO_MS = {
	"ms": 1.0,
	"kmh": 1.0 / 3.6,
	"mph": 0.44704,
	"knots": 0.514444,
}


def get_dotted(obj: dict, path: str):
	cur = obj
	for part in path.split("."):
		if not isinstance(cur, dict) or part not in cur:
			return None
		cur = cur[part]
	return cur


class Bridge:
	def __init__(self, args):
		self.args = args
		self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
		self.dest = (args.godot_host, args.godot_port)
		self.last_speed = None
		self.last_direction = None
		self.last_send = 0.0

	def send(self, speed_ms: float, direction_deg: float):
		direction_deg = direction_deg % 360.0
		if self.args.direction_mode == "to":
			# Convert "blowing toward" -> "blowing from" (what Godot expects).
			direction_deg = (direction_deg + 180.0) % 360.0
		packet = f"{speed_ms:.3f},{direction_deg:.2f}"
		self.udp.sendto(packet.encode("utf-8"), self.dest)
		if self.args.verbose:
			print(f"-> {packet}")

	def handle_combined(self, payload: str):
		payload = payload.strip()
		speed = None
		direction = None
		try:
			data = json.loads(payload)
			if isinstance(data, dict):
				speed = get_dotted(data, self.args.speed_field)
				direction = get_dotted(data, self.args.direction_field)
		except (json.JSONDecodeError, TypeError):
			pass
		if speed is None or direction is None:
			# Fall back to "speed,direction" plain text.
			parts = payload.split(",")
			if len(parts) >= 2:
				try:
					speed = float(parts[0])
					direction = float(parts[1])
				except ValueError:
					pass
		if speed is None or direction is None:
			print(f"[warn] could not parse payload: {payload!r}", file=sys.stderr)
			return
		speed_ms = float(speed) * SPEED_UNIT_TO_MS[self.args.speed_unit]
		self.send(speed_ms, float(direction))

	def handle_speed_only(self, payload: str):
		try:
			data = json.loads(payload)
			speed = get_dotted(data, self.args.speed_field) if isinstance(data, dict) else float(payload)
		except (json.JSONDecodeError, TypeError):
			speed = float(payload)
		self.last_speed = float(speed) * SPEED_UNIT_TO_MS[self.args.speed_unit]
		self._maybe_send_split()

	def handle_direction_only(self, payload: str):
		try:
			data = json.loads(payload)
			direction = get_dotted(data, self.args.direction_field) if isinstance(data, dict) else float(payload)
		except (json.JSONDecodeError, TypeError):
			direction = float(payload)
		self.last_direction = float(direction)
		self._maybe_send_split()

	def _maybe_send_split(self):
		if self.last_speed is not None and self.last_direction is not None:
			self.send(self.last_speed, self.last_direction)


def main():
	p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	p.add_argument("--broker", required=True, help="MQTT broker host")
	p.add_argument("--port", type=int, default=1883)
	p.add_argument("--username", default=None)
	p.add_argument("--password", default=None)
	p.add_argument("--topic", default=None, help="single topic carrying both speed+direction")
	p.add_argument("--speed-topic", default=None, help="topic carrying only speed")
	p.add_argument("--direction-topic", default=None, help="topic carrying only direction")
	p.add_argument("--speed-field", default="speed", help="JSON key/dotted-path for speed")
	p.add_argument("--direction-field", default="direction", help="JSON key/dotted-path for direction")
	p.add_argument("--speed-unit", choices=list(SPEED_UNIT_TO_MS.keys()), default="ms")
	p.add_argument("--direction-mode", choices=["from", "to"], default="from",
	               help="does the sensor report the direction wind blows FROM or TO")
	p.add_argument("--godot-host", default="127.0.0.1", help="where Godot (WindInput) is listening")
	p.add_argument("--godot-port", type=int, default=9000)
	p.add_argument("--verbose", action="store_true")
	args = p.parse_args()

	if not args.topic and not (args.speed_topic and args.direction_topic):
		p.error("pass --topic, or both --speed-topic and --direction-topic")

	bridge = Bridge(args)

	def on_connect(client, userdata, flags, rc, properties=None):
		print(f"[mqtt] connected (rc={rc})")
		if args.topic:
			client.subscribe(args.topic)
			print(f"[mqtt] subscribed to {args.topic}")
		else:
			client.subscribe(args.speed_topic)
			client.subscribe(args.direction_topic)
			print(f"[mqtt] subscribed to {args.speed_topic} and {args.direction_topic}")

	def on_message(client, userdata, msg):
		payload = msg.payload.decode("utf-8", errors="replace")
		try:
			if args.topic:
				bridge.handle_combined(payload)
			elif msg.topic == args.speed_topic:
				bridge.handle_speed_only(payload)
			elif msg.topic == args.direction_topic:
				bridge.handle_direction_only(payload)
		except Exception as e:
			print(f"[warn] failed to handle message on {msg.topic!r}: {e}", file=sys.stderr)

	client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2)
	if args.username:
		client.username_pw_set(args.username, args.password)
	client.on_connect = on_connect
	client.on_message = on_message

	print(f"[mqtt] connecting to {args.broker}:{args.port} ...")
	client.connect(args.broker, args.port, keepalive=30)
	print(f"[udp] forwarding to Godot at {args.godot_host}:{args.godot_port}")

	try:
		client.loop_forever()
	except KeyboardInterrupt:
		pass


if __name__ == "__main__":
	main()
