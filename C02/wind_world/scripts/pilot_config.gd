class_name PilotConfig
extends Resource
## How the camera is steered: which device drives it, and how hard.
##
## Edit res://imu/pilot_default.tres to switch source at design time, press F5
## while running to cycle, or send the PILOT command from the dashboard.

enum Source {
	AUTO,   ## nobody steers; the wind carries us (the original behaviour)
	MOUSE,  ## left-drag turns, wheel sets speed
	MQTT,   ## carried by the anemometer on the bus -- see the MQTT group below
}

## MQTT by default: in the gallery the piece is driven by the wind readings on
## the bus. It drops to AUTO by itself while the broker is unreachable.
@export var source: Source = Source.MQTT
## Keep the mouse working even when something else is steering. Handy while
## building; turn it off for the installation so a stray mouse cannot hijack it.
@export var allow_mouse_override: bool = true

@export_group("Mouse")
@export var mouse_turn_speed: float = 0.25 ## degrees of heading per pixel dragged
@export var wheel_step: float = 1.15       ## speed multiplier per wheel notch

@export_group("MQTT (driven by the wind on the bus)")
## Travel downwind: the heading swings to follow the wind direction the
## anemometer reports. Off, and MQTT only controls speed, not where you go.
@export var mqtt_follow_wind: bool = true
## Degrees per second the heading swings toward the wind. The wind is an
## absolute bearing, not a nudge, so this is what stops it snapping round.
@export var mqtt_turn_rate_deg: float = 12.0
## Travel speed, in metres per second, per metre per second of wind. 1.0 means
## the world moves at exactly the speed the anemometer reports, which is the
## honest reading of "carried by the wind". Raise it if real wind is too
## sedate to watch.
##
## These are in m/s rather than an abstract throttle on purpose. Pilot divides
## World.forward_speed_base and scroll_speed_scale back out, so what you set
## here is what you actually travel at -- an earlier version multiplied the
## wind in twice and 0.5 m/s of wind came out as 0.28 m/s of travel.
@export var mqtt_speed_per_ms: float = 3.0
## The drift that remains in dead calm. Slow, but not stopped.
@export var mqtt_min_speed: float = 0.4
@export var mqtt_max_speed: float = 16.0
## How settled the prevailing direction has to be (0..1) before we turn at
## all. A vane that is not turning still reports an angle and that angle
## wanders; requiring a steady tendency is what stops the view wobbling when
## nothing is really happening. See WindInput.tendency_steadiness.
@export_range(0.0, 1.0) var mqtt_steer_min_steady: float = 0.12
## Degrees of heading error to simply ignore. Even a well-settled tendency
## moves a degree here and there, and chasing those micro-corrections is the
## wobble you can see -- inside this band the heading is left exactly where it
## is. Correction ramps in smoothly over the next band-and-a-half rather than
## switching on at the edge, which would trade the wobble for a twitch.
@export_range(0.0, 30.0) var mqtt_heading_deadband_deg: float = 7.0

## No readings at all is different from a reading of zero: nothing on the
## topic means we genuinely do not know, so we stand still and wait.
@export var mqtt_stop_when_silent: bool = true
## While the broker is unreachable, fall back to this rather than standing
## still forever. AUTO is the simulated breeze the piece ships with.
@export var mqtt_offline_fallback: Source = Source.AUTO
