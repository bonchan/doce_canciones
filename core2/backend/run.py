"""Starts the backend as the doce-brain service does, reachable over IPv6 and IPv4 on one port.
    .venv/bin/python run.py [port]

Why not `uvicorn --host ::`: Python's asyncio marks an IPv6 socket "IPv6 only", so IPv4 (127.0.0.1,
192.168.x.x, and .local names that resolve to IPv4) would be refused. Here the socket is opened by hand with
IPv4 allowed on it too, and handed to uvicorn. If IPv6 is turned off on the machine, it's IPv4 only.
"""

import socket
import sys

import uvicorn


def open_socket(port: int) -> tuple[socket.socket, str]:
    try:
        sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)     # IPv4 too
        sock.bind(("::", port))
        return sock, f"[::]:{port} (IPv6 + IPv4)"
    except OSError as e:
        sock.close()
        if e.errno == getattr(socket, "EADDRINUSE", 98) or "in use" in str(e).lower():
            raise
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", port))
    return sock, f"0.0.0.0:{port} (IPv4 only, IPv6 is off)"


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    sock, where = open_socket(port)
    print(f"listening on {where}", flush=True)
    server = uvicorn.Server(uvicorn.Config("main:app", port=port))
    server.run(sockets=[sock])
