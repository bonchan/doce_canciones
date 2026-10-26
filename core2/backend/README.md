# Doce Canciones — backend ("the brain")

FastAPI + MQTT service that tracks every device in the installation, keeps
an in-memory registry, and exposes it over REST and a websocket for the
dashboard.

- `topics.py` — the MQTT topic schema (announce / status / telemetry / cmd)
- `broker.py` — the MQTT client, the device registry, offline detection
- `routes.py` — REST endpoints, websocket, the `X-API-Key` check
- `firebase_pusher.py` — mirrors the registry to Firebase Realtime Database on an interval, for viewing installation status from outside the gallery
- `solar_path.py` — computes today's sun path (pvlib) and maps it to a polargraph's physical mm coordinates, for the "draw solar line" feature
- `text_path.py` — converts arbitrary text into pen strokes (Hershey single-stroke plotter fonts) in a polargraph's physical mm coordinates, anchored to wherever the gondola currently is, for the "write text" feature
- `drawing.py` — orchestrates multi-point drawings on a polargraph: batches points to the device's onboard queue (see `esp32_polargraph.ino`'s `QUEUE_ADD`/`queue_len`), refills on a low-water mark, tracks progress from `sent - queue_len` (points the firmware has actually popped, not proximity guessing), and exposes job state (`dev["job"]`) over the existing `/ws/state` websocket
- `main.py` — app assembly: creates the FastAPI app, wires up `routes.py`, and owns startup/shutdown (including the MQTT connect-retry loop and the Firebase pusher)

Note on the polargraph specifically: its actual MQTT telemetry/meta field
names are short (`ldtg`/`rdtg`/`qlen`/`qclr`/`swr`/`lend`/`rend`/`temp`,
`my`/`md`/`mys`) — they were shortened to keep the device's MQTT announce
payload under its buffer size on the firmware side. This doc still refers
to them by their descriptive long form (`queue_len`, `motor_dist`, etc.)
for readability; see the name-mapping comment above `CAPS_PUBLISHES` in
`esp32_polargraph.ino` for the authoritative short↔long list.

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

uvicorn main:app --host 0.0.0.0 --port 8000 --reload

```

## Running in production on the NUC (Ubuntu)

Everything is set up by one script, run once from the checkout as your normal user:

```
git clone git@github.com:bonchan/doce_canciones.git ~/doce_canciones   # or wherever
bash ~/doce_canciones/core2/scripts/install.sh
```

It installs the packages (Python, Node + pnpm, mosquitto, avahi), builds the webapp, and installs these
systemd units (templates in `core2/scripts/`):

| unit | what |
|------|------|
| `doce-brain` | this backend **and** the built webapp, on port 8000, listening on IPv4 and IPv6 |
| `doce-files` | `file_server/server.py` on port 8090 |
| `doce-watchdog.timer` | every minute runs `scripts/watchdog.sh`: restarts whatever stopped answering |
| `doce-update` | started by the System tab's Update button: git pull, rebuild, restart |

Open the webapp from any computer at `http://<nuc-name>.local:8000` (or its IPv4 / `[IPv6]` address).
The System tab shows the NUC's health, the services, the watchdog, and updates.

Updating: the System tab's **Update** button, or by hand `git pull && bash core2/scripts/update.sh`.
The NUC must be able to `git fetch` without typing a password (an SSH key without passphrase, or an
https clone). Commits that only touch other folders of the repo are just pulled, nothing restarts.

Logs: `journalctl -u doce-brain -f` (also `doce-files`, `doce-watchdog`, `doce-update`); the watchdog's
restarts also go to `~/doce_canciones_data/logs/watchdog.log`. To stop the watchdog from restarting
things while you work on the NUC by hand: `touch ~/doce_canciones_data/watchdog.pause` (delete it after).

## How the restart actually works

Two different failure modes, handled two different ways:

- **MQTT broker blips** (wifi drop, broker restart, network hiccup) — handled
  inside the running process. `broker.py` calls `client.loop_start()`, which
  runs paho's own network thread and reconnects automatically with backoff.
  The Python process itself never dies for this.

- **The Python process itself dies** (unhandled exception, OOM kill, someone
  closes the terminal, server reboot) — this is what `Restart=always` in the
  systemd unit handles (and `scripts/watchdog.sh` catches a process that is alive but hung). Systemd notices the process exited and relaunches it
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

`POST /api/devices/{device_id}/draw/text` writes arbitrary text starting
wherever the gondola currently is (its live `x`/`y` telemetry at the moment
the job starts), rather than a fixed frame like the solar path — see
`text_path.py`. Query params: `text` (required), `letter_height_mm`
(default 30), `font` (default `"cursive"`, any name from the
`Hershey-Fonts` package's built-in set — an unknown font name comes back as
a 409). No attempt is made to keep the text within the polargraph's
physical working rectangle; long text starting near an edge can run past
it, deliberately unhandled for now.

Internally this reuses `_run_job()` — the same function the solar path
uses. `text_path.py` groups the text into strokes (a Hershey glyph's own
connected segments, or several joined letters in a cursive font), but
`start_text_job()` flattens all of them into one continuous point list
before handing it off, so the whole thing is streamed and drawn as a
single unbroken pen-down line: the pen never lifts between letters or
words. (An earlier version traveled pen-up between strokes via a separate
`MOVE_ABS`, structured as its own `_run_text_job()` — that left visible
gaps and added pen-lift wear, and was replaced with this simpler
single-line approach.) Job state uses `"kind": "text"` with a flattened
`"points"` array — same `sent`/`reached` contract as the solar path, so
the frontend's progress coloring works unmodified.

## Known gaps / not yet implemented

- No persistence — the registry is in-memory only, a restart forgets every
  device until it re-announces.
- Two kinds of drawing job exist (solar path, text), both streamed through
  the same `_run_job()`, and only one at a time per device, across either
  kind.
