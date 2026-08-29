#!/usr/bin/env python3
"""Tiny standalone file server — stdlib only, nothing to pip install.

Why this exists as its own thing, separate from backend/: the FastAPI
"brain" (backend/) can run wherever's convenient — a laptop off the
installation network while developing, the NUC in production — but devices
on the installation LAN always need one stable, always-reachable place to
download files from (currently just audio clips, see
esp32C3_organismo/organismo_audio.h's AUDIO_UPDATE). Run THIS one thing
permanently on the NUC and point backend/.env's AUDIO_SERVER_URL at it —
everything else (where the brain itself happens to be running) stops
mattering for file delivery.

Usage:
    python3 server.py [port] [files_dir]
Defaults: port 8090, files_dir "./files" next to this script (created if
missing). No auth, no HTTPS — this is meant to sit on a private
installation LAN behind whatever perimeter that network already has, the
same trust level as the MQTT broker it lives next to. Don't expose this
port to the open internet.

Endpoints:
    PUT/POST /<filename>   body = raw file bytes -> saved as <filename>
    GET      /<filename>   -> that file's raw bytes, or 404
    DELETE   /<filename>   -> removes it, or 404
    GET      /             -> "ok" — hit this to sanity-check reachability
                               (curl http://nuc.local:8090/) before
                               debugging anything more complicated.
"""

import sys
import re
import shutil
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
FILES_DIR = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).parent / "files"
FILES_DIR.mkdir(parents=True, exist_ok=True)

# Only a bare filename — no slashes, no "..", nothing that could escape
# FILES_DIR. Every handler below runs the requested path through this
# before touching the filesystem; None means "reject the request."
_SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")


def safe_path(raw_path: str):
    name = unquote(raw_path).lstrip("/")
    if not name or not _SAFE_NAME.match(name):
        return None
    return FILES_DIR / name


class Handler(BaseHTTPRequestHandler):
    server_version = "TinyFileServer/1.0"

    def _respond(self, code: int, message: str):
        body = message.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/":
            return self._respond(200, "ok")

        path = safe_path(self.path)
        if path is None:
            return self._respond(400, "invalid filename")
        if not path.is_file():
            return self._respond(404, "not found")

        ctype, _ = mimetypes.guess_type(str(path))
        size = path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.end_headers()
        with path.open("rb") as f:
            shutil.copyfileobj(f, self.wfile)

    def do_PUT(self):
        path = safe_path(self.path)
        if path is None:
            return self._respond(400, "invalid filename")

        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return self._respond(411, "Content-Length required")

        # Written to a temp file and renamed into place atomically, so a
        # GET racing an in-progress upload never sees a half-written file.
        tmp = path.with_name(path.name + ".part")
        remaining = length
        with tmp.open("wb") as f:
            while remaining > 0:
                chunk = self.rfile.read(min(65536, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        if remaining > 0:
            tmp.unlink(missing_ok=True)
            return self._respond(400, "connection closed before all bytes were received")

        tmp.replace(path)
        self._respond(200, "ok")

    # POST is accepted as a synonym for PUT — some HTTP clients find POST
    # more natural for "here are some bytes"; this server treats both the
    # same way (raw body -> saved under this name).
    do_POST = do_PUT

    def do_DELETE(self):
        path = safe_path(self.path)
        if path is None:
            return self._respond(400, "invalid filename")
        if not path.is_file():
            return self._respond(404, "not found")
        path.unlink()
        self._respond(200, "ok")

    def log_message(self, fmt, *args):
        print(f"[{self.address_string()}] {fmt % args}")


if __name__ == "__main__":
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"file_server listening on 0.0.0.0:{PORT}, serving {FILES_DIR}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
