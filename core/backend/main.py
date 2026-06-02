import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import database
import broker_listener
import json

active_connections = []

async def broadcast_to_websocket(chip_id, telemetry):
    """Callback triggered from the MQTT thread. Runs inside the async main loop."""
    payload = {
        "type": "TELEMETRY_UPDATE",
        "chip_id": chip_id,
        "data": telemetry,
        "device_meta": database.get_or_create_device(chip_id)
    }
    
    # Send instantly to every connected browser
    for connection in active_connections:
        try:
            await connection.send_json(payload)
        except Exception:
            # Catch disconnected ghost sessions gracefully
            pass

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Capture the core server event loop and share it with the broker listener
    main_loop = asyncio.get_running_loop()
    broker_listener.start_mqtt_listener(broadcast_to_websocket, main_loop)
    yield

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/devices")
def read_devices():
    db_devices = database.get_all_devices()
    # Inject current real-time RAM metrics when page initially updates
    for device in db_devices:
        chip_id = device["id"]
        device["last_seen_telemetry"] = broker_listener.LIVE_STATE_CACHE.get(chip_id, None)
    return db_devices

@app.post("/api/devices/{chip_id}/config")
def save_device_config(chip_id: str, payload: dict):
    c = {
        "x": payload["position"]["x"], 
        "y": payload["position"]["y"], 
        "z": payload["position"]["z"]
    }
    database.update_device_config(
        chip_id, 
        payload.get("name"), 
        payload["position"]["x"], 
        payload["position"]["y"], 
        payload["position"]["z"]
    )
    target_topic = f"esp32/chipid/{chip_id}/config"
    broker_listener.publish_command(target_topic, json.dumps(c))

    return {"status": "success"}

@app.post("/api/devices/{chip_id}/identify")
def identify_device(chip_id: str, payload: dict):
    state = payload.get("state", "off")
    target_topic = f"esp32/chipid/{chip_id}/builtin_led"
    
    # Run the transmission using our existing connection loop instance
    broker_listener.publish_command(target_topic, state)
    
    return {"status": "success", "topic": target_topic, "sent": state}

@app.websocket("/ws/telemetry")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_connections.append(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        active_connections.remove(websocket)