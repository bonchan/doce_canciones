import os
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Header, HTTPException, Depends, UploadFile, File
from dotenv import load_dotenv
import requests

import broker
import drawing
import text_path
from broker import registry

load_dotenv()

API_KEY = os.getenv("API_KEY")  # required via X-API-Key header on command endpoints

router = APIRouter()

# ── audio staging ─────────────────────────────────────────────────────────
# Uploaded audio is forwarded straight through to the tiny standalone
# file_server/server.py — deliberately NOT stored or served by this backend
# itself (see that file's docstring for why: the brain can run anywhere,
# but devices need one stable, always-reachable place to download from).
# Run file_server/server.py permanently on the NUC and point this at it —
# defaults to localhost:8090 for the common case of running both on the
# same machine (e.g. the NUC itself, or a laptop with both running locally
# for a quick test).
AUDIO_SERVER_URL = os.getenv("AUDIO_SERVER_URL", "http://127.0.0.1:8090").rstrip("/")

# ESP32 flash is tight (see esp32C3_organismo/organismo_audio.h) — this is
# a sanity cap, not a tuned value; raise it once you know what an actual
# device's LittleFS partition can hold.
MAX_AUDIO_BYTES = 1_900_000


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


@router.post("/api/devices/{device_id}/audio", dependencies=[Depends(require_api_key)])
def upload_audio(device_id: str, file: UploadFile = File(...)):
    # Checked up front rather than relying on publish_command's own KeyError
    # for this one, since by then we'd already have forwarded the file.
    if device_id not in registry.devices:
        raise HTTPException(404, f"unknown device {device_id}")

    # Plain (not async def) on purpose — FastAPI runs a sync path operation
    # in a worker thread automatically, which is what we want here since
    # the requests.put() below to the file server is a blocking call.
    data = file.file.read()
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(413, f"audio file too big ({len(data)} bytes) — {MAX_AUDIO_BYTES} byte limit")

    ext = Path(file.filename or "audio.wav").suffix or ".wav"
    staged_name = f"{device_id}{ext}"  # one file per device — a re-upload before the previous one's ack'd just overwrites it

    try:
        resp = requests.put(f"{AUDIO_SERVER_URL}/{staged_name}", data=data, timeout=20)
        resp.raise_for_status()
    except requests.RequestException as e:
        raise HTTPException(502, f"could not reach the file server at {AUDIO_SERVER_URL}: {e}")

    # Registers this as "awaiting the device's ack" *before* telling the
    # device about it — the ack can only ever help clean up a real staged
    # file this way, never race an unregistered one.
    broker.register_pending_audio(device_id, staged_name)

    url = f"{AUDIO_SERVER_URL}/{staged_name}"
    broker.publish_command(device_id, "AUDIO_UPDATE", {"url": url, "filename": file.filename})

    return {"status": "ok", "url": url}


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


@router.post("/api/devices/{device_id}/draw/text", dependencies=[Depends(require_api_key)])
async def draw_text(
    device_id: str,
    text: str,
    letter_height_mm: float = text_path.DEFAULT_LETTER_HEIGHT_MM,
    font: str = text_path.DEFAULT_FONT,
):
    # async on purpose — same reason as draw_solar_path (schedules a
    # background asyncio task on the event loop's own thread).
    # Starts wherever the gondola currently is, not a fixed frame — see
    # drawing.start_text_job / text_path.py.
    try:
        await drawing.start_text_job(device_id, text, letter_height_mm=letter_height_mm, font=font)
    except drawing.DrawingError as e:
        raise HTTPException(409, str(e))
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
