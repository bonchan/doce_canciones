"""
Own captures -> the same pass folders listener.py writes, so everything that reads
downloads/ (the installation, apt_decode.py) picks them up like any SatNOGS pass.

Input: one SatDump output folder per pass, dropped as-is into captures/ (any name):
    captures/<anything>/
        dataset.json            satellite + time of the pass
        MSU-MR/product.cbor     line timestamps + the TLE SatDump used
        MSU-MR/*.png            the images

Output (captures/ itself is never touched):
    downloads/<YYYYmmdd_HHMMSS>_<satellite>_<id>/
        observation.json   same fields as listener.py; "profile": "capture"
        <image files>      copied flat from the product folders

The pass geometry (AOS / LOS, max elevation, rise / set azimuth) is not in SatDump's
output: it is computed here from the TLE in product.cbor and the position of the
receiving station, which has to be given in .env:
    CAPTURE_STATION_NAME=...
    CAPTURE_STATION_LAT=...     degrees, south negative
    CAPTURE_STATION_LNG=...     degrees, west negative
    CAPTURE_STATION_ALT=0       metres
    CAPTURE_IMAGES=             optional, like IMAGES in a profile: MCIR_map,MSA_map

Usage:
    python process_captures.py            every capture not in downloads/ yet
    python process_captures.py --force    rebuild the ones already there
"""

import argparse
import json
import math
import os
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import cbor2
from sgp4.api import Satrec, jday

from listener import HERE, IMAGE_EXTS, OUT_DIR, SAT_NAMES

CAPTURE_DIR = HERE / "captures"
STATION_NAME = os.getenv("CAPTURE_STATION_NAME") or "own station"
STATION_LAT = os.getenv("CAPTURE_STATION_LAT")
STATION_LNG = os.getenv("CAPTURE_STATION_LNG")
STATION_ALT = float(os.getenv("CAPTURE_STATION_ALT") or 0)
IMAGES = tuple(x.strip().lower() for x in (os.getenv("CAPTURE_IMAGES") or "").split(",") if x.strip())

NORAD_IDS = {name: norad for norad, name in SAT_NAMES.items()}
SEARCH_SECONDS = 1500  # how far around the image time to look for AOS / LOS

# WGS84
EARTH_A = 6378.137
EARTH_E2 = 6.69437999014e-3


def station_ecef(lat, lng, alt_m):
    lat, lng = math.radians(lat), math.radians(lng)
    n = EARTH_A / math.sqrt(1 - EARTH_E2 * math.sin(lat) ** 2)
    h = alt_m / 1000
    return (
        (n + h) * math.cos(lat) * math.cos(lng),
        (n + h) * math.cos(lat) * math.sin(lng),
        (n * (1 - EARTH_E2) + h) * math.sin(lat),
    )


def look_angles(sat, when, lat, lng, alt_m):
    """(azimuth, elevation) in degrees of the satellite seen from the station."""
    jd, fr = jday(when.year, when.month, when.day, when.hour, when.minute, when.second + when.microsecond / 1e6)
    error, (xt, yt, zt), _ = sat.sgp4(jd, fr)
    if error:
        raise ValueError(f"sgp4 error {error} - TLE too old for this date?")

    # TEME -> earth-fixed: rotate by the sidereal angle
    d = jd - 2451545.0 + fr
    t = d / 36525
    gmst = math.radians((280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - t**3 / 38710000) % 360)
    x = math.cos(gmst) * xt + math.sin(gmst) * yt
    y = -math.sin(gmst) * xt + math.cos(gmst) * yt

    sx, sy, sz = station_ecef(lat, lng, alt_m)
    dx, dy, dz = x - sx, y - sy, zt - sz
    la, lo = math.radians(lat), math.radians(lng)
    east = -math.sin(lo) * dx + math.cos(lo) * dy
    north = -math.sin(la) * math.cos(lo) * dx - math.sin(la) * math.sin(lo) * dy + math.cos(la) * dz
    up = math.cos(la) * math.cos(lo) * dx + math.cos(la) * math.sin(lo) * dy + math.sin(la) * dz
    dist = math.sqrt(dx * dx + dy * dy + dz * dz)
    return math.degrees(math.atan2(east, north)) % 360, math.degrees(math.asin(up / dist))


def pass_geometry(tle, centre, lat, lng, alt_m):
    """AOS, LOS, max elevation, rise and set azimuth of the pass around `centre`."""
    sat = Satrec.twoline2rv(tle["line1"], tle["line2"])
    times = [centre + timedelta(seconds=s) for s in range(-SEARCH_SECONDS, SEARCH_SECONDS + 1)]
    looks = [look_angles(sat, t, lat, lng, alt_m) for t in times]

    i = SEARCH_SECONDS  # the image time; if the TLE puts it below the horizon, the highest point nearby
    if looks[i][1] <= 0:
        i = max(range(len(looks)), key=lambda k: looks[k][1])
    if looks[i][1] <= 0:
        raise ValueError("satellite never above the horizon here at that time - check CAPTURE_STATION_LAT / LNG")
    first = last = i
    while first > 0 and looks[first - 1][1] > 0:
        first -= 1
    while last < len(looks) - 1 and looks[last + 1][1] > 0:
        last += 1
    return {
        "start": times[first],
        "end": times[last],
        "max_altitude": round(max(el for _, el in looks[first : last + 1]), 1),
        "rise_azimuth": round(looks[first][0], 1),
        "set_azimuth": round(looks[last][0], 1),
    }


def flatten(v):
    if isinstance(v, (list, tuple)):
        for x in v:
            yield from flatten(x)
    elif isinstance(v, (int, float)):
        yield v


def read_products(capture, names):
    """Line timestamps, TLE and image files of every product folder of a capture."""
    stamps, tle, images = [], None, []
    for name in names:
        folder = capture / name
        product = folder / "product.cbor"
        if product.exists():
            data = cbor2.loads(product.read_bytes())
            tle = tle or data.get("tle")
            raw = [data.get("timestamps")] + [img.get("timestamps") for img in data.get("images", [])]
            stamps += [t for t in flatten(raw) if t > 0]  # -1 = line without a timestamp
        if folder.is_dir():
            images += sorted(f for f in folder.iterdir() if f.suffix.lower() in IMAGE_EXTS)
    if IMAGES:
        images = [f for f in images if f.stem.lower().endswith(IMAGES)]
    return stamps, tle, images


def utc(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def process(capture, force):
    dataset = json.loads((capture / "dataset.json").read_text(encoding="utf-8"))
    sat = dataset["satellite"]
    stamps, tle, images = read_products(capture, dataset.get("products", []))
    if not images:
        print(f"[skip] {capture.name}: no images")
        return

    image_start, image_end = (min(stamps), max(stamps)) if stamps else (dataset["timestamp"],) * 2
    centre = utc((image_start + image_end) / 2)
    if tle:
        geo = pass_geometry(tle, centre, float(STATION_LAT), float(STATION_LNG), STATION_ALT)
    else:  # nothing to compute the pass from: only when the image was received
        print(f"[warn] {capture.name}: no TLE in product.cbor, elevation / azimuths left empty")
        geo = {"start": utc(image_start), "end": utc(image_end), "max_altitude": None, "rise_azimuth": None, "set_azimuth": None}

    # an id that can't collide with SatNOGS observation ids, stable between runs
    pass_id = int(geo["start"].timestamp())
    folder = OUT_DIR / f"{geo['start']:%Y%m%d_%H%M%S}_{sat}_{pass_id}"
    meta_path = folder / "observation.json"
    if meta_path.exists() and not force:
        return

    folder.mkdir(parents=True, exist_ok=True)
    for f in images:
        shutil.copy2(f, folder / f.name)

    elev = f"  Max Elev: {geo['max_altitude']:.0f}°" if geo["max_altitude"] is not None else ""
    meta = {
        "id": pass_id,
        "text": f"Ground Station: {STATION_NAME} {sat} {geo['start']:%d-%m-%Y %H:%M} UTC{elev}",
        "satellite": sat,
        "norad_cat_id": (tle or {}).get("norad") or NORAD_IDS.get(sat),
        "start": iso(geo["start"]),
        "end": iso(geo["end"]),
        "station_id": 0,
        "station_name": STATION_NAME,
        "station_lat": float(STATION_LAT),
        "station_lng": float(STATION_LNG),
        "max_altitude": geo["max_altitude"],
        "rise_azimuth": geo["rise_azimuth"],
        "set_azimuth": geo["set_azimuth"],
        "transmitter": "LRPT",
        "mode": "LRPT",
        "waterfall_status": "with-signal",
        "files": [f.name for f in images],
        "waterfall": None,
        "url": None,
        "profile": "capture",
        "capture": capture.name,
        "image_start": iso(utc(image_start)),
        "image_end": iso(utc(image_end)),
        "tle": tle,
    }
    # written last, like listener.py: the installation waits for it
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[capture] {capture.name} -> {folder.name}  files={len(images)}{elev}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="rebuild passes already in downloads/")
    args = ap.parse_args()

    if not STATION_LAT or not STATION_LNG:
        sys.exit("set CAPTURE_STATION_LAT and CAPTURE_STATION_LNG in .env (where the antenna is)")
    if not CAPTURE_DIR.exists():
        sys.exit(f"no captures folder: {CAPTURE_DIR}")

    for capture in sorted(p.parent for p in CAPTURE_DIR.glob("*/dataset.json")):
        try:
            process(capture, args.force)
        except Exception as e:
            print(f"[error] {capture.name}: {e}")


if __name__ == "__main__":
    main()
