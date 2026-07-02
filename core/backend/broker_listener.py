import os
import json
import asyncio
import time
import threading
import paho.mqtt.client as mqtt
from dotenv import load_dotenv
import database
import topics

load_dotenv()

MQTT_BROKER  = os.getenv("MQTT_BROKER", "127.0.0.1")
MQTT_PORT    = int(os.getenv("MQTT_PORT", 1883))
MQTT_USER    = os.getenv("MQTT_USER")
MQTT_PASS    = os.getenv("MQTT_PASS")
SAT_TTL      = int(os.getenv("SAT_TTL", 5))
HB_TIMEOUT   = int(os.getenv("DIS_HEARTBEAT_TIMEOUT", 15))




LIVE_STATE_CACHE = {}       # chip_id -> latest telemetry dict
_last_heartbeat  = None     # timestamp of last DIS heartbeat
_mqtt_client     = None
_broadcast_cb    = None
_main_loop       = None

# ── helpers ──────────────────────────────────────────────────────────────────

def _fire(coro):
    if _broadcast_cb and _main_loop:
        asyncio.run_coroutine_threadsafe(coro, _main_loop)

def publish(topic: str, payload: str, retain=False):
    if _mqtt_client and _mqtt_client.is_connected():
        _mqtt_client.publish(topic, payload, retain=retain)

def publish_command(chip_id: str, cmd: str, params: dict = None):
    payload = {"cmd": cmd}
    if params:
        payload["params"] = params
    publish(topics.sat_command(chip_id), json.dumps(payload))

def publish_command_all(cmd: str, params: dict = None):
    payload = {"cmd": cmd}
    if params:
        payload["params"] = params
    publish(topics.SAT_COMMAND_ALL, json.dumps(payload))

def get_merged_state():
    """
    Combines live cache signatures with active TTL thresholds.
    Shared across both local MQTT frames and the Firebase loop.
    """
    now = time.time()
    output = {}
    
    # dict() copy snapshot avoids mid-iteration changes from active threads
    current_cache = dict(LIVE_STATE_CACHE) 
    
    for chip_id, data in current_cache.items():
        entry = dict(data)
        last_ts = entry.pop("_ts", 0)
        entry["online"] = (now - last_ts) < SAT_TTL
        output[chip_id] = entry
        
    return output

def publish_sys_state():
    output = get_merged_state()
    publish(topics.SYS_STATE, json.dumps(output))

def publish_sys_config():
    publish(topics.SYS_CONFIG, json.dumps(database.get_config_payload()), retain=True)


def publish_event(event: dict):
    publish(topics.SYS_EVENT, json.dumps(event))

# ── MQTT callbacks ────────────────────────────────────────────────────────────

def on_connect(client, userdata, flags, rc):
    print(f"Connected to broker ({rc})")
    client.subscribe("esp32/chipid/+/telemetry")
    client.subscribe("esp32/chipid/+/startup")
    client.subscribe(topics.SYS_HEARTBEAT)
    publish_command_all(cmd="ALIVE")
    publish_sys_config()

def on_message(client, userdata, msg):
    global _last_heartbeat
    try:
        parts = msg.topic.split("/")

        # DIS heartbeat
        if msg.topic == topics.SYS_HEARTBEAT:
            _last_heartbeat = time.time()
            return

        if len(parts) < 4:
            return

        chip_id    = parts[2]
        topic_type = parts[3]

        if topic_type == "startup":
            data = json.loads(msg.payload.decode())
            fw_version = data['fw']
            script_name = data['sn']
            database.get_or_create_device(chip_id, fw_version, script_name)
            print(f"startup: {chip_id}, fw: {fw_version}")

        elif topic_type == "telemetry":
            data = json.loads(msg.payload.decode())
            data["_ts"] = time.time()
            LIVE_STATE_CACHE[chip_id] = data
            # database.update_device_telemetry(chip_id, data)
            publish_sys_state()
            _fire(_broadcast_cb(chip_id, data))

    except Exception as e:
        print(f"MQTT error on {msg.topic}: {e}")

# ── heartbeat watchdog ────────────────────────────────────────────────────────

def _heartbeat_watchdog():
    while True:
        time.sleep(5)
        if _last_heartbeat is None:
            print("DIS: never connected")
        elif time.time() - _last_heartbeat > HB_TIMEOUT:
            print(f"DIS: silent for {int(time.time()-_last_heartbeat)}s")

# ── startup ───────────────────────────────────────────────────────────────────

def start_mqtt_listener(broadcast_callback, loop_reference):
    global _mqtt_client, _broadcast_cb, _main_loop
    _broadcast_cb = broadcast_callback
    _main_loop    = loop_reference

    _mqtt_client = mqtt.Client()
    if MQTT_USER and MQTT_PASS:
        _mqtt_client.username_pw_set(MQTT_USER, MQTT_PASS)

    _mqtt_client.on_connect = on_connect
    _mqtt_client.on_message = on_message
    _mqtt_client.connect(MQTT_BROKER, MQTT_PORT, 60)
    _mqtt_client.loop_start()

    threading.Thread(target=_heartbeat_watchdog, daemon=True).start()