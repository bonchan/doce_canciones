# Doce Canciones — backend ("the brain")

FastAPI + MQTT service that tracks every device in the installation, keeps
an in-memory registry, and exposes it over REST and a websocket for the
dashboard.

- `topics.py` — the MQTT topic schema (announce / status / telemetry / cmd)
- `broker.py` — the MQTT client, the device registry, offline detection
- `routes.py` — REST endpoints, websocket, the `X-API-Key` check
- `firebase_pusher.py` — mirrors the registry to Firebase Realtime Database on an interval, for viewing installation status from outside the gallery
- `solar_path.py` — computes today's sun path (pvlib) and maps it to a polargraph's physical mm coordinates, for the "draw solar line" feature
- `drawing.py` — orchestrates multi-point drawings on a polargraph: batches points to the device's onboard queue (see `esp32_polargraph.ino`'s `QUEUE_ADD`/`queue_len`), refills on a low-water mark, tracks progress from `sent - queue_len` (points the firmware has actually popped, not proximity guessing), and exposes job state (`dev["job"]`) over the existing `/ws/state` websocket
- `main.py` — app assembly: creates the FastAPI app, wires up `routes.py`, and owns startup/shutdown (including the MQTT connect-retry loop and the Firebase pusher)

## Requirements

- Python 3.10+
- A running MQTT broker reachable from this machine (Mosquitto recommended:
  `sudo apt install mosquitto mosquitto-clients`)

## Setup

```
cd core2/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then fill in real values
```

## Configuration (`.env`)

| Variable        | Meaning                                                                 |
|-----------------|--------------------------------------------------------------------------|
| `MQTT_BROKER`   | broker hostname/IP                                                      |
| `MQTT_PORT`     | broker port (1883 default)                                              |
| `MQTT_USER` / `MQTT_PASS` | broker credentials                                             |
| `API_KEY`       | required `X-API-Key` header on all `POST /api/devices/...` endpoints    |
| `STALE_TIMEOUT` | seconds of silence before a device is force-marked offline (default 15) |
| `MQTT_RETRY_DELAY` | seconds between MQTT connect attempts if the broker isn't reachable (default 3) |
| `FIREBASE_CRED_PATH` | path (relative to `backend/`) to the Firebase Admin service account JSON — leave unset to disable Firebase sync |
| `FIREBASE_DATABASE_URL` | Firebase Realtime Database URL — leave unset to disable Firebase sync |
| `FIREBASE_INTERVAL_SECONDS` | how often the registry is pushed to Firebase (default 60) |
| `SOLAR_LAT` / `SOLAR_LON` / `SOLAR_TZ` | installation location, for the polargraph "draw solar line" feature (default: Neuquén) |

Never commit `.env` or any credentials file — both are already covered by
`backend/.gitignore`, including the Firebase service account JSON under
`firebase/`.

## Running locally

```
uvicorn main:app --reload
```

## Running in production on Ubuntu (systemd)

Goal: if the process crashes, the machine reboots, or it gets OOM-killed,
it comes back on its own — nobody has to walk up to the gallery machine.

1. Install into a fixed path, e.g. `/opt/doce_canciones/core2/backend`,
   with the venv and `.env` set up as above.

2. Create `/etc/systemd/system/doce-brain.service`:

   ```
   [Unit]
   Description=Doce Canciones brain (backend)
   After=network-online.target mosquitto.service
   Wants=network-online.target

   [Service]
   Type=simple
   User=doce
   WorkingDirectory=/opt/doce_canciones/core2/backend
   EnvironmentFile=/opt/doce_canciones/core2/backend/.env
   ExecStart=/opt/doce_canciones/core2/backend/.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
   Restart=always
   RestartSec=3
   StandardOutput=journal
   StandardError=journal

   [Install]
   WantedBy=multi-user.target
   ```

3. Enable and start:

   ```
   sudo systemctl daemon-reload
   sudo systemctl enable doce-brain
   sudo systemctl start doce-brain
   ```

4. Check on it:

   ```
   systemctl status doce-brain
   journalctl -u doce-brain -f
   ```

## How the restart actually works

Two different failure modes, handled two different ways:

- **MQTT broker blips** (wifi drop, broker restart, network hiccup) — handled
  inside the running process. `broker.py` calls `client.loop_start()`, which
  runs paho's own network thread and reconnects automatically with backoff.
  The Python process itself never dies for this.

- **The Python process itself dies** (unhandled exception, OOM kill, someone
  closes the terminal, server reboot) — this is what `Restart=always` in the
  systemd unit handles. Systemd notices the process exited and relaunches it
  after `RestartSec`, indefinitely, and `WantedBy=multi-user.target` means it
  also starts automatically on boot — no manual step after a power cycle.

**MQTT connect itself doesn't take the app down.** `main.py` starts the MQTT
connect as a background task (`_connect_with_retry`) instead of awaiting it
during startup — so if the broker isn't reachable yet (e.g. mosquitto hasn't
finished starting, or it restarts later), the FastAPI app still comes up and
serves `/api/devices` and the dashboard normally, just with an empty/stale
registry until MQTT connects. It retries every `MQTT_RETRY_DELAY` seconds,
forever, logging each failed attempt. The `After=mosquitto.service` line in
the unit file above still helps reduce how often that race happens when both
run on the same box, but it's no longer required for the app to start.

## Drawing jobs (polargraph)

`POST /api/devices/{device_id}/draw/solar_path` starts drawing a sun path on
a polargraph; `POST /api/devices/{device_id}/draw/cancel` stops it (sends
`HALT`, which also clears the device's onboard point queue). Requires the
device to be online and already zeroed (`ZERO`/SET HOME sent this session)
— the drawing coordinates are meaningless without that.

Optional `?scale=` query param (default `1.0`) shrinks/grows the traced
shape about the working rectangle's own center without changing the frame
itself — e.g. `?scale=0.5` draws the same shape at half size, still centered
in the full `motor_dist` x `motor_y` rectangle. Must be > 0.

Optional `?date=YYYY-MM-DD` query param picks which day's sun path to
trace — omit it (the frontend's "Use date" checkbox unticked) to draw
today's, in the installation's configured timezone. An unparseable date
comes back as a 409, same as any other precondition failure on this
endpoint.

Progress is exposed as `dev["job"]` in the normal `/ws/state` broadcast:
`{"kind": "solar_path", "points": [[x,y],...], "sent": N, "reached": M,
"total": T, "status": "running"|"done"}`, so the frontend can split the line
into a "done" and "remaining" portion. `reached` is derived from
`sent - queue_len` (how many points the firmware has actually popped off its
queue) rather than comparing telemetry position to the next point — an
earlier version did the latter and broke whenever consecutive path points
sit close together (common near solar noon, or with a small `scale`), since
the gondola's current position could satisfy "close enough" for a whole run
of not-yet-visited points at once, racing `reached` to `total` and ending
the job long before the device had actually finished. Final completion
additionally requires `left/right_distance_to_go` to read ~0, since an empty
queue alone doesn't mean the last point has been physically reached yet.
`job` goes back to `null` a moment after the drawing finishes or is
cancelled — including via `HALT` sent through *any* path, not just the
frontend's dedicated cancel button. Two layers make that true:

1. The frontend's CANCEL DRAWING / jog-panel HALT button calls
   `POST .../draw/cancel` directly, which cancels the backend polling task
   and sends `HALT`.
2. `_run_job()` also watches the device's own `queue_clears` telemetry
   counter (incremented in firmware only by `queueClear()`, which only
   fires from `HOME`/`ZERO`/`HALT`/`WIND`/`MOVE_ABS`/`MOVE_REL` — never
   during normal queue draining). If that counter increases mid-job — e.g.
   a raw `HALT` sent through the generic CommandPanel, or literally any
   other positioning command issued from elsewhere — the job treats it as
   an external interruption and stops itself on the next poll, without
   needing to go through the cancel endpoint at all.

Stall detection (`STALL_TIMEOUT`, default 30s) no longer fires just because
one leg of the path is long — it tracks `left/right_distance_to_go`
changing as evidence the motors are still moving, and only aborts if
there's been neither a new point popped *nor* any motor movement for that
long. This matters because consecutive solar-path points can be far apart
near sunrise/sunset, so a single leg can legitimately take longer than the
old point-to-point-only progress check assumed.

## Known gaps / not yet implemented

- No persistence — the registry is in-memory only, a restart forgets every
  device until it re-announces.
- Only one kind of drawing job exists (solar path) and only one at a time
  per device — `drawing.py` is written generically enough (points list in,
  batched to the device's queue) that adding another source of points later
  shouldn't need much beyond a new REST endpoint.
