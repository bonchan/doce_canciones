extends Node
## WindInput (autoload singleton)
##
## Single source of truth for wind speed + direction. Everything else in the
## project (world scroll, grass bend, sky mood) reads current_speed /
## current_direction from here — nothing else touches the network.
##
## Data comes in over UDP as plain text: "speed,direction_deg\n"
##   speed        : meters/second, >= 0
##   direction_deg: compass-style degrees, 0..360, the direction the wind
##                  is coming FROM (matches most anemometer firmware).
## Example packet: "3.4,225.0"
##
## Wind also arrives over MQTT, which is how the installation actually feeds
## it: any device on the bus publishing wind_speed and wind_direction in its
## telemetry (the real anemometer, or the simulator in
## core2/simulator/devices/anemometer.py) is picked up automatically, whatever
## zone or id it turns up under. The dashboard can also set the wind by hand
## with the WIND command, which simply overrides the same two targets.
##
## If nothing arrives from any source, WindInput falls back to a gentle
## simulated breeze (and optional keyboard override) so the piece still runs
## on an installation computer with no hardware attached.

signal wind_changed(speed_ms: float, direction: Vector2)

@export var udp_port: int = 9000
@export var enable_simulation_fallback: bool = true
@export var enable_keyboard_override: bool = true
@export var smoothing_speed: float = 2.5      ## higher = wind reacts faster to new readings
@export var max_speed_ms: float = 18.0        ## anemometer readings are clamped to this
@export var silence_timeout_sec: float = 3.0
## Roughly how long the prevailing direction takes to swing round to a new
## one. Long is the point: this is meant to be the shape of the afternoon, not
## of the last gust.
@export var tendency_seconds: float = 45.0
## Wind speed at which a reading gets a full vote in the prevailing direction.
## Below it the reading still counts, just proportionally less.
@export var tendency_full_wind: float = 3.0  ## no packets for this long -> assume sim/offline

## Smoothed, ready-to-use values. direction is a unit Vector2 in XZ terms
## (x = east/west, y = north/south) already normalized.
var current_speed: float = 0.0
var current_direction: Vector2 = Vector2.RIGHT

## The PREVAILING direction, as opposed to the instantaneous one above.
##
## A vane answers every gust and eddy, so steering straight off
## current_direction wanders even in steady wind, and in calm it wanders on
## pure noise. This is a running vector mean instead: each reading is added as
## a vector weighted by how hard it was blowing at the time, and the sum
## decays. Strong wind therefore votes loudly, a becalmed vane barely votes at
## all, and what comes out is where the wind has actually been going lately.
##
## tendency_steadiness is the length of that sum before normalising, 0..1. It
## falls out of the same arithmetic for free and is genuinely useful: near 1
## the wind has held one direction, near 0 it has been swirling or absent, so
## a steering source can simply decline to turn until it means something.
var tendency: Vector2 = Vector2.RIGHT
var tendency_steadiness: float = 0.0
var _tendency_sum: Vector2 = Vector2.ZERO

var _target_speed: float = 0.0
var _target_direction: Vector2 = Vector2.RIGHT

var _udp := PacketPeerUDP.new()
var _noise := FastNoiseLite.new()
var _time: float = 0.0
var _last_packet_time: float = -999.0
var _sim_dir_deg: float = 0.0
var _bind_ok := false


func _ready() -> void:
	# Any telemetry carrying wind_speed / wind_direction counts as an
	# anemometer -- we do not care which device it is.
	if not Device.wind_topic.is_empty():
		Device.subscribe_topic(Device.wind_topic)
		Device.message.connect(_on_bus_message)
	_bind_ok = _udp.bind(udp_port) == OK
	if not _bind_ok:
		push_warning("WindInput: could not bind UDP port %d, network wind disabled" % udp_port)
	_noise.seed = randi()
	_noise.frequency = 0.4
	# Start already facing somewhere so the first frame isn't a snap.
	_sim_dir_deg = randf() * 360.0
	current_direction = Vector2.from_angle(deg_to_rad(_sim_dir_deg))
	_target_direction = current_direction


func _process(delta: float) -> void:
	_time += delta

	if _bind_ok:
		_read_udp_packets()

	var live := (_time - _last_packet_time) <= silence_timeout_sec
	if not live:
		if enable_keyboard_override and _read_keyboard(delta):
			pass
		elif enable_simulation_fallback:
			_simulate(delta)

	var t: float = clamp(smoothing_speed * delta, 0.0, 1.0)
	current_speed = lerp(current_speed, _target_speed, t)
	current_direction = current_direction.normalized().slerp(_target_direction.normalized(), t).normalized()

	_update_tendency(delta)
	wind_changed.emit(current_speed, current_direction)


## Telemetry from anywhere on the bus. Two fields make it an anemometer.
func _on_bus_message(_topic: String, payload: String) -> void:
	var data: Variant = JSON.parse_string(payload)
	if not (data is Dictionary) or not data.has("wind_speed"):
		return
	set_wind(float(data["wind_speed"]), float(data.get("wind_direction", 0.0)))


## Wind set by hand from the dashboard (the WIND command). Feeds the same two
## targets as the anemometer, so a slider simply wins until the next real
## reading arrives -- and if the anemometer is silent, it holds.
func set_wind(speed_ms: float, direction_deg: float) -> void:
	_target_speed = clamp(speed_ms, 0.0, max_speed_ms)
	var rad := deg_to_rad(direction_deg)
	_target_direction = Vector2(sin(rad), cos(rad))
	_last_packet_time = _time


## Running, speed-weighted vector mean of the direction. See `tendency`.
func _update_tendency(delta: float) -> void:
	# How much this reading gets to say. A vane that is not turning is not
	# reporting a direction, it is reporting noise.
	var vote: float = clamp(current_speed / max(tendency_full_wind, 0.01), 0.0, 1.0)
	var k: float = clamp(delta / max(tendency_seconds, 0.01), 0.0, 1.0)
	_tendency_sum = _tendency_sum.lerp(current_direction.normalized() * vote, k)
	tendency_steadiness = clamp(_tendency_sum.length(), 0.0, 1.0)
	# Below that the sum is too short to have a meaningful angle, so hold the
	# last one rather than spinning on rounding error.
	if tendency_steadiness > 0.02:
		tendency = _tendency_sum.normalized()


func _read_udp_packets() -> void:
	while _udp.get_available_packet_count() > 0:
		var bytes: PackedByteArray = _udp.get_packet()
		var text := bytes.get_string_from_utf8().strip_edges()
		if _parse_packet(text):
			_last_packet_time = _time


func _parse_packet(text: String) -> bool:
	var parts := text.split(",")
	if parts.size() < 2:
		return false
	var speed := parts[0].to_float()
	var deg := parts[1].to_float()
	_target_speed = clamp(speed, 0.0, max_speed_ms)
	var rad := deg_to_rad(deg)
	# Compass degrees (0 = North = +Y/-Z-ish) -> XZ unit vector.
	_target_direction = Vector2(sin(rad), cos(rad))
	return true


## Returns true if a key was actually held (so simulation doesn't also run).
func _read_keyboard(delta: float) -> bool:
	var used := false
	var move := Vector2.ZERO
	if Input.is_key_pressed(KEY_UP) or Input.is_key_pressed(KEY_W):
		move.y -= 1.0
		used = true
	if Input.is_key_pressed(KEY_DOWN) or Input.is_key_pressed(KEY_S):
		move.y += 1.0
		used = true
	if Input.is_key_pressed(KEY_LEFT) or Input.is_key_pressed(KEY_A):
		move.x -= 1.0
		used = true
	if Input.is_key_pressed(KEY_RIGHT) or Input.is_key_pressed(KEY_D):
		move.x += 1.0
		used = true
	if move.length() > 0.01:
		_target_direction = move.normalized()

	if Input.is_key_pressed(KEY_EQUAL) or Input.is_key_pressed(KEY_KP_ADD):
		_target_speed = clamp(_target_speed + 6.0 * delta, 0.0, max_speed_ms)
		used = true
	if Input.is_key_pressed(KEY_MINUS) or Input.is_key_pressed(KEY_KP_SUBTRACT):
		_target_speed = clamp(_target_speed - 6.0 * delta, 0.0, max_speed_ms)
		used = true

	return used


func _simulate(delta: float) -> void:
	# Slow wandering direction + gusty speed, purely for previewing the
	# installation without an anemometer connected.
	_sim_dir_deg += sin(_time * 0.05) * 12.0 * delta
	var gust: float = _noise.get_noise_1d(_time * 8.0) * 0.5 + 0.5
	_target_speed = 1.2 + gust * 5.5
	_target_direction = Vector2.from_angle(deg_to_rad(_sim_dir_deg))


## Is a real reading arriving, as opposed to the simulated fallback breeze?
## Pilot needs the difference: a reported wind of zero is dead calm and should
## still drift, but NO reading at all means we do not know anything and should
## wait rather than invent movement.
func is_live() -> bool:
	return (_time - _last_packet_time) <= silence_timeout_sec


## Convenience for other scripts/UI: 0..1 normalized speed.
func get_speed_normalized() -> float:
	return clamp(current_speed / max_speed_ms, 0.0, 1.0)
