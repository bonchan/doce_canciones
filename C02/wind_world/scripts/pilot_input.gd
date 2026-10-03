extends Node
## Pilot (autoload singleton)
##
## Single source of truth for STEERING -- the one thing that says "turn this
## much this frame, travel this fast". World reads heading_delta / throttle
## from here and never touches a mouse or a sensor itself, so swapping one
## input device for another changes nothing downstream.
##
## The wind is NOT steering and does not live here -- it arrives from an
## anemometer on the MQTT bus, see scripts/wind_input.gd.
##
## Not to be confused with WindInput, which is the weather: how hard the wind
## blows and from where. Wind carries you; Pilot points you.
##
##   heading_delta : radians to add to the heading THIS FRAME (already * dt)
##   throttle      : multiplier on travel speed, 0 = stopped, 1 = normal
##
## KEYS
##   F5  cycle source (auto -> mouse -> mqtt)

signal source_changed(source: PilotConfig.Source)

@export var config: PilotConfig = preload("res://imu/pilot_default.tres")

var heading_delta: float = 0.0
var throttle: float = 1.0

## Drag accumulates here between frames and is consumed by _process.
var _mouse_turn: float = 0.0
## The wheel. In MOUSE mode this IS the throttle; elsewhere it trims it.
var _mouse_throttle: float = 1.0
var _dragging: bool = false
## Reported by World each frame. The wind gives an absolute bearing, so we
## need the real heading to steer toward it -- our own accumulated deltas
## would drift from it as soon as anything else (the canyon follower) turns.
var world_heading: float = 0.0
## What World would travel at with throttle 1.0, i.e. forward_speed_base plus
## the wind term. Reported each frame so the MQTT source can ask for a real
## speed in m/s and have it come out the other end unchanged.
var world_base_speed: float = 1.0


func _ready() -> void:
	if config == null:
		config = PilotConfig.new()
	print("Pilot: source = %s" % source_name())


func _process(delta: float) -> void:
	var speed: float = 1.0  # final multiplier
	var bearing_delta: float = 0.0 # radians this frame, for sources given a bearing

	match active_source():
		PilotConfig.Source.AUTO:
			pass  # carried by the wind, nobody steering
		PilotConfig.Source.MOUSE:
			speed = _mouse_throttle
		PilotConfig.Source.MQTT:
			if WindInput.is_live():
				# Travel downwind, steering by the PREVAILING direction rather
				# than the live vane, and only once it has settled into one.
				# See WindInput.tendency.
				if config.mqtt_follow_wind \
						and WindInput.tendency_steadiness >= config.mqtt_steer_min_steady:
					var want_h: float = wrapf(_wind_heading() - world_heading, -PI, PI)
					# Ignore small errors outright, and ease the correction in
					# over the band above that. Without this the heading keeps
					# making one-degree corrections forever and the horizon
					# visibly rocks even when the wind is steady.
					var dead: float = deg_to_rad(config.mqtt_heading_deadband_deg)
					var urgency: float = smoothstep(dead, dead * 2.5, absf(want_h))
					if urgency > 0.0:
						var step: float = deg_to_rad(config.mqtt_turn_rate_deg) * urgency * delta
						bearing_delta = clampf(want_h, -step, step)
				# Asked for in m/s and delivered in m/s: World multiplies our
				# throttle by (forward_speed_base + wind * scroll_speed_scale),
				# so divide that back out and the number below is the speed
				# actually travelled. A reading of zero is dead calm, not an
				# absent reading, so it keeps the minimum drift.
				var want: float = clampf(WindInput.current_speed * config.mqtt_speed_per_ms,
						config.mqtt_min_speed, config.mqtt_max_speed)
				speed = want / maxf(world_base_speed, 0.01)
			elif config.mqtt_stop_when_silent:
				speed = 0.0  # nothing on the topic: we do not know, so we wait
			else:
				speed = config.mqtt_min_speed / maxf(world_base_speed, 0.01)

	# MQTT is given an absolute bearing and eases toward it; the mouse
	# contributes a one-shot impulse of however far it was dragged since the
	# last frame.
	heading_delta = bearing_delta
	if _mouse_allowed():
		heading_delta += _mouse_turn
	_mouse_turn = 0.0

	throttle = maxf(speed, 0.0)


## What is actually steering right now.
##
## config.source is what was ASKED for. If that is MQTT and the broker is
## unreachable there is no wind to be carried by, and standing still until
## someone notices is the worst outcome for a gallery piece -- so it quietly
## falls back, and quietly returns to MQTT the moment the link is back.
func active_source() -> PilotConfig.Source:
	if config.source == PilotConfig.Source.MQTT and not Device.online:
		return config.mqtt_offline_fallback
	return config.source


func is_falling_back() -> bool:
	return active_source() != config.source


## The heading to travel on, given the wind.
##
## Two separate conversions, and it is worth spelling both out because getting
## either one wrong looks the same from the outside -- you sail into the wind.
##
##  1. The anemometer reports the direction the wind comes FROM, which is the
##     meteorological convention. We want to be carried BY it, so we go where
##     it is going: half a turn away. 90 (from the east) becomes 270, heading
##     west. 0 becomes 180.
##  2. Compass bearings increase clockwise from north. World headings increase
##     the other way -- heading 0 travels toward -Z and heading 90 travels
##     toward -X -- so the bearing is negated to become a heading.
func _wind_heading() -> float:
	var d: Vector2 = WindInput.tendency
	var from_deg: float = atan2(d.x, d.y)      # where it blows FROM, in radians
	return -(from_deg + PI)                     # half turn, then bearing -> heading


func _mouse_allowed() -> bool:
	var src := active_source()
	if src == PilotConfig.Source.MOUSE:
		return true
	return config.allow_mouse_override and src != PilotConfig.Source.AUTO


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


func set_source(source: PilotConfig.Source) -> void:
	if source == config.source:
		return
	# Don't carry one device's throttle into the next one.
	config.source = source
	_mouse_throttle = 1.0
	_mouse_turn = 0.0
	print("Pilot: source = %s" % source_name())
	source_changed.emit(source)


func source_name() -> String:
	return PilotConfig.Source.keys()[config.source].to_lower()


## What is actually steering, as a bare id ("auto"). Pairs with source_name(),
## which is what was ASKED for ("mqtt"). The two differ only while the broker
## is unreachable, but that is exactly when you need to be told -- reporting
## "mqtt" while coasting on AUTO is a lie. Both are plain ids so a dashboard
## can compare them and match them against its own buttons.
func active_source_id() -> String:
	return PilotConfig.Source.keys()[active_source()].to_lower()


## The same thing said in words, for the HUD. Prose belongs on a label, not in
## telemetry -- see _on_collect_telemetry in world.gd.
func active_source_name() -> String:
	if is_falling_back():
		return "%s (%s offline)" % [active_source_id(), source_name()]
	return active_source_id()
