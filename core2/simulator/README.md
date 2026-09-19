# Device simulator

Fake devices that speak the exact same MQTT schema real ESP32 boards do
(`device_base.h`) — same topics, LWT, retained status/announce, command
handling — so the backend and dashboard can't tell them apart from
hardware. Useful for testing without physically flashing/deploying boards.

- `simulated_device.py` — the base class. Handles all the MQTT plumbing.
- `devices/anemometer.py` — example subclass generating fake wind data.
- `run_simulation.py` — instantiate devices here, run it, control them live.

## Setup

```
cd core2/simulator
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # point at whatever broker you're testing against
python run_simulation.py
```

## Adding a new simulated device type

Subclass `SimulatedDevice`, set `device_type`/`capabilities` in `__init__`,
and override `read_telemetry()` to return a dict each tick:

```python
class MySensorSimulator(SimulatedDevice):
    def __init__(self, device_id, zone, **kwargs):
        super().__init__(
            device_id=device_id,
            zone=zone,
            device_type="sensor.my_sensor",
            capabilities={"publishes": ["some_value"], "subscribes": ["IDENTIFY", "ALTER"]},
            **kwargs,
        )

    def read_telemetry(self):
        return {"some_value": ...}
```

Override `on_command(capability, params)` too if the device needs to react
to something beyond the shared `IDENTIFY`/`ALTER` defaults — call
`super().on_command(...)` first if you still want those to keep working.

Then add an instance to the `devices` list in `run_simulation.py`.

## Enable / disable

Each device takes `enabled=True/False` in its constructor — `run_simulation.py`
only calls `.start()` on the ones that are `enabled`, so you can flip devices
on/off by editing that list without deleting anything.

At runtime, from the `>` prompt: `stop <id>` and `start <id>` toggle a
device live. There's also `crash <id>`, which is different from `stop` —
`stop` disconnects cleanly and publishes `offline` itself, while `crash`
yanks the connection so the broker's Last Will fires instead. Use `crash`
specifically when you want to test the backend's LWT/offline-detection path,
since that's what a real device losing power actually looks like — `stop`
doesn't exercise that path at all.
