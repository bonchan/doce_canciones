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

            # The System tab's data (the NUC's health, services, watchdog, updates). Read in a worker
            # thread: it runs commands and asks the file server, which take a moment.
            try:
                system_snapshot = await loop.run_in_executor(None, self._system_snapshot)
            except Exception as e:
                logger.error(f"❌ Firebase: could not read the system status: {e}")
                system_snapshot = None

            payload = {
                "last_sync": datetime.utcnow().isoformat(),
                "interval_seconds": self.interval_seconds,
                "devices": devices_snapshot,
                "system": system_snapshot,
            }

            # ref.set() is a blocking network call (firebase_admin has no
            # async client) — run it in the default executor so it can't
            # stall the whole app (MQTT handling, websocket, REST) for
            # however long the request to Firebase takes.
            await loop.run_in_executor(None, db.reference("device_snapshot").set, payload)

        except Exception as e:
            logger.error(f"❌ Firebase sync routine error: {e}")

    @staticmethod
    def _system_snapshot() -> dict:
        """What the webapp's System tab shows, plus where updates stand (the last check, no network).
        Imported here, not at the top: system imports routes, which the app wires up first."""
        import system
        import updater
        info = system.info()
        # the last check with GitHub; right after a restart, the local checkout until that first check
        u = dict(updater._cache) or updater.check(fetch=False)
        info["update"] = {
            "checked_at": u.get("checked_at"),
            "current": u.get("current"),
            "branch": u.get("branch"),
            "upstream": u.get("upstream"),
            "behind": u.get("behind", 0),
            "app_changes": u.get("app_changes", 0),
            "commits": [{k: c[k] for k in ("short", "subject", "author", "time", "affects_app")}
                        for c in u.get("commits", [])[:20]],
            "error": u.get("error"),
            "running": updater.running(),
            "last_result": (updater.last_run() or {}).get("result"),
        }
        info["watchdog"]["log"] = info["watchdog"]["log"][-20:]
        return info

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

    # ── deleted devices ──────────────────────────────────────────────────
    # Wired up in main.py to broker.registry.on_deleted. The deleted devices'
    # timelines go; with clear_all_history the whole timeline restarts, each
    # remaining device starting from its current state. The snapshot is pushed
    # right away so the Home tab drops them too.
    def record_deleted(self, device_ids: list, clear_all_history: bool):
        if not self.is_running:
            return
        remaining = [dict(d) for d in broker.registry.devices.values()] if clear_all_history else []
        asyncio.ensure_future(self._delete_history(device_ids, clear_all_history, remaining))

    async def _delete_history(self, device_ids: list, clear_all_history: bool, remaining: list):
        loop = asyncio.get_event_loop()
        try:
            await loop.run_in_executor(None, self._delete_history_sync, device_ids, clear_all_history, remaining)
        except Exception as e:
            logger.error(f"❌ Firebase: deleting history failed: {e}")
        await self.push_snapshot()

    def _delete_history_sync(self, device_ids: list, clear_all_history: bool, remaining: list):
        if clear_all_history:
            db.reference("device_history").delete()
            for device in remaining:
                self._push_history_sync(device)
            logger.warning(f"Firebase: timeline history cleared, restarted for {len(remaining)} device(s)")
        else:
            for device_id in device_ids:
                db.reference(f"device_history/{device_id}").delete()
        if device_ids:
            logger.warning(f"Firebase: deleted {len(device_ids)} device(s): {', '.join(device_ids)}")

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