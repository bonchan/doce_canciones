import os
import asyncio
from contextlib import asynccontextmanager

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from dotenv import load_dotenv

import broker
from routes import router, API_KEY
from firebase_pusher import FirebaseDatabasePusher
from logger import logger
import system
import updater

load_dotenv()

# The built webapp (scripts/update.sh runs `pnpm build`), served by this same process so one port
# (8000) gives other computers both the page and the API.
FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"

MQTT_RETRY_DELAY = int(os.getenv("MQTT_RETRY_DELAY", 3))  # seconds between MQTT connect attempts

FIREBASE_CRED_PATH     = os.getenv("FIREBASE_CRED_PATH")
FIREBASE_DATABASE_URL  = os.getenv("FIREBASE_DATABASE_URL")
FIREBASE_INTERVAL_SECS = int(os.getenv("FIREBASE_INTERVAL_SECONDS", 60))

firebase_pusher = None
if FIREBASE_CRED_PATH and FIREBASE_DATABASE_URL:
    firebase_pusher = FirebaseDatabasePusher(
        cred_path=FIREBASE_CRED_PATH,
        database_url=FIREBASE_DATABASE_URL,
        interval_seconds=FIREBASE_INTERVAL_SECS,
    )
    # Only fires on an actual online/offline flip (see broker.Registry._set_online) —
    # record_status_change itself no-ops until firebase_pusher.start() has run.
    broker.registry.on_transition = firebase_pusher.record_status_change


async def _connect_with_retry(loop: asyncio.AbstractEventLoop):
    """Keeps retrying the MQTT connect in the background instead of taking
    the whole app down if the broker isn't reachable yet at boot (systemd
    doesn't guarantee mosquitto is actually ready to accept connections just
    because it's "started"), or if it restarts later on."""
    attempt = 0
    while True:
        attempt += 1
        try:
            await broker.start(loop)
            logger.info(f"MQTT connected (attempt {attempt})")
            return
        except Exception as e:
            logger.error(f"MQTT connect failed (attempt {attempt}): {e} — retrying in {MQTT_RETRY_DELAY}s")
            await asyncio.sleep(MQTT_RETRY_DELAY)


# ── FastAPI app ───────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    if not API_KEY:
        logger.warning("API_KEY not set — command endpoints are open to anyone on the network.")

    loop = asyncio.get_running_loop()
    # Runs as a background task, not awaited here — the REST API and
    # dashboard stay reachable even while MQTT is still coming up or down.
    connect_task = loop.create_task(_connect_with_retry(loop))
    logger.info("brain online (connecting to MQTT in background)")

    if firebase_pusher:
        # A missing or wrong credentials file must not keep the whole app (and the webapp) down
        try:
            await firebase_pusher.start()
        except Exception as e:
            logger.error(f"Firebase sync disabled, could not start it ({FIREBASE_CRED_PATH}): {e}")
    else:
        logger.warning("FIREBASE_CRED_PATH / FIREBASE_DATABASE_URL not set — Firebase sync disabled.")

    update_task = loop.create_task(updater.periodic_check())

    yield

    update_task.cancel()
    if firebase_pusher:
        await firebase_pusher.stop()
    connect_task.cancel()
    broker.stop()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)
app.include_router(system.router)
app.include_router(updater.router)


@app.get("/api/health")
def health():
    """For scripts/watchdog.sh: answering at all means the app isn't hung."""
    return {"ok": True, "mqtt": broker.client.is_connected()}


# Registered last so it never shadows /api or /ws. Any other path is a file of the built webapp, or
# index.html so that reloading /devices or /system works.
@app.get("/{path:path}", include_in_schema=False)
def webapp(path: str):
    if path.startswith(("api/", "ws/")):
        raise HTTPException(404)
    if not FRONTEND_DIST.is_dir():
        raise HTTPException(404, "webapp not built: run scripts/update.sh (or `pnpm build` in frontend/)")
    file = (FRONTEND_DIST / path).resolve()
    if path and file.is_file() and FRONTEND_DIST.resolve() in file.parents:
        return FileResponse(file)
    return FileResponse(FRONTEND_DIST / "index.html")


if __name__ == "__main__":
    # same as the service: IPv6 + IPv4 on port 8000 (see run.py for why not uvicorn --host ::)
    import runpy
    runpy.run_path(str(Path(__file__).with_name("run.py")), run_name="__main__")
