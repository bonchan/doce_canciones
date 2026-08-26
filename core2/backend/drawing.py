"""Orchestrates multi-point drawings (currently just the solar path) on a
polargraph, using the on-device point queue added in esp32_polargraph.ino
(QUEUE_ADD / queue_len).

Why this lives in the backend rather than just handing the device the whole
point list up front: the backend holds the full, authoritative path and a
small onboard ring buffer on the device gets refilled as it drains (batch
size / low-water mark below) — the device never needs to hold more than a
short lookahead, and the drawing can be cancelled or resumed-on-reconnect
from the backend's side without the device needing to know anything about
"drawings" as a concept, only "here are some more points."

Progress (which points have actually been physically reached, for the
frontend's green/red split) is derived from queue_len, not proximity to the
next point: `sent - queue_len` is how many points the firmware has popped
off its own queue, which is an exact count straight from firmware state.
An earlier version compared live telemetry x/y against the next unconfirmed
point (like the frontend's click-target-arrival check) — that broke down
whenever consecutive path points sit close together (common near solar noon,
or whenever a small `scale` compresses the whole path toward the center):
the gondola's current position could satisfy the "close enough" check for a
whole run of upcoming points at once without actually having visited them
yet, so `reached` could race ahead to `total` — and the job would end,
clearing the line — long before the device had physically finished drawing.

External interruption (any HALT/HOME/ZERO/WIND/MOVE_ABS/MOVE_REL that isn't
this job's own QUEUE_ADD calls) is detected via the `queue_clears` telemetry
counter rather than by assuming only the dedicated cancel endpoint can stop
a drawing: firmware increments it only inside `queueClear()`, which only
runs from those manual-command handlers, never during normal queue
draining. `_run_job()` snapshots that counter as a baseline and bails out
the moment it ticks up again — so a raw HALT sent through any control path
still clears the job promptly, not just the frontend's dedicated cancel
button.

start_solar_path_job() itself sends a HALT before a new job's first point,
to clear anything left in the device's queue by a job this backend process
has otherwise forgotten about (a restart, an orphaned task) — without it, a
fresh job's points can get interleaved with a stale job's leftovers, which
once produced a drawing that looked duplicated and backtracking. But that
same HALT also bumps queue_clears, so _run_job() *waits for confirmation*
that it landed (polls until the counter actually rises, bounded by a
timeout) before establishing its baseline — establishing the baseline too
early, before the HALT's own bump has arrived in telemetry, made the job
mistake its own startup clear for an external interruption and cancel
itself immediately (the red line disappearing right at the start of a
drawing was this bug, not a deliberate stop).

Stall detection also tracks live motor motion (`left/right_distance_to_go`
changing), not just newly-popped points — otherwise a single long
point-to-point leg (common near sunrise/sunset) could exceed the timeout
and abort a drawing that was still actively in progress.
"""
import asyncio
import time

import broker
from broker import registry
from logger import logger
import solar_path

BATCH_SIZE = 10          # points per QUEUE_ADD — comfortably under the MQTT payload budget
LOW_WATER = 3             # refill once the on-device queue drops to this many points
STOP_TOLERANCE_STEPS = 2  # left/right_distance_to_go this close to 0 counts as "stopped"
POLL_INTERVAL = 0.3
STALL_TIMEOUT = 30         # seconds with truly no motion before giving up (see "moving" below —
                            # this only fires if the motors themselves haven't moved either, not
                            # just because the current point-to-point leg is a long one)

_active_jobs: dict[str, asyncio.Task] = {}


class DrawingError(Exception):
    pass


async def start_solar_path_job(device_id: str, scale: float = 1.0, date: str | None = None):
    """Validates preconditions and kicks off the background job. Raises
    DrawingError (caller maps this to an HTTP error) rather than failing
    silently, since this is triggered by an explicit user click.

    `scale` is forwarded to solar_path.today_solar_points_mm() — 1.0 (the
    default) fills the full working rectangle; smaller values shrink the
    traced shape toward the rectangle's center without changing the frame
    itself. See that function's docstring for the exact mapping.

    `date` ("YYYY-MM-DD", optional) picks which day's sun path to trace —
    None (the default) uses today, in the installation's configured
    timezone. Forwarded straight to solar_path.today_solar_points_mm(),
    which raises ValueError on an unparseable string; caught below and
    turned into the same DrawingError every other precondition failure here
    uses, so the frontend doesn't need a separate error path for it.

    Must be called from a coroutine running on the main event loop (i.e.
    from an `async def` route) — asyncio.create_task() below needs to
    schedule onto that same loop, which isn't guaranteed if this were called
    from a plain `def` route (FastAPI runs those in a worker thread)."""
    if scale <= 0:
        raise DrawingError("scale must be > 0")

    dev = registry.devices.get(device_id)
    if not dev:
        raise DrawingError(f"unknown device {device_id}")
    if not dev.get("online"):
        raise DrawingError(f"{device_id} is offline")

    telemetry = dev.get("telemetry", {})
    if telemetry.get("x") is None or telemetry.get("y") is None:
        raise DrawingError(f"{device_id} hasn't been zeroed yet — send SET HOME first")

    meta = dev.get("meta", {})
    motor_dist = meta.get("motor_dist")
    motor_y = meta.get("motor_y")
    if not motor_dist or not motor_y:
        raise DrawingError(f"{device_id} hasn't announced motor_dist/motor_y yet")

    existing = _active_jobs.get(device_id)
    if existing and not existing.done():
        raise DrawingError(f"{device_id} already has a drawing in progress")

    try:
        points = solar_path.today_solar_points_mm(motor_dist, motor_y, scale=scale, date=date)
    except ValueError as e:
        raise DrawingError(f"bad date {date!r}: {e}")
    if not points:
        raise DrawingError("the sun isn't up on that date — nothing to draw")

    # Force a clean slate on the device before this job sends a single
    # point. Without this, anything already sitting in the device's onboard
    # queue from a job this backend process has otherwise forgotten about
    # (the backend restarted mid-drawing, `uvicorn --reload` fired, the
    # process crashed and came back) keeps draining on its own, and a fresh
    # job sending points[0] onward gets interleaved with it — this is
    # exactly what produced a drawing that looked "duplicated, then
    # backtracked": an orphaned job's first batches were still live on the
    # device when a new job started over from point 0.
    #
    # pre_halt_clears is captured *before* sending this HALT and handed to
    # _run_job, which waits for queue_clears to actually rise past it
    # before arming external-interruption detection — see _run_job for why
    # a fixed delay here isn't safe.
    pre_halt_clears = (dev.get("telemetry") or {}).get("queue_clears")
    try:
        broker.publish_command(device_id, "HALT", {})
    except KeyError:
        pass

    _active_jobs[device_id] = asyncio.create_task(_run_job(device_id, points, pre_halt_clears))


def cancel_job(device_id: str):
    """HALT already clears the on-device queue (see esp32_polargraph.ino),
    so cancelling is just: stop our polling loop and tell the device to
    stop. Safe to call even if there's no job running. Like
    start_solar_path_job, call this from an async route — Task.cancel() and
    friends aren't safe to touch off the event loop's own thread.

    This is the *direct* cancel path (the frontend's CANCEL DRAWING / HALT
    buttons). _run_job() also detects interruption *indirectly*, via the
    device's own queue_clears counter — see there — which is what catches
    a HALT sent through some other route (the raw CommandPanel tag, a
    manual jog, or literally any other command that touches positioning),
    since none of those go through this function at all."""
    task = _active_jobs.get(device_id)
    if task and not task.done():
        task.cancel()
    try:
        broker.publish_command(device_id, "HALT", {})
    except KeyError:
        pass


async def _run_job(device_id: str, points: list[tuple[float, float]], pre_halt_clears=None):
    total = len(points)
    dev = registry.devices[device_id]

    # start_solar_path_job sent a pre-job HALT to clear any stale queue
    # before this job sends a single point (see there). That HALT bumps
    # the device's queue_clears counter, same as any other HALT — and this
    # job's own external-interruption check below (comparing queue_clears
    # against a baseline) can't tell that bump apart from someone else
    # hitting HALT mid-drawing unless we establish the baseline *after*
    # it's landed.
    #
    # A fixed delay here isn't safe — MQTT/WiFi round-trip time varies, and
    # a delay too short for the actual round trip means the baseline gets
    # captured with the OLD (pre-HALT) count, so the confirmation arrives
    # a moment later looking exactly like an external interruption: the job
    # cancels itself immediately, which is what "the red line disappears
    # right away" was. So actually wait for confirmation instead of hoping
    # a guessed delay was long enough, bounded so a device that doesn't
    # have this telemetry field yet (or is having connectivity trouble)
    # doesn't hang the job forever.
    if pre_halt_clears is not None:
        confirm_deadline = time.monotonic() + 5.0
        while time.monotonic() < confirm_deadline:
            dev = registry.devices.get(device_id) or dev
            current = (dev.get("telemetry") or {}).get("queue_clears")
            if current is not None and current > pre_halt_clears:
                break
            await asyncio.sleep(0.15)
        else:
            logger.info(f"[drawing] {device_id} pre-job HALT wasn't confirmed within 5s — proceeding anyway")

    dev = registry.devices.get(device_id) or dev

    # Baseline for detecting an external interruption below — only care
    # about this counter increasing *during* this job, not its absolute
    # value (which may already be nonzero from something that happened
    # long before this job started, including the pre-job HALT just
    # confirmed above).
    baseline_clears = (dev.get("telemetry") or {}).get("queue_clears")

    dev["job"] = {
        "kind": "solar_path",
        "points": points,
        "sent": 0,
        "reached": 0,
        "total": total,
        "status": "running",
    }
    await registry.broadcast()

    sent = 0
    reached = 0
    last_progress_at = time.monotonic()
    last_dtg = (None, None)

    try:
        finished = False
        interrupted = False
        while not finished:
            dev = registry.devices.get(device_id)
            if not dev or not dev.get("online"):
                raise DrawingError("device went offline mid-drawing")

            telemetry = dev.get("telemetry", {})

            # Something outside this job (HOME/ZERO/HALT/WIND/MOVE_ABS/
            # MOVE_REL, sent via any control) cleared the device's queue —
            # treat that as a cancellation rather than trying to keep going
            # against a queue whose contents no longer match our bookkeeping.
            clears = telemetry.get("queue_clears")
            if clears is not None and baseline_clears is not None and clears > baseline_clears:
                logger.info(f"[drawing] {device_id} interrupted externally (queue cleared) — stopping")
                interrupted = True
                break
            if baseline_clears is None:
                baseline_clears = clears  # device didn't have this field yet on the first read

            queue_len = telemetry.get("queue_len")
            queue_len = queue_len if queue_len is not None else 0

            if sent < total and queue_len <= LOW_WATER:
                batch = points[sent:sent + BATCH_SIZE]
                broker.publish_command(device_id, "QUEUE_ADD", {"points": batch})
                sent += len(batch)
                queue_len += len(batch)  # local estimate until the next telemetry tick catches up

            # popped = how many points the firmware has pulled off its queue
            # so far — exact and monotonic, straight from firmware state.
            # This slightly over-counts (the most recently popped point is
            # the one currently being traveled toward, not yet arrived) but
            # that's a one-point visual lag, not a class of bug.
            popped = max(0, min(sent - queue_len, total))

            # "Progress" for stall detection is either a new point popped,
            # or the motors having physically moved since the last check —
            # NOT popped alone. Consecutive solar-path points can be far
            # apart (especially near sunrise/sunset), so a single leg can
            # legitimately take longer than STALL_TIMEOUT; only bail out if
            # nothing has moved at all, not just because we're still
            # mid-way through one long leg.
            dtg = (telemetry.get("left_distance_to_go"), telemetry.get("right_distance_to_go"))
            moving = dtg != last_dtg and dtg[0] is not None
            last_dtg = dtg

            if popped > reached:
                reached = popped
            if popped > reached or moving:
                last_progress_at = time.monotonic()

            # True completion needs more than "queue empty" — the last
            # popped point might still be in flight. Require the motors to
            # have actually stopped too.
            left_dtg, right_dtg = dtg
            stopped = (
                left_dtg is not None and abs(left_dtg) <= STOP_TOLERANCE_STEPS
                and right_dtg is not None and abs(right_dtg) <= STOP_TOLERANCE_STEPS
            )
            if sent >= total and queue_len == 0 and stopped:
                reached = total
                finished = True

            job = dev.get("job")
            if job:
                job["sent"] = sent
                job["reached"] = reached
                await registry.broadcast()

            if finished:
                break

            if time.monotonic() - last_progress_at > STALL_TIMEOUT:
                raise DrawingError("no progress for too long — device may have stopped responding")

            await asyncio.sleep(POLL_INTERVAL)

        if finished and not interrupted:
            dev = registry.devices.get(device_id)
            if dev and dev.get("job"):
                dev["job"]["status"] = "done"
                await registry.broadcast()
            await asyncio.sleep(1.0)  # let the frontend show the completed line briefly

    except asyncio.CancelledError:
        logger.info(f"[drawing] {device_id} cancelled")
        raise
    except DrawingError as e:
        logger.error(f"[drawing] {device_id} failed: {e}")
    finally:
        dev = registry.devices.get(device_id)
        if dev is not None:
            dev["job"] = None
        await registry.broadcast()
        _active_jobs.pop(device_id, None)
