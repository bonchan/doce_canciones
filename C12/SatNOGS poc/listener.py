"""
SatNOGS listener: pulls observations from the public SatNOGS Network API and
saves the decoded images and/or the .ogg audio recording of each one.

One listener, several profiles, one downloads/ folder:
    .env                  PROFILES=noaa,meteor + settings shared by every profile
    profiles/<name>.env   satellites, filters, what to download, which dates
    python listener.py             runs the PROFILES listed in .env
    python listener.py meteor      runs only profiles/meteor.env
Without PROFILES (and no arguments) .env itself is the only profile, like before.

Profiles take turns, one window each, in a single process: SatNOGS sees one request
every REQUEST_DELAY seconds no matter how many profiles run.

Date mode of each profile:
    - backwards: BACKWARDS_FROM (a date, or "now") back to BACKWARDS_TO, one
      WINDOW_HOURS window at a time; progress is saved in
      downloads/progress_<profile>.json, so a restart resumes
    - range: START (and optionally END), once
    - poll (no dates): every POLL_SECONDS, look back LOOKBACK_HOURS for new passes

Which station images: IMAGES=MCIR_map,MSA_map downloads only the files whose name
(before the extension) ends with one of those; empty = every image.

Station variety (counted from what is already in downloads/):
    MAX_PER_STATION   passes kept per ground station
    MAX_PER_WINDOW    passes kept per satellite per window, spreads them over more days
    MAX_PASSES        the profile stops - and stops making requests - at this many

Output layout (every profile):
    downloads/<YYYYmmdd_HHMMSS>_<satellite>_<observation_id>/
        observation.json   station, satellite, pass info, file list
        <image files>      decoded by the station (APT enhancements, METEOR LRPT)
        <audio .ogg>       if DOWNLOAD_AUDIO=1
        satnogs_<...>.png  APT image decoded here from the .ogg when the station
                           uploaded none (DECODE_APT=1, uses apt_decode.py)

Setup:
    pip install -r requirements.txt
    python listener.py
"""

import json
import os
import sys
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from dotenv import dotenv_values, load_dotenv

HERE = Path(__file__).parent
load_dotenv(HERE / ".env")

OUT_DIR = HERE / "downloads"
PROFILE_DIR = HERE / "profiles"
REQUEST_DELAY = float(os.getenv("REQUEST_DELAY") or 2)  # SatNOGS throttles hard
POLL_SECONDS = int(os.getenv("POLL_SECONDS") or 600)
DECODE_APT = os.getenv("DECODE_APT", "1") == "1"

API = "https://network.satnogs.org/api/observations/"
SAT_NAMES = {
    40069: "METEOR-M2",
    44387: "METEOR-M2-2",
    57166: "METEOR-M2-3",
    59051: "METEOR-M2-4",
    25338: "NOAA-15",
    28654: "NOAA-18",
    33591: "NOAA-19",
    25544: "ISS",
}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}

session = requests.Session()
session.headers["User-Agent"] = "doce-canciones-satnogs-poc"


def parse_time(v):
    if not v:
        return None
    if v.lower() == "now":
        return datetime.now(timezone.utc)
    return datetime.fromisoformat(v.replace("Z", "+00:00")).replace(tzinfo=timezone.utc)


def get(url, **kwargs):
    """GET that waits out SatNOGS throttling (HTTP 429 + Retry-After)."""
    while True:
        time.sleep(REQUEST_DELAY)
        r = session.get(url, timeout=60, **kwargs)
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", 60)) + 5
            print(f"[throttled] waiting {wait}s")
            time.sleep(wait)
            continue
        r.raise_for_status()
        return r


def is_image(url):
    return Path(url.split("?")[0]).suffix.lower() in IMAGE_EXTS


def fetch_observations(norad_id, start, end, modes):
    """All 'good' observations of a satellite in [start, end], following pagination."""
    url = API
    params = {
        "norad_cat_id": norad_id,
        "status": "good",
        "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if end:
        params["end"] = end.strftime("%Y-%m-%dT%H:%M:%SZ")
    if len(modes) == 1:
        params["transmitter_mode"] = next(iter(modes))  # fewer pages; also checked in wanted()
    while url:
        r = get(url, params=params)
        yield from r.json()
        url = r.links.get("next", {}).get("url")
        params = None  # the next url already carries the query


def station_images(obs, endings=()):
    """Images the station uploaded; with endings, only names ending in one of them."""
    urls = [d["payload_demod"] for d in obs["demoddata"] if is_image(d["payload_demod"])]
    if endings:
        urls = [u for u in urls if Path(u.split("?")[0]).stem.lower().endswith(endings)]
    return urls


def audio_url(obs):
    # older observations are moved to archive.org: payload is empty, archive_url has the .ogg
    return obs["payload"] or obs.get("archive_url")


def count_on_disk(norad_ids):
    """Passes already in downloads/ for these satellites, per station id."""
    per_station = Counter()
    for path in OUT_DIR.glob("*/observation.json"):
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if meta.get("norad_cat_id") in norad_ids:
            per_station[meta.get("station_id")] += 1
    return per_station


_apt_decode = None


def decode_apt(ogg):
    """APT image from the recording via apt_decode.py; None if it can't be imported."""
    global _apt_decode
    if _apt_decode is None:
        try:
            import apt_decode

            _apt_decode = apt_decode
        except ImportError as e:
            print(f"[decode] off ({e}) - decode later with: python apt_decode.py downloads")
            _apt_decode = False
    if not _apt_decode:
        return None
    out = ogg.with_suffix(".png")
    _apt_decode.decode_file(ogg, out)
    return out.name


def save_observation(obs, profile):
    """Downloads one observation; True if it was new and got saved."""
    images = station_images(obs, profile.images) if profile.download_images else []
    audio = audio_url(obs) if profile.download_audio else None
    urls = images + ([audio] if audio else [])
    if not urls:
        return False  # nothing to save (yet) - files can be uploaded after the pass

    start = datetime.fromisoformat(obs["start"].replace("Z", "+00:00"))
    sat = SAT_NAMES.get(obs["norad_cat_id"], str(obs["norad_cat_id"]))
    folder = OUT_DIR / f"{start:%Y%m%d_%H%M%S}_{sat}_{obs['id']}"
    meta_path = folder / "observation.json"
    if meta_path.exists():
        return False  # already downloaded

    folder.mkdir(parents=True, exist_ok=True)
    saved = []
    for url in urls:
        name = url.rsplit("/", 1)[-1]
        (folder / name).write_bytes(get(url).content)
        saved.append(name)

    # no station image to show: decode the recording here
    if DECODE_APT and audio and not images and obs["transmitter_mode"] == "APT":
        try:
            decoded = decode_apt(folder / audio.rsplit("/", 1)[-1])
            if decoded:
                saved.append(decoded)
        except Exception as e:
            print(f"[decode] {folder.name}: {e}")

    text = (
        f"Ground Station: {obs['station_name']} {sat} "
        f"{start:%d-%m-%Y %H:%M} UTC  Max Elev: {obs['max_altitude']:.0f}°"
    )
    meta = {
        "id": obs["id"],
        "text": text,
        "satellite": sat,
        "norad_cat_id": obs["norad_cat_id"],
        "start": obs["start"],
        "end": obs["end"],
        "station_id": obs["ground_station"],
        "station_name": obs["station_name"],
        "station_lat": obs["station_lat"],
        "station_lng": obs["station_lng"],
        "max_altitude": obs["max_altitude"],
        "rise_azimuth": obs["rise_azimuth"],
        "set_azimuth": obs["set_azimuth"],
        "transmitter": obs["transmitter_description"],
        "mode": obs["transmitter_mode"],
        "waterfall_status": obs["waterfall_status"],
        "files": saved,
        "waterfall": obs["waterfall"],
        "url": f"https://network.satnogs.org/observations/{obs['id']}/",
        "profile": profile.name,
    }
    # written last, so an interrupted download is retried on the next run
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[saved] [{profile.name}] {folder.name}  {obs['station_name']}  files={len(saved)}")
    return True


class Profile:
    def __init__(self, name, cfg):
        def opt(key, default=""):
            return (cfg.get(key) or default).strip()

        def ints(key, default=""):
            return [int(x) for x in opt(key, default).split(",") if x.strip()]

        self.name = name
        self.norad_ids = ints("NORAD_IDS", "57166,59051")
        self.station_ids = set(ints("STATION_IDS"))
        self.modes = {m.strip() for m in opt("MODES").split(",") if m.strip()}
        self.min_elevation = float(opt("MIN_ELEVATION", "0"))
        self.require_signal = opt("REQUIRE_SIGNAL", "0") == "1"
        self.min_station_images = int(opt("MIN_STATION_IMAGES", "0"))
        self.images = tuple(x.strip().lower() for x in opt("IMAGES").split(",") if x.strip())
        self.audio_only = opt("AUDIO_ONLY", "no").lower()  # no | signal | any
        self.download_images = opt("DOWNLOAD_IMAGES", "1") == "1"
        self.download_audio = opt("DOWNLOAD_AUDIO", "0") == "1"
        self.max_per_station = int(opt("MAX_PER_STATION", "0"))
        self.max_per_window = int(opt("MAX_PER_WINDOW", "0"))
        self.max_passes = int(opt("MAX_PASSES", "0"))
        self.window = timedelta(hours=float(opt("WINDOW_HOURS", "24")))
        self.lookback = timedelta(hours=float(opt("LOOKBACK_HOURS", "24")))
        self.per_station = count_on_disk(self.norad_ids)
        self.done = False
        self.next_poll = 0.0

        backwards_from = opt("BACKWARDS_FROM")
        start = parse_time(opt("START"))
        if backwards_from:
            self.mode = "backwards"
            self.cursor = parse_time(backwards_from)
            self.floor = parse_time(opt("BACKWARDS_TO")) or datetime(2015, 1, 1, tzinfo=timezone.utc)
            # "now" stays "now" across restarts, so the walk still resumes
            self.progress_key = "now" if backwards_from.lower() == "now" else self.cursor.isoformat()
            progress_name = "backwards_progress.json" if name == "default" else f"progress_{name}.json"
            self.progress_path = OUT_DIR / progress_name
            if self.progress_path.exists():
                p = json.loads(self.progress_path.read_text(encoding="utf-8"))
                if p.get("from") == self.progress_key:  # same search -> resume
                    self.cursor = datetime.fromisoformat(p["next_end"])
        elif start:
            self.mode = "range"
            self.cursor = start
            self.until = parse_time(opt("END")) or datetime.now(timezone.utc)
        else:
            self.mode = "poll"

    @property
    def total(self):
        return sum(self.per_station.values())

    def full(self):
        return self.max_passes > 0 and self.total >= self.max_passes

    def describe(self):
        images = f"images ({', '.join(self.images)})" if self.images else "images"
        what = " + ".join(w for w, on in ((images, self.download_images), ("audio", self.download_audio)) if on)
        where = f"stations {sorted(self.station_ids)}" if self.station_ids else "all stations"
        if self.mode == "backwards":
            dates = f"backwards {self.cursor:%Y-%m-%d} -> {self.floor:%Y-%m-%d}"
        elif self.mode == "range":
            dates = f"{self.cursor:%Y-%m-%d} -> {self.until:%Y-%m-%d}"
        else:
            dates = f"polling every {POLL_SECONDS}s"
        on_disk = f"{self.total} on disk from {len(self.per_station)} stations"
        return f"[{self.name}] {what}, NORAD {self.norad_ids}, {where}, {dates}, {on_disk}"

    def wanted(self, obs):
        """Filters for "there is something in this recording", plus station variety."""
        if self.station_ids and obs["ground_station"] not in self.station_ids:
            return False
        if self.modes and obs["transmitter_mode"] not in self.modes:
            return False
        if (obs["max_altitude"] or 0) < self.min_elevation:
            return False
        signal = obs.get("waterfall_status") == "with-signal"
        if self.require_signal and not signal:
            return False
        if self.max_per_station and self.per_station[obs["ground_station"]] >= self.max_per_station:
            return False
        if len(station_images(obs, self.images)) >= self.min_station_images:
            return True
        # too few station images: keep it only for its recording (decoded here)
        if not (self.download_audio and audio_url(obs)):
            return False
        return self.audio_only == "any" or (self.audio_only == "signal" and signal)

    def run_window(self, start, end):
        for norad_id in self.norad_ids:
            kept = 0
            for obs in fetch_observations(norad_id, start, end, self.modes):
                if self.full():
                    return
                if not self.wanted(obs):
                    continue
                try:
                    if save_observation(obs, self):
                        self.per_station[obs["ground_station"]] += 1
                        kept += 1
                except Exception as e:
                    print(f"[error] [{self.name}] observation {obs['id']}: {e}")
                if self.max_per_window and kept >= self.max_per_window:
                    break  # skips the rest of this window's pages too

    def step(self):
        """One window of work; False when there was nothing to do (yet)."""
        if self.full():
            print(f"[{self.name}] {self.total} passes on disk, MAX_PASSES reached - done")
            self.done = True
            return False

        if self.mode == "poll":
            if time.time() < self.next_poll:
                return False
            self.next_poll = time.time() + POLL_SECONDS
            self.run_window(datetime.now(timezone.utc) - self.lookback, None)
            return True

        if self.mode == "backwards":
            if self.cursor <= self.floor:
                print(f"[{self.name}] reached {self.floor:%Y-%m-%d}, done")
                self.done = True
                return False
            start = max(self.cursor - self.window, self.floor)
            print(f"[{self.name}] {start:%Y-%m-%d %H:%M} -> {self.cursor:%Y-%m-%d %H:%M}")
            self.run_window(start, self.cursor)
            if self.full():
                return True  # window not finished: kept for a later run with a higher MAX_PASSES
            self.cursor = start
            OUT_DIR.mkdir(parents=True, exist_ok=True)
            self.progress_path.write_text(
                json.dumps({"from": self.progress_key, "next_end": start.isoformat()}),
                encoding="utf-8",
            )
            return True

        if self.cursor >= self.until:
            print(f"[{self.name}] range done")
            self.done = True
            return False
        end = min(self.cursor + self.window, self.until)
        print(f"[{self.name}] {self.cursor:%Y-%m-%d %H:%M} -> {end:%Y-%m-%d %H:%M}")
        self.run_window(self.cursor, end)
        self.cursor = end
        return True


def load_profiles(names):
    if not names:
        return [Profile("default", os.environ)]
    profiles = []
    for name in names:
        path = PROFILE_DIR / f"{name}.env"
        if not path.exists():
            sys.exit(f"profile not found: {path}")
        profiles.append(Profile(name, dotenv_values(path)))
    return profiles


def main():
    names = sys.argv[1:] or [n.strip() for n in (os.getenv("PROFILES") or "").split(",") if n.strip()]
    profiles = load_profiles(names)
    for p in profiles:
        print(p.describe())

    while True:
        active = [p for p in profiles if not p.done]
        if not active:
            print("All profiles done")
            return
        worked = False
        for p in active:
            try:
                worked = p.step() or worked
            except Exception as e:
                print(f"[error] [{p.name}] {e}")
                time.sleep(30)  # network trouble: back off, the window is retried
        if not worked:
            time.sleep(5)  # only polling profiles left, waiting for their next poll


if __name__ == "__main__":
    main()
