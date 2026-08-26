"""
Interactive runner for simulated devices. Add devices to the list below,
flip `enabled` to control which ones actually start, then use it live:

    > list
    > stop SIM-ANEMOMETER-01
    > crash SIM-ANEMOMETER-01
    > start SIM-ANEMOMETER-01
    > quit
"""

from devices.anemometer import AnemometerSimulator

devices = [
    AnemometerSimulator(
        device_id="SIM-ANEMOMETER-01",
        zone="outdoor",
        telemetry_interval=2.0,
        enabled=True,
    ),
    # Add more simulated devices here, e.g. a second anemometer, or a new
    # subclass for another sensor type — same pattern.
]


def find(device_id):
    return next((d for d in devices if d.device_id == device_id), None)


def main():
    for d in devices:
        if d.enabled:
            d.start()
        else:
            print(f"[{d.device_id}] skipped (enabled=False)")

    print("\nCommands: list | start <id> | stop <id> | crash <id> | quit\n")

    try:
        while True:
            raw = input("> ").strip().split()
            if not raw:
                continue
            cmd, *args = raw

            if cmd == "quit":
                break

            elif cmd == "list":
                for d in devices:
                    state = "running" if d.is_running else "stopped"
                    print(f"  {d.device_id:24s} {d.device_type:20s} {state}")

            elif cmd in ("start", "stop", "crash"):
                if not args:
                    print(f"usage: {cmd} <device_id>")
                    continue
                target = find(args[0])
                if not target:
                    print(f"no device named {args[0]!r} — try 'list'")
                    continue
                getattr(target, cmd)()

            else:
                print("unknown command — try: list | start <id> | stop <id> | crash <id> | quit")

    except (KeyboardInterrupt, EOFError):
        pass
    finally:
        print("\nshutting down...")
        for d in devices:
            d.stop()


if __name__ == "__main__":
    main()
