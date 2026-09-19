import random

from simulated_device import SimulatedDevice


class AnemometerSimulator(SimulatedDevice):
    """Fake wind sensor — publishes wind_speed (m/s) and wind_direction
    (degrees) as a slow random walk, so it drifts around like real wind
    rather than jumping to a new random value every tick."""

    def __init__(self, device_id, zone, **kwargs):
        super().__init__(
            device_id=device_id,
            zone=zone,
            device_type="sensor.anemometer",
            capabilities={
                "publishes": ["wind_speed", "wind_direction"],
                "subscribes": ["IDENTIFY", "ALTER"],
            },
            **kwargs,
        )
        self._speed = 5.0       # m/s
        self._direction = 180.0  # degrees

    def read_telemetry(self) -> dict:
        self._speed = max(0.0, self._speed + random.uniform(-0.5, 0.5))
        self._direction = (self._direction + random.uniform(-8, 8)) % 360

        return {
            "wind_speed": round(self._speed, 2),
            "wind_direction": round(self._direction, 1),
        }
