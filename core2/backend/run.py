"""Starts the backend as the doce-brain service does: on every IPv6 and IPv4 address ("::"), or on IPv4
only ("0.0.0.0") when IPv6 is turned off on this machine (then "::" can't be opened at all).
    .venv/bin/python run.py [port]
"""

import socket
import sys

import uvicorn


def pick_host() -> str:
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as s:
            s.bind(("::", 0))
        return "::"
    except OSError:
        return "0.0.0.0"


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    host = pick_host()
    print(f"listening on {'[::] (IPv6 + IPv4)' if host == '::' else '0.0.0.0 (IPv4 only, IPv6 is off)'}:{port}",
          flush=True)
    uvicorn.run("main:app", host=host, port=port)
