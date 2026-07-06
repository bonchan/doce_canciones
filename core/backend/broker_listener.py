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
DEVICE_TTL      = int(os.getenv("DEVICE_TTL", 10))
# HB_TIMEOUT   = int(os.getenv("DIS_HEARTBEAT_TIMEOUT", 15))




LIVE_STATE_CACHE = {}       # chip_id -> latest telemetry dict

# _last_heartbeat  = None     # timestamp of last DIS heartbeat
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
    publish(topics.system_command(chip_id), json.dumps(payload))

def publish_command_all(cmd: str, params: dict = None):
    payload = {"cmd": cmd}
    if params:
        payload["params"] = params
    publish(topics.SYSTEM_COMMAND_ALL, json.dumps(payload))

def get_merged_state():
    """
    Combines historical database registry with live cache telemetry signatures.
    Ensures offline devices stay visible on installation reboots.
    """
    now = time.time()
    output = {}
    
    # 1. Seed the state tree with all historically registered devices from the DB
    try:
        db_devices = database.get_all_devices()  # Should return a dict or iterable of devices
        for device in db_devices:
            # Adjust mapping based on your database return shape:
            chip_id = device.get("id")
            if chip_id:
                output[chip_id] = {
                    "device_type": device.get("device_type", "unknown"),
                    "online": False,  # Default to offline until live cache proves otherwise
                    "fw": device.get("fw", "unknown"),
                    "sn": device.get("sn", "unknown"),
                    # Add other default fallback parameters your UI expects
                }
    except Exception as e:
        print(f"Database sync fallback error inside get_merged_state: {e}")

    # 2. Layer live runtime values over the database seed
    current_cache = dict(LIVE_STATE_CACHE) 
    
    for chip_id, data in current_cache.items():
        entry = dict(data)
        last_ts = entry.pop("_ts", 0)
        
        # Calculate dynamic online flag against current server clock
        entry["online"] = (now - last_ts) < DEVICE_TTL
        
        # Merge or overwrite the DB base fields with the freshest live telemetry payload
        if chip_id in output:
            output[chip_id].update(entry)
        else:
            output[chip_id] = entry
        
    return output

def publish_sys_state():
    output = get_merged_state()
    publish(topics.SYSTEM_STATE, json.dumps(output))

def publish_sys_config():
    publish(topics.SYSTEM_CONFIG, json.dumps(database.get_config_payload()), retain=True)


def publish_event(event: dict):
    publish(topics.SYSTEM_EVENT, json.dumps(event))

# ── MQTT callbacks ────────────────────────────────────────────────────────────

def on_connect(client, userdata, flags, rc):
    print(f"Connected to broker ({rc})")
    client.subscribe(topics.SATELLITE_TELEMETRY)
    client.subscribe(topics.SATELLITE_STARTUP)

    client.subscribe(topics.DISPLAY_TELEMETRY)
    client.subscribe(topics.DISPLAY_STARTUP)

    # client.subscribe(topics.SYS_HEARTBEAT)
    publish_command_all(cmd="ALIVE")
    publish_sys_config()

def on_message(client, userdata, msg):
    # global _last_heartbeat
    try:
        parts = msg.topic.split("/")

        if len(parts) < 3:
            print("Error in parts", parts)
            return

        device_type = parts[0]
        topic_type  = parts[1]
        chip_id     = parts[2]
        data = json.loads(msg.payload.decode())

        if topic_type == "startup":
            fw_version = data['fw']
            script_name = data['sn']
            database.get_or_create_device(chip_id, fw_version, script_name, device_type)
            # print(f"satellite-startup: {chip_id}, fw: {fw_version}")

        elif topic_type == "telemetry":
            data["_ts"] = time.time()
            LIVE_STATE_CACHE[chip_id] = data
            # database.update_device_telemetry(chip_id, data)
            publish_sys_state()
            _fire(_broadcast_cb(chip_id, data))
            # print(f"satellite-telemetry: {data}")

    except Exception as e:
        print(f"MQTT error on {msg.topic}: {e}")

# ── heartbeat watchdog ────────────────────────────────────────────────────────

# def _heartbeat_watchdog():
#     while True:
#         time.sleep(5)
#         if _last_heartbeat is None:
#             print("DIS: never connected")
#         elif time.time() - _last_heartbeat > HB_TIMEOUT:
#             print(f"DIS: silent for {int(time.time()-_last_heartbeat)}s")

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

    # threading.Thread(target=_heartbeat_watchdog, daemon=True).start()