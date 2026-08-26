import os
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Header, HTTPException, Depends
from dotenv import load_dotenv

import broker
import drawing
from broker import registry

load_dotenv()

API_KEY = os.getenv("API_KEY")  # required via X-API-Key header on command endpoints

router = APIRouter()


def require_api_key(x_api_key: Optional[str] = Header(default=None)):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(401, "invalid or missing X-API-Key")


# ── REST ──────────────────────────────────────────────────────────────────
@router.get("/api/devices")
def get_devices():
    return registry.devices


@router.post("/api/devices/{device_id}/command/{capability}", dependencies=[Depends(require_api_key)])
def command_device(device_id: str, capability: str, params: dict = {}):
    try:
        broker.publish_command(device_id, capability, params)
    except KeyError as e:
        raise HTTPException(404, str(e))
    return {"status": "ok"}


@router.post("/api/devices/type/{device_type}/command/{capability}", dependencies=[Depends(require_api_key)])
def command_type(device_type: str, capability: str, params: dict = {}):
    broker.publish_broadcast_command(device_type, capability, params)
    return {"status": "ok"}


@router.post("/api/devices/{device_id}/draw/solar_path", dependencies=[Depends(require_api_key)])
async def draw_solar_path(device_id: str, scale: float = 1.0, date: Optional[str] = None):
    # async on purpose — schedules a background asyncio task, which needs to
    # happen on the event loop's own thread (see drawing.py docstring).
    # scale=1 (default) fills the full working rectangle; e.g. scale=0.5
    # draws the same shape at half size, centered in the same frame.
    # date ("YYYY-MM-DD"), if present, traces that day's sun path instead
    # of today's — omit it (or send nothing) to use today.
    try:
        await drawing.start_solar_path_job(device_id, scale=scale, date=date)
    except drawing.DrawingError as e:
        raise HTTPException(409, str(e))
    return {"status": "ok"}


@router.post("/api/devices/{device_id}/draw/cancel", dependencies=[Depends(require_api_key)])
async def cancel_draw(device_id: str):
    drawing.cancel_job(device_id)
    return {"status": "ok"}


# ── WebSocket ─────────────────────────────────────────────────────────────
@router.websocket("/ws/state")
async def ws_state(websocket: WebSocket):
    await websocket.accept()
    registry.ws_clients.add(websocket)
    await websocket.send_json(registry.snapshot())
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        registry.ws_clients.discard(websocket)
