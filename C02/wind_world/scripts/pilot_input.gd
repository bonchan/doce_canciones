extends Node
## Pilot (autoload singleton)
##
## Single source of truth for STEERING -- the one thing that says "turn this
## much this frame, travel this fast". World reads heading_delta / throttle
## from here and never touches a mouse or a sensor itself, so swapping the
## plank for a mouse (or later for MQTT) changes nothing downstream.
##
## Not to be confused with WindInput, which is the weather: how hard the wind
## blows and from where. Wind carries you; Pilot points you.
##
##   heading_delta : radians to add to the heading THIS FRAME (already * dt)
##   throttle      : multiplier on travel speed, 0 = stopped, 1 = normal
##   stick         : (turn, lean) in -1..1, for the HUD -- what the pilot asked for
##
## On the plank both axes behave like the mouse they replace. Leaning left or
## right turns for as long as you hold it and stops where you leave it, the way
## a drag does. Leaning forward winds the speed up and leaning back winds it
## down, the way the wheel does -- so coming back to centre HOLDS the speed you
## reached rather than dropping you back to a default.
##
## KEYS
##   F5  cycle source (auto -> mouse -> serial -> mqtt)
##   F6  re-zero the plank: stand still in your neutral pose and press it

signal source_changed(source: PilotConfig.Source)

@export var config: PilotConfig = preload("res://imu/pilot_default.tres")

var heading_delta: float = 0.0
var throttle: float = 1.0
var stick: Vector2 = Vector2.ZERO

## Drag accumulates here between frames and is consumed by _process.
var _mouse_turn: float = 0.0
## The wheel. In MOUSE mode this IS the throttle; over a plank it trims it.
var _mouse_throttle: float = 1.0
var _dragging: bool = false
var _warned_mqtt: bool = false
var _smoothed := Vector2.ZERO
## The plank's wound-up speed. Leaning changes it; centring leaves it alone.
var _plank_throttle: float = 0.0


func _ready() -> void:
	if config == null:
		config = PilotConfig.new()
	_plank_throttle = config.start_throttle
	print("Pilot: source = %s" % source_name())


func _process(delta: float) -> void:
	var turn: float = 0.0   # -1..1, lean left/right
	var lean: float = 0.0   # -1..1, lean back/forward
	var speed: float = 1.0  # final multiplier

	match config.source:
		PilotConfig.Source.AUTO:
			pass  # carried by the wind, nobody steering
		PilotConfig.Source.MOUSE:
			speed = _mouse_throttle
		PilotConfig.Source.SERIAL:
			# Smooth after shaping: the deadzone still bites on the raw tilt,
			# so the stick can settle at exactly zero instead of easing toward it.
			var t: float = clampf(config.stick_smoothing * delta, 0.0, 1.0)
			_smoothed = _smoothed.lerp(Vector2(_plank_turn(), _plank_lean()), t)
			turn = _smoothed.x
			lean = _smoothed.y
			_integrate_throttle(lean, delta)
			speed = _plank_throttle * _mouse_throttle
		PilotConfig.Source.MQTT:
			if not _warned_mqtt:
				_warned_mqtt = true
				push_warning("Pilot: MQTT source is not implemented yet, coasting instead")
			speed = _mouse_throttle

	# Rate-based sources turn continuously while held; the mouse contributes a
	# one-shot impulse of however far it was dragged since the last frame.
	heading_delta = deg_to_rad(turn * config.turn_rate_deg) * delta
	if _mouse_allowed():
		heading_delta += _mouse_turn
	_mouse_turn = 0.0

	throttle = maxf(speed, 0.0)
	stick = Vector2(turn, lean)


func _mouse_allowed() -> bool:
	if config.source == PilotConfig.Source.MOUSE:
		return true
	return config.allow_mouse_override and config.source != PilotConfig.Source.AUTO


## Lean left/right -> how fast we turn.
func _plank_turn() -> float:
	var t := _shape(ImuInput.tilt.x, config.turn_deadzone_deg, config.turn_range_deg,
			config.turn_expo)
	return -t if config.invert_turn else t


## Lean forward/back, -1..1.
func _plank_lean() -> float:
	var s := _shape(ImuInput.tilt.y, config.speed_deadzone_deg, config.speed_range_deg,
			config.speed_expo)
	return -s if config.invert_speed else s


## Speed is wound up and down rather than pointed at: the lean is a RATE of
## change, so centring the plank holds whatever speed you reached (the dead
## zone makes lean exactly 0 there, so it holds dead steady and doesn't sag).
func _integrate_throttle(lean: float, delta: float) -> void:
	var rate: float = config.accelerate_per_sec if lean >= 0.0 else config.brake_per_sec
	_plank_throttle = clampf(_plank_throttle + lean * rate * delta, 0.0, config.max_throttle)


## Degrees of tilt -> -1..1, with a dead zone around neutral and an expo curve
## so small leans (the ones you make while just balancing) stay gentle.
func _shape(angle_deg: float, deadzone: float, range_deg: float, expo: float) -> float:
	var mag: float = absf(angle_deg) - deadzone
	if mag <= 0.0:
		return 0.0
	var span: float = maxf(range_deg - deadzone, 0.001)
	var n: float = clampf(mag / span, 0.0, 1.0)
	return signf(angle_deg) * pow(n, expo)


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and _mouse_allowed():
		match event.button_index:
			MOUSE_BUTTON_LEFT:
				_dragging = event.pressed
			MOUSE_BUTTON_WHEEL_UP:
				if event.pressed:
					_mouse_throttle = 0.1 if _mouse_throttle < 0.1 \
							else minf(_mouse_throttle * config.wheel_step, 20.0)
			MOUSE_BUTTON_WHEEL_DOWN:
				if event.pressed:
					_mouse_throttle = 0.0 if _mouse_throttle <= 0.1 \
							else _mouse_throttle / config.wheel_step
		return
	if event is InputEventMouseMotion:
		if _dragging and _mouse_allowed():
			_mouse_turn -= deg_to_rad(event.relative.x * config.mouse_turn_speed)
		return
	if not (event is InputEventKey and event.pressed and not event.echo):
		return
	match event.keycode:
		KEY_F5:
			set_source((config.source + 1) % PilotConfig.Source.size())
		KEY_F6:
			ImuInput.calibrate()


func set_source(source: PilotConfig.Source) -> void:
	if source == config.source:
		return
	# Don't carry one device's throttle into the next one.
	config.source = source
	_mouse_throttle = 1.0
	_mouse_turn = 0.0
	_plank_throttle = config.start_throttle
	_smoothed = Vector2.ZERO
	_warned_mqtt = false
	print("Pilot: source = %s" % source_name())
	source_changed.emit(source)


func source_name() -> String:
	return PilotConfig.Source.keys()[config.source].to_lower()
