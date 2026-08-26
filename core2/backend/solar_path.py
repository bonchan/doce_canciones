"""Computes today's sun path (elevation > 0) and maps it onto a polargraph's
physical mm coordinate system, for the "draw solar line" feature.

Framing is fixed and identical every day on purpose (elevation 0-90deg,
azimuth ±180deg mapped onto the full motor_dist x motor_y rectangle) so the
drawing is comparable from one day to the next — this mirrors the original
solar_paths_today.py plot's fixed axis bounds rather than auto-fitting to
each day's actual min/max, which would make the framing shift day to day.
"""
import os

import pandas as pd
from pvlib import solarposition
from dotenv import load_dotenv

load_dotenv()

# Installation location — defaults match the original solar_paths_today.py
# script (Neuquén). Override via .env if the installation moves.
SOLAR_LAT = float(os.getenv("SOLAR_LAT", -38.9516))
SOLAR_LON = float(os.getenv("SOLAR_LON", -68.0591))
SOLAR_TZ = os.getenv("SOLAR_TZ", "America/Argentina/Salta")


def today_solar_points_mm(
    motor_dist: float, motor_y: float, scale: float = 1.0, date: str | None = None
) -> list[tuple[float, float]]:
    """Returns an ordered list of (x, y) mm points — in the firmware's own
    coordinate convention, ready to hand straight to MOVE_ABS/QUEUE_ADD —
    tracing a day's sun path from sunrise to sunset, sorted left-to-right
    across the sky (ascending azimuth, matching the original script).

    `date` is an optional "YYYY-MM-DD" string picking which day to trace;
    None (the default) uses today, in SOLAR_TZ. Kept as a plain string
    rather than a date object at this boundary since it comes straight off
    an HTTP query param — raises ValueError on anything pandas can't parse,
    which the caller (drawing.py) turns into a DrawingError.

    Base mapping (scale=1, fills the full motor_dist x motor_y rectangle):
      x = -(adj_azimuth / 180) * (motor_dist / 2)
      y = motor_y * (1 - elevation / 90)

    Matches PolargraphPage.jsx's toPixel/toMm exactly (both x and y
    flipped relative to the firmware's raw coordinates) — confirmed via a
    click-target test that a physically-left click needs a mirrored +x to
    land correctly — so a point computed here lands in the same physical
    spot a matching click on the webapp canvas would target. If that
    convention ever changes on the frontend, update the sign here too. y=0
    (top, near the motors) is elevation 90, y=motor_y (bottom) is elevation
    0, matching how the frontend's toPixel() treats y.

    `scale` shrinks/grows the traced shape about the working rectangle's own
    center — (0, motor_y/2) in this coordinate system, since x is already
    centered on 0 and y runs top(0) to bottom(motor_y) — rather than about
    the origin (which sits at the top edge, not the middle), so scale=0.5
    draws the same shape at half size, centered in the same 1700x1200
    frame, not shifted toward the top. scale=1 (default) is a no-op.
    """
    if scale <= 0:
        raise ValueError("scale must be > 0")

    if date:
        target_date = pd.Timestamp(date).date()  # raises ValueError on a bad string
    else:
        target_date = pd.Timestamp.now(tz=SOLAR_TZ).date()
    times = pd.date_range(f"{target_date} 00:00:00", f"{target_date} 23:59:00", freq="10min", tz=SOLAR_TZ)

    solpos = solarposition.get_solarposition(times, SOLAR_LAT, SOLAR_LON)
    sun_up = solpos[solpos["elevation"] > 0].copy()
    if sun_up.empty:
        return []

    sun_up["adj_azimuth"] = sun_up["azimuth"].apply(lambda a: a if a <= 180 else a - 360)
    sun_up = sun_up.sort_values("adj_azimuth")

    center_x = 0.0
    center_y = motor_y / 2.0

    points = []
    for _, row in sun_up.iterrows():
        az = row["adj_azimuth"]
        el = min(max(row["elevation"], 0.0), 90.0)
        x = -(az / 180.0) * (motor_dist / 2.0)
        y = motor_y * (1.0 - el / 90.0)
        x = center_x + (x - center_x) * scale
        # y = center_y + (y - center_y) * scale
        points.append((round(float(x), 2), round(float(y), 2)))
    return points
