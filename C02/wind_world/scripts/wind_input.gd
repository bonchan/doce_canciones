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
## Use tools/serial_bridge.py to turn a serial/USB anemometer into this UDP
## stream. If no packets arrive, WindInput falls back to a gentle simulated
## breeze (and optional keyboard override) so the piece still runs, and the
## installation computer, without hardware attached.

signal wind_changed(speed_ms: float, direction: Vector2)

@export var udp_port: int = 9000
@export var enable_simulation_fallback: bool = true
@export var enable_keyboard_override: bool = true
@export var smoothing_speed: float = 2.5      ## higher = wind reacts faster to new readings
@export var max_speed_ms: float = 18.0        ## anemometer readings are clamped to this
@export var silence_timeout_sec: float = 3.0  ## no packets for this long -> assume sim/offline

## Smoothed, ready-to-use values. direction is a unit Vector2 in XZ terms
## (x = east/west, y = north/south) already normalized.
var current_speed: float = 0.0
var current_direction: Vector2 = Vector2.RIGHT

var _target_speed: float = 0.0
var _target_direction: Vector2 = Vector2.RIGHT

var _udp := PacketPeerUDP.new()
var _noise := FastNoiseLite.new()
var _time: float = 0.0
var _last_packet_time: float = -999.0
var _sim_dir_deg: float = 0.0
var _bind_ok := false


func _ready() -> void:
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

	wind_changed.emit(current_speed, current_direction)


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


## Convenience for other scripts/UI: 0..1 normalized speed.
func get_speed_normalized() -> float:
	return clamp(current_speed / max_speed_ms, 0.0, 1.0)
