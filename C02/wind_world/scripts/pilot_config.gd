class_name PilotConfig
extends Resource
## How the camera is steered: which device drives it, and how hard.
##
## Edit res://imu/pilot_default.tres to switch source at design time, or press
## F5 while running to cycle. The port/baud for SERIAL live in ImuConfig
## (res://imu/imu_default.tres) -- this resource is only about steering feel.

enum Source {
	AUTO,   ## nobody steers; the wind carries us (the original behaviour)
	MOUSE,  ## left-drag turns, wheel sets speed
	SERIAL, ## MPU-6050 over USB via ImuInput
	MQTT,   ## same numbers over the network -- NOT IMPLEMENTED YET
}

@export var source: Source = Source.MOUSE
## Keep the mouse working even when source is SERIAL/MQTT. Handy while
## building; turn it off for the installation so a stray mouse can't hijack it.
@export var allow_mouse_override: bool = true

@export_group("Mouse")
@export var mouse_turn_speed: float = 0.25 ## degrees of heading per pixel dragged
@export var wheel_step: float = 1.15       ## speed multiplier per wheel notch

@export_group("Plank turn (lean left / right)")
## Turning works like the mouse drag: lean and the heading keeps coming round,
## centre and it stops where it is. Degrees of tilt that mean "full turn".
@export_range(2.0, 45.0) var turn_range_deg: float = 14.0
## Tilt smaller than this is treated as standing still, so the camera doesn't
## creep while you just balance. Raise it if the view wanders on its own.
@export_range(0.0, 15.0) var turn_deadzone_deg: float = 2.0
## Degrees of heading per second at full lean.
@export var turn_rate_deg: float = 100.0
@export var invert_turn: bool = false
## 1 = linear and immediate. Above ~1.5 small leans get weak and the turn
## feels like it lags, so keep this low.
@export_range(1.0, 4.0) var turn_expo: float = 1.25

@export_group("Plank speed (lean forward / back)")
## Speed works like the mouse wheel, not like a pedal: leaning forward winds
## the speed UP, coming back to centre HOLDS whatever you reached, and leaning
## back winds it down to a stop.
@export_range(2.0, 45.0) var speed_range_deg: float = 14.0
@export_range(0.0, 15.0) var speed_deadzone_deg: float = 3.0
## True to match how the sensor sits on the plank right now: the axis reads
## backwards, so leaning forward would otherwise slow you down. Untick if you
## remount the board the other way round.
@export var invert_speed: bool = true
## Speed multiplier gained per second at full forward lean.
@export var accelerate_per_sec: float = 0.9
## Speed multiplier shed per second at full back lean. Higher than
## accelerate_per_sec so you can always stop sooner than you started.
@export var brake_per_sec: float = 1.4
@export var max_throttle: float = 6.0
## Speed on the first frame. 0 = you arrive stopped and have to lean forward
## to get going; 1 = the piece is already drifting when nobody is on the plank.
@export var start_throttle: float = 0.0
## Gentler near centre, so you can trim the speed in small amounts once you
## are up to pace instead of slamming between stop and full.
@export_range(1.0, 4.0) var speed_expo: float = 2.0

@export_group("Plank filtering")
## Higher = the plank reacts faster, but transfers more of your footsteps.
@export var stick_smoothing: float = 14.0
