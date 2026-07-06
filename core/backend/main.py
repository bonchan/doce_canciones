import os
import asyncio
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import database
import broker_listener
import threading
import adb_watchdog
from firebase_pusher import FirebaseDatabasePusher
from dotenv import load_dotenv

load_dotenv()

# TODO validate that this is still working
FIREBASE_CRED_PATH = os.getenv("FIREBASE_CRED_PATH")
FIREBASE_DATABASE_URL = os.getenv("FIREBASE_DATABASE_URL")

firebase_pusher = FirebaseDatabasePusher(
    cred_path=FIREBASE_CRED_PATH,
    database_url=FIREBASE_DATABASE_URL,
    interval_seconds=60
)


active_connections = []

async def broadcast_to_websocket(chip_id, telemetry):
    # Build merged state same as publish_sys_state
    now = time.time()
    output = {}
    for cid, data in broker_listener.LIVE_STATE_CACHE.items():
        entry = dict(data)
        last_ts = entry.pop("_ts", 0)
        entry["online"] = (now - last_ts) < broker_listener.DEVICE_TTL
        output[cid] = entry

    payload = {
        "type": "STATE_UPDATE",
        "data": output,
    }
    for ws in list(active_connections):
        try:
            await ws.send_json(payload)
        except Exception:
            pass

@asynccontextmanager
async def lifespan(app: FastAPI):
    loop = asyncio.get_running_loop()
    broker_listener.start_mqtt_listener(broadcast_to_websocket, loop)
    time.sleep(5)
    await firebase_pusher.start()
    yield
    await firebase_pusher.stop()

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

# ── REST endpoints ────────────────────────────────────────────────────────────

@app.get("/api/devices")
def read_devices():
    devices = database.get_all_devices()
    for d in devices:
        d["telemetry"] = broker_listener.LIVE_STATE_CACHE.get(d["id"])
    return devices

@app.post("/api/devices/{chip_id}/config")
def save_device_config(chip_id: str, payload: dict):
    pos = payload["position"]
    database.update_device_config(chip_id, payload.get("name"), pos["x"], pos["y"], pos["z"])
    broker_listener.publish_sys_config()
    return {"status": "ok"}

@app.post("/api/devices/{chip_id}/command")
def send_command(chip_id: str, payload: dict):
    cmd    = payload.get("cmd")
    params = payload.get("params", {})
    broker_listener.publish_command(chip_id, cmd, params)
    return {"status": "ok", "cmd": cmd}

@app.post("/api/devices/all/command")
def send_command_all(payload: dict):
    cmd    = payload.get("cmd")
    params = payload.get("params", {})
    broker_listener.publish_command_all(cmd, params)
    return {"status": "ok", "cmd": cmd}

@app.post("/api/events")
def send_event(payload: dict):
    broker_listener.publish_event(payload)
    return {"status": "ok"}

# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/ws/telemetry")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_connections.append(websocket)
    # Send current config immediately on connect
    await websocket.send_json({
        "type": "CONFIG",
        "data": database.get_config_payload()
    })
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        active_connections.remove(websocket)

if __name__ == "__main__":
    # threading.Thread(target=adb_watchdog.watchdog, daemon=True).start()
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)