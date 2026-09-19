class_name ImuConfig
extends Resource
## Where the MPU-6050 data comes from. Make one via FileSystem > New Resource >
## ImuConfig (see imu/imu_default.tres). Later this can gain an MQTT source.

## Serial port name, e.g. "COM5". Leave empty to just list the available ports.
@export var com_port: String = "COM5"
@export var baud_rate: int = 115200
@export var print_values: bool = false
## Print only every Nth sample (the board sends ~50 Hz).
@export_range(1, 100) var print_every: int = 5

@export_group("Tilt")
## Complementary filter: how much to trust the gyro (smooth but drifts) over
## the accelerometer (absolute but shaken by every footstep).
##
## This is the knob that decides how QUICKLY a lean registers. The
## accelerometer only pulls the angle over by (1 - gyro_trust) per sample, so
## 0.98 takes the best part of a second to catch up and the plank feels dead;
## 0.9 lands in about 0.15s. Raise it if footsteps make the view twitch, lower
## it if leaning feels laggy. 0 = accelerometer only, no gyro at all.
@export_range(0.0, 0.999) var gyro_trust: float = 0.9
## Seconds of readings averaged into "upright" at startup. Stand still in your
## neutral pose while the scene loads; press F6 to re-zero at any time.
@export var calibration_sec: float = 1.5
