"""Updating the NUC from the web page: what is new on GitHub, then pull, rebuild and restart.

core2 lives inside the bigger doce_canciones repo, so most commits (other songs, C01..C12, arduino
sketches) don't touch what the NUC runs. Only commits changing APP_PATHS need a rebuild; the others are
just pulled.

The update itself runs as its own systemd unit (doce-update.service, installed by scripts/update.sh), not
inside the backend: update.sh restarts the backend at the end, which would otherwise kill it halfway.
The backend may start that unit without a password thanks to /etc/sudoers.d/doce-canciones.
"""

import asyncio
import subprocess
import time
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException

from logger import logger
from routes import require_api_key
from system import CORE_DIR, LOGS_DIR

UNIT = "doce-update"
LOG_TAIL = 300
FETCH_EVERY = 30 * 60           # seconds between automatic checks with GitHub
PULL_ONLY = "== no rebuild"     # self_update.sh's line when it skipped update.sh

# Inside core2/, what the NUC runs or builds. Keep in step with scripts/self_update.sh.
APP_PATHS = ("backend/", "frontend/", "file_server/", "scripts/")

router = APIRouter(prefix="/api/update", tags=["update"])


class UpdateError(Exception):
    pass


def git(*args: str, timeout: float = 30) -> str:
    try:
        r = subprocess.run(["git", "-C", str(CORE_DIR), *args], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise UpdateError(f"git {args[0]}: {e}") from e
    if r.returncode != 0:
        raise UpdateError(r.stderr.strip() or f"git {args[0]} failed")
    return r.stdout


_prefix: str | None = None


def prefix() -> str:
    """core2's folder inside the repo, as git prints paths ("core2/")."""
    global _prefix
    if _prefix is None:
        _prefix = git("rev-parse", "--show-prefix").strip()
    return _prefix


def affects_app(path: str) -> bool:
    return any(path.startswith(prefix() + p) for p in APP_PATHS)


def commit_info(rev: str) -> dict:
    h, short, ts, subject = git("log", "-1", "--format=%H%x1f%h%x1f%ct%x1f%s", rev).strip().split("\x1f", 3)
    return {"hash": h, "short": short, "time": int(ts), "subject": subject}


def pending_commits(upstream: str) -> list[dict]:
    """Commits upstream that this checkout lacks, newest first, each with its files and whether any is the app's."""
    out = git("log", "--format=%H%x1f%h%x1f%an%x1f%ct%x1f%s%x1f%b%x1e", f"HEAD..{upstream}")
    commits = []
    for record in out.split("\x1e"):
        if not record.strip():
            continue
        h, short, author, ts, subject, body = record.lstrip("\n").split("\x1f", 5)
        commits.append({"hash": h, "short": short, "author": author, "time": int(ts),
                        "subject": subject, "body": body.strip(), "files": [], "affects_app": False})
    by_hash = {c["hash"]: c for c in commits}
    for chunk in git("log", "--format=%x1e%H", "--name-status", f"HEAD..{upstream}").split("\x1e"):
        lines = [line for line in chunk.splitlines() if line.strip()]
        if lines and lines[0].strip() in by_hash:
            c = by_hash[lines[0].strip()]
            for line in lines[1:]:
                parts = line.split("\t")        # "M\tpath", or "R100\told\tnew"
                c["files"].append({"status": parts[0][:1], "path": parts[-1]})
                c["affects_app"] = c["affects_app"] or any(affects_app(p) for p in parts[1:])
    return commits


_cache: dict = {}


def check(fetch: bool) -> dict:
    """Compare this checkout with its upstream branch; with `fetch`, ask GitHub first.
    `app_changes`: how many changed files the NUC uses; 0 means nothing to rebuild."""
    result = {"checked_at": time.time() if fetch else _cache.get("checked_at"), "error": None,
              "current": None, "branch": None, "upstream": None, "behind": 0, "ahead": 0,
              "commits": [], "diffstat": "", "dirty": [], "app_changes": 0,
              "app_paths": [prefix_or_blank() + p for p in APP_PATHS]}
    try:
        if fetch:
            git("fetch", "--quiet", "--prune", "origin", timeout=120)
        result["current"] = commit_info("HEAD")
        result["branch"] = git("rev-parse", "--abbrev-ref", "HEAD").strip()
        try:
            upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").strip()
        except UpdateError:
            upstream = None
        result["upstream"] = upstream
        if upstream:
            result["behind"] = int(git("rev-list", "--count", f"HEAD..{upstream}"))
            result["ahead"] = int(git("rev-list", "--count", f"{upstream}..HEAD"))
            if result["behind"]:
                result["commits"] = pending_commits(upstream)
                result["diffstat"] = git("diff", "--shortstat", "HEAD", upstream).strip()
                changed = git("diff", "--name-only", "--no-renames", f"HEAD...{upstream}").splitlines()
                result["app_changes"] = sum(1 for p in changed if p.strip() and affects_app(p.strip()))
        # tracked files changed on the NUC (untracked ones don't block a pull)
        result["dirty"] = [line[3:] for line in
                           git("status", "--porcelain", "--untracked-files=no").splitlines() if line.strip()]
    except UpdateError as e:
        result["error"] = str(e)
    _cache.clear()
    _cache.update(result)
    return result


def prefix_or_blank() -> str:
    try:
        return prefix()
    except UpdateError:
        return ""


def log_path():
    return LOGS_DIR / "update.log"


def running() -> bool:
    try:
        r = subprocess.run(["systemctl", "is-active", UNIT], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.stdout.strip() in ("active", "activating")


def last_run() -> dict | None:
    path = log_path()
    if not path.exists():
        return None
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    result = "ok" if any(l.startswith("== done") for l in lines) else \
        "failed" if any(l.startswith("== FAILED") for l in lines) else None
    return {"log": lines[-LOG_TAIL:], "result": result, "changed_at": path.stat().st_mtime,
            "pull_only": any(l.startswith(PULL_ONLY) for l in lines)}


def start() -> None:
    state = check(fetch=False)
    if state["error"]:
        raise UpdateError(state["error"])
    if running():
        raise UpdateError("an update is already running")
    if state["dirty"]:
        raise UpdateError("the checkout on the NUC has local changes: " + ", ".join(state["dirty"]))
    if state["ahead"]:
        raise UpdateError("the NUC has commits that are not on GitHub; update it by hand")
    if not state["behind"]:
        raise UpdateError("already up to date")

    log = log_path()
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text(f"== update requested {datetime.now():%Y-%m-%d %H:%M:%S}, "
                   f"{state['current']['short']} -> {state['commits'][0]['short']}\n", encoding="utf-8")
    try:
        r = subprocess.run(["sudo", "-n", "systemctl", "start", "--no-block", f"{UNIT}.service"],
                           capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise UpdateError(f"could not start the update: {e}") from e
    if r.returncode != 0:
        raise UpdateError((r.stderr.strip() or "could not start the update")
                          + " (was scripts/install.sh run on the NUC?)")


async def periodic_check():
    """Ask GitHub every FETCH_EVERY seconds so the page's "update available" badge is current."""
    while True:
        try:
            state = await asyncio.to_thread(check, True)
            if state["error"]:
                logger.warning(f"update check: {state['error']}")
        except Exception as e:      # never let this kill the app
            logger.error(f"update check failed: {e}")
        await asyncio.sleep(FETCH_EVERY)


def view(state: dict | None) -> dict:
    return {**(state or {}), "running": running(), "last_run": last_run()}


@router.get("")
async def get_update() -> dict:
    """The last check (no network), plus whether an update is running and its log."""
    state = dict(_cache) if _cache else await asyncio.to_thread(check, False)
    return await asyncio.to_thread(view, state)


@router.post("/check")
async def check_now() -> dict:
    state = await asyncio.to_thread(check, True)
    return await asyncio.to_thread(view, state)


@router.post("/apply", dependencies=[Depends(require_api_key)])
async def apply() -> dict:
    try:
        await asyncio.to_thread(start)
    except UpdateError as e:
        raise HTTPException(409, str(e))
    return await asyncio.to_thread(view, dict(_cache))
