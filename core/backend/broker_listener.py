import os
import json
import asyncio
import paho.mqtt.client as mqtt
from dotenv import load_dotenv
from database import get_or_create_device

# Load env variables
load_dotenv()

MQTT_BROKER = os.getenv("MQTT_BROKER", "127.0.0.1")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
MQTT_USER = os.getenv("MQTT_USER")
MQTT_PASS = os.getenv("MQTT_PASS")

# Global variables to handle threading bridge safely
LIVE_STATE_CACHE = {}
on_telemetry_received_callback = None
main_event_loop = None

def on_connect(client, userdata, flags, rc):
    print(f"Connected to Mosquitto Broker at {MQTT_BROKER} with code {rc}")
    client.subscribe("esp32/chipid/+/status")
    client.subscribe("esp32/chipid/+/state")

def on_message(client, userdata, msg):
    try:
        topic_parts = msg.topic.split("/")
        chip_id = topic_parts[2]
        topic_type = topic_parts[3]
        
        if topic_type == "status":
            payload_str = msg.payload.decode("utf-8")
            if payload_str == "alive":
                get_or_create_device(chip_id)
                print(f"📡 Status 'alive' received. Verified node: {chip_id}")

        elif topic_type == "state":
            payload_data = json.loads(msg.payload.decode("utf-8"))
            LIVE_STATE_CACHE[chip_id] = payload_data
            
            # Send live payload over to the websocket dispatcher
            if on_telemetry_received_callback and main_event_loop:
                asyncio.run_coroutine_threadsafe(
                    on_telemetry_received_callback(chip_id, payload_data),
                    main_event_loop
                )
                
    except Exception as e:
        print(f"Error processing incoming MQTT packet on {msg.topic}: {e}")

def start_mqtt_listener(broadcast_callback, loop_reference):
    # FIXED: Added mqtt_client to the global declaration statement
    global on_telemetry_received_callback, main_event_loop, mqtt_client 
    on_telemetry_received_callback = broadcast_callback
    main_event_loop = loop_reference

    # FIXED: Assigning directly to the global variable handle instead of a local 'client'
    mqtt_client = mqtt.Client() 
    if MQTT_USER and MQTT_PASS:
        mqtt_client.username_pw_set(MQTT_USER, MQTT_PASS)
        
    mqtt_client.on_connect = on_connect
    mqtt_client.on_message = on_message

    mqtt_client.connect(MQTT_BROKER, MQTT_PORT, 60)
    mqtt_client.loop_start()

def publish_command(topic: str, payload: str):
    """Reuses our existing authenticated background broker connection client."""
    global mqtt_client
    if mqtt_client and mqtt_client.is_connected():
        mqtt_client.publish(topic, payload)
    else:
        print