import asyncio
import copy
import time
from datetime import datetime
import firebase_admin
from firebase_admin import credentials, db
import broker
from logger import logger

class FirebaseDatabasePusher:
    def __init__(self, cred_path: str, database_url: str, interval_seconds: int = 60):
        self.cred_path = cred_path
        self.database_url = database_url
        self.interval_seconds = interval_seconds
        self.is_running = False
        self._task = None

    def initialize(self):
        """Initializes the Admin SDK wrapper safely."""
        try:
            # Check if already initialized to prevent application crash on hot-reloads
            firebase_admin.get_app()
            logger.info("🔥 Firebase App already initialized.")
        except ValueError:
            cred = credentials.Certificate(self.cred_path)
            firebase_admin.initialize_app(cred, {
                'databaseURL': self.database_url
            })
            logger.info("🔥 Firebase Admin SDK initialized successfully.")

    async def start(self):
        """Spawns the loop worker as a non-blocking asyncio task thread."""
        if self.is_running:
            return
        
        self.initialize()
        self.is_running = True
        # Schedule the coroutine loop directly onto FastAPI's active loop instance
        self._task = asyncio.create_task(self._loop())
        logger.info(f"🚀 Firebase background loop started (interval_seconds: {self.interval_seconds}s).")

    async def stop(self):
        """Gracefully tears down the loop thread when the FastAPI server stops."""
        if not self.is_running:
            return
        
        self.is_running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("🛑 Firebase background loop stopped cleanly.")

    async def push_snapshot(self):
        """Pushes the current registry to device_snapshot. Called on the
        fixed interval by _loop() below, and also fired immediately on any
        online/offline transition (see record_status_change) so the outside
        view doesn't wait up to interval_seconds to reflect a device going
        up or down."""
        if not self.is_running:
            return
        loop = asyncio.get_event_loop()
        try:
            # Snapshot the registry (deep copy) on the event loop thread
            # before handing it to the executor below — ref.set() runs in a
            # worker thread, and the registry can be mutated by MQTT
            # messages at any time, so it needs an isolated copy rather than
            # a live reference to serialize safely.
            devices_snapshot = copy.deepcopy(broker.registry.devices)

            payload = {
                "last_sync": datetime.utcnow().isoformat(),
                "interval_seconds": self.interval_seconds,
                "devices": devices_snapshot,
            }

            # ref.set() is a blocking network call (firebase_admin has no
            # async client) — run it in the default executor so it can't
            # stall the whole app (MQTT handling, websocket, REST) for
            # however long the request to Firebase takes.
            await loop.run_in_executor(None, db.reference("device_snapshot").set, payload)

        except Exception as e:
            logger.error(f"❌ Firebase sync routine error: {e}")

    async def _loop(self):
        loop = asyncio.get_event_loop()

        while self.is_running:
            start_time = loop.time()
            await self.push_snapshot()

            # Precise interval calculation that accounts for network request latency
            elapsed = loop.time() - start_time
            sleep_duration = max(0.1, self.interval_seconds - elapsed)
            await asyncio.sleep(sleep_duration)

    # ── status-change history ────────────────────────────────────────────
    # Separate from the periodic device_snapshot sync above: this fires once
    # per actual online/offline transition (wired up in main.py to
    # broker.registry.on_transition), not on a timer. Fire-and-forget by
    # design — if Firebase isn't reachable, log it and drop the event. No
    # retry queue, no local buffering yet (may add that later if events
    # start getting lost regularly).
    def record_status_change(self, device: dict):
        if not self.is_running:
            return
        asyncio.ensure_future(self._push_history(device))
        # Also push the snapshot right away rather than waiting for the next
        # interval tick — the two can occasionally race/double up around the
        # interval boundary, which is harmless (both just overwrite the node
        # with a fresh read of the registry).
        asyncio.ensure_future(self.push_snapshot())

    async def _push_history(self, device: dict):
        loop = asyncio.get_event_loop()
        try:
            await loop.run_in_executor(None, self._push_history_sync, device)
        except Exception as e:
            logger.error(f"❌ Firebase history push failed for {device.get('device_id')}: {e}")

    def _push_history_sync(self, device: dict):
        device_id = device["device_id"]
        ref = db.reference(f"device_history/{device_id}")
        # Keep a light, current copy of identifying info alongside the
        # events log, so the timeline view doesn't have to cross-reference
        # device_snapshot (which only holds current, not historical, state).
        ref.child("meta").update({
            "type": device.get("type"),
            "zone": device.get("zone"),
        })
        ref.child("events").push({
            "ts": int(time.time() * 1000),
            "online": device["online"],
        })