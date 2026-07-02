import asyncio
import logging
from datetime import datetime
import firebase_admin
from firebase_admin import credentials, db
import broker_listener  # To read your live metrics cache

logger = logging.getLogger("uvicorn.error")

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

    async def _loop(self):
        # Reference node path in your Firebase Realtime tree
        ref = db.reference("device_snapshot")
        
        while self.is_running:
            start_time = asyncio.get_event_loop().time()
            try:
                # Read the latest state map straight out of your live broker listener memory cache
                merged_devices = broker_listener.get_merged_state()
                
                payload = {
                    "last_sync": datetime.utcnow().isoformat(),
                    "interval_seconds": self.interval_seconds,
                    "devices": merged_devices
                }
                
                # .set() overwrites this node, providing your frontend app with a single 
                # real-time overview matrix of every single device simultaneously.
                ref.set(payload)
                
            except Exception as e:
                logger.error(f"❌ Firebase sync routine error: {e}")

            # Precise interval calculation that accounts for network request latency
            elapsed = asyncio.get_event_loop().time() - start_time
            sleep_duration = max(0.1, self.interval_seconds - elapsed)
            await asyncio.sleep(sleep_duration)