import os
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

import broker
from routes import router, API_KEY
from firebase_pusher import FirebaseDatabasePusher
from logger import logger

load_dotenv()

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
        await firebase_pusher.start()
    else:
        logger.warning("FIREBASE_CRED_PATH / FIREBASE_DATABASE_URL not set — Firebase sync disabled.")

    yield

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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
