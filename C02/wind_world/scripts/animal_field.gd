class_name AnimalField
extends Node3D
## A small population of animals living on the scrolling land.
##
## The camera never moves, the world slides underneath it (see world.gd), so an
## animal can't simply walk around a scene. Each one keeps a `world` position in
## scroll_offset space -- exactly like the props do -- and is drawn at
## `world - scroll_offset`. Standing still therefore means drifting backwards
## past the camera, which is the correct and useful thing: the land carries
## them the same way it carries everything else.
##
## Behaviour is a small state machine per animal, weighted so the common case
## is unremarkable -- trot a while, stop, nose at the ground, look up, trot on.
## Nothing here can kill one; Death, Attack and the hit reactions in the clip
## list are deliberately never played.
##
## They are also shy. The camera closes on them at travel speed, and inside
## flee_distance they bolt and keep bolting until they are well clear, so you
## can watch one but never arrive at it.

const ST_IDLE := 0
const ST_EAT := 1
const ST_WALK := 2
const ST_RUN := 3
const ST_JUMP := 4
const ST_LAND := 5
const ST_FLEE := 6
const ST_WATCH := 7

## Species to populate. One .tres each; several can coexist.
@export var species: Array[AnimalConfig] = []
## How many animals may be out there at once, across ALL species. Each species
## has its own max_alive on top of this. With a dozen species configured this
## is the number that actually matters -- without it you get one of everything.
@export var max_total: int = 3
## Print every spawn, state change and despawn to the console. The HUD line
## (F3) only shows the current state; this is the history.
@export var log_events: bool = true
## Roughly the camera's horizontal half-FOV, only used to say "on screen" or
## "off to the side" in the log. A 65-degree vertical FOV on a 16:9 window is
## about 97 across, so ~48 either side.
@export var view_half_angle_deg: float = 48.0

var _world: Node3D ## the World node: scroll_offset, travel_dir, ground_height()
var _alive: Array[Dictionary] = []
var _spawn_timer: float = 0.0
var _rng := RandomNumberGenerator.new()


func setup(world: Node3D) -> void:
	_world = world
	_rng.randomize()
	# Don't drop one in the lap of the camera on the first frame.
	_spawn_timer = _rng.randf_range(3.0, 9.0)
	if species.is_empty():
		_log("no species configured -- the land will stay empty")
		return
	var names: PackedStringArray = []
	for s in species:
		if s == null:
			names.append("<null entry>")
		elif s.model == null:
			names.append("%s <NO MODEL>" % s.species_name)
		else:
			names.append("%s (max %d)" % [s.species_name, s.max_alive])
	_log("ready: %s. First one in %ds. SPACE spawns one in front of you." \
			% [", ".join(names), int(_spawn_timer)])


func _process(delta: float) -> void:
	if _world == null or species.is_empty():
		return
	_spawn_timer -= delta
	if _spawn_timer <= 0.0:
		_try_spawn()
		_spawn_timer = _rng.randf_range(4.0, 12.0)
	for i in range(_alive.size() - 1, -1, -1):
		var a: Dictionary = _alive[i]
		_update(a, delta)
		var why: String = _expired(a)
		if not why.is_empty():
			_log("%s gone -- %s" % [a.cfg.species_name, why])
			a.node.queue_free()
			_alive.remove_at(i)


# ------------------------------------------------------------------ spawning

func _try_spawn() -> void:
	if _alive.size() >= max_total:
		return
	# Pick among the species that have room, rather than picking blind and
	# giving up -- otherwise one species at its cap wastes everyone's turn.
	var cfg: AnimalConfig = _pick_species()
	if cfg == null:
		return
	var side: float = 1.0 if _rng.randf() < 0.5 else -1.0
	_spawn(cfg,
			deg_to_rad(_rng.randf_range(cfg.spawn_angle_deg.x, cfg.spawn_angle_deg.y)) * side,
			_rng.randf_range(cfg.spawn_distance.x, cfg.spawn_distance.y))


## By name, ignoring case, whether or not it has room -- an explicit request
## beats the cap, since spawn_now() will make room anyway.
func _named(want: String) -> AnimalConfig:
	for s in species:
		if s != null and s.model != null and s.species_name.to_lower() == want.to_lower():
			return s
	return null


func _species_names() -> String:
	var out: PackedStringArray = []
	for s in species:
		if s != null:
			out.append(s.species_name)
	return ", ".join(out)


## Any species with room to spare, at random.
func _pick_species() -> AnimalConfig:
	var open: Array[AnimalConfig] = []
	for s in species:
		if s != null and s.model != null and _count_of(s) < s.max_alive:
			open.append(s)
	if open.is_empty():
		return null
	return open[_rng.randi() % open.size()]


## SPACE, or a SPAWN command off the bus. Puts one straight in front of you,
## close enough to actually look at. Always does something: if there is no room
## it retires the oldest animal out there to make some. Pass a species_name to
## ask for a particular animal, or leave it empty for whatever has room.
func spawn_now(want: String = "") -> void:
	if species.is_empty():
		_log("SPACE: nothing to spawn, species list is empty")
		return
	var cfg: AnimalConfig = _named(want) if not want.is_empty() else _pick_species()
	if cfg == null and not want.is_empty():
		_log("SPAWN: no species called %s -- have %s" % [want, _species_names()])
		return
	if cfg == null or _alive.size() >= max_total:
		if _alive.is_empty():
			_log("SPACE: no species has a usable model")
			return
		_log("SPACE: retiring the oldest %s to make room" % _alive[0].cfg.species_name)
		_alive[0].node.queue_free()
		_alive.remove_at(0)
		if cfg == null:
			cfg = _named(want) if not want.is_empty() else _pick_species()
		if cfg == null:
			return
	_spawn(cfg, deg_to_rad(_rng.randf_range(-14.0, 14.0)), _rng.randf_range(26.0, 40.0), true)


func _spawn(cfg: AnimalConfig, ang: float, dist: float, forced: bool = false) -> void:
	var node: Node3D = cfg.model.instantiate() as Node3D
	if node == null:
		_log("could not instantiate %s" % cfg.species_name)
		return
	var ap := _find_anim_player(node)
	if ap == null:
		_log("%s has no AnimationPlayer -- it will stand frozen" % cfg.species_name)
	else:
		_prepare_clips(cfg, ap)
	add_child(node)

	var world_p: Vector2 = _world.scroll_offset + _world.travel_dir.rotated(ang) * dist
	var scale_f: float = _rng.randf_range(cfg.scale_min, cfg.scale_max)
	node.scale = Vector3.ONE * scale_f
	_recolor(cfg, node)

	var a: Dictionary = {
		"cfg": cfg, "node": node, "anim": ap,
		"world": world_p,
		"heading": _rng.randf() * TAU,
		"target_heading": 0.0,
		"speed": 0.0, "want_speed": 0.0,
		"state": ST_IDLE, "timer": 0.0,
		"ground": 0.0, "pitch": 0.0,
		"clip": "",
	}
	a.target_heading = a.heading
	_alive.append(a)
	var deg: float = rad_to_deg(ang)
	_log("%s%s at %dm, %d deg %s -- %s" % [
			cfg.species_name, " (SPACE)" if forced else "", int(dist), int(absf(deg)),
			"right" if deg >= 0.0 else "left",
			"on screen" if absf(deg) <= view_half_angle_deg else "OFF TO THE SIDE, not on screen"])
	# Set the state before entering it, so a newborn doesn't log a pointless
	# "idle -> walking" ahead of the line announcing it exists.
	a.state = ST_WALK
	_enter(a, ST_WALK)


func _count_of(cfg: AnimalConfig) -> int:
	var n: int = 0
	for a in _alive:
		if a.cfg == cfg:
			n += 1
	return n


## Empty string = still with us; otherwise the reason it left, for the log.
## Either it got far away, or it fell back past the camera where it cannot be
## on screen any more.
func _expired(a: Dictionary) -> String:
	var cfg: AnimalConfig = a.cfg
	var d: Vector2 = a.world - _world.scroll_offset
	if d.length() > cfg.despawn_distance:
		return "ran off, %dm away" % int(d.length())
	var behind: float = d.dot(_world.travel_dir)
	if behind < -cfg.despawn_behind:
		return "%dm behind us, off screen" % int(-behind)
	return ""


# ----------------------------------------------------------------- behaviour

func _update(a: Dictionary, delta: float) -> void:
	var cfg: AnimalConfig = a.cfg
	a.timer -= delta

	# Shyness overrides whatever it was doing. The camera is at scroll_offset.
	var from_cam: Vector2 = a.world - _world.scroll_offset
	var cam_dist: float = from_cam.length()
	# How it takes your approach is the whole difference between a fox and a
	# cow. Bolting wins over watching if a species somehow has both.
	if a.state == ST_FLEE:
		if cam_dist > cfg.flee_distance * cfg.flee_release:
			_log("%s calmed down at %dm" % [cfg.species_name, int(cam_dist)])
			_enter(a, ST_WALK)
	elif cfg.flee_distance > 0.0 and cam_dist < cfg.flee_distance:
		_log("%s spooked at %dm -- bolting" % [cfg.species_name, int(cam_dist)])
		_enter(a, ST_FLEE)
	elif a.state == ST_WATCH:
		# A bit of slack on the way out, or it flickers in and out of watching
		# while you hover at exactly the threshold.
		if cam_dist > cfg.watch_distance * 1.3:
			_enter(a, _next_state(a))
	elif cfg.watch_distance > 0.0 and cam_dist < cfg.watch_distance:
		_log("%s noticed you at %dm -- watching" % [cfg.species_name, int(cam_dist)])
		_enter(a, ST_WATCH)

	if a.state == ST_FLEE:
		# Straight away from the camera, with a little veer so two animals
		# don't run identical lines.
		if from_cam.length_squared() > 0.001:
			a.target_heading = _heading_of(from_cam.normalized())
		a.target_heading += _rng.randf_range(-0.25, 0.25) * delta
	elif a.state == ST_WATCH:
		# Keep turning to face you as you go past. It stands its ground; only
		# the heading follows.
		if from_cam.length_squared() > 0.001:
			a.target_heading = _heading_of(-from_cam.normalized())
	elif a.timer <= 0.0:
		_enter(a, _next_state(a))
	elif a.state == ST_RUN and cfg.jump_chance > 0.0 and _rng.randf() < cfg.jump_chance * delta:
		_enter(a, ST_JUMP)

	_steer(a, delta)
	_move(a, delta)
	_place(a)


## What it does next. Running goes to a landing rather than stopping dead;
## everything else is a weighted pick, so most of the time it is unremarkable.
func _next_state(a: Dictionary) -> int:
	var cfg: AnimalConfig = a.cfg
	match a.state:
		ST_JUMP:
			return ST_RUN
		ST_RUN:
			return ST_LAND
		ST_LAND:
			return ST_IDLE
	var total: float = cfg.want_walk + cfg.want_eat + cfg.want_idle + cfg.want_run
	if total <= 0.0:
		return ST_IDLE
	var r: float = _rng.randf() * total
	if r < cfg.want_walk:
		return ST_WALK
	r -= cfg.want_walk
	if r < cfg.want_eat:
		return ST_EAT
	r -= cfg.want_eat
	if r < cfg.want_idle:
		return ST_IDLE
	return ST_RUN


func _enter(a: Dictionary, state: int) -> void:
	var cfg: AnimalConfig = a.cfg
	if state != a.state and a.has("node") and is_instance_valid(a.node):
		_log("%s %s -> %s  (%dm)" % [cfg.species_name, _state_name(a.state), _state_name(state),
				int((a.world - _world.scroll_offset).length())])
	a.state = state
	match state:
		ST_IDLE:
			a.timer = _rng.randf_range(cfg.idle_time.x, cfg.idle_time.y)
			a.want_speed = 0.0
			_play(a, _pick(cfg.anim_idle))
		ST_EAT:
			a.timer = _rng.randf_range(cfg.eat_time.x, cfg.eat_time.y)
			a.want_speed = 0.0
			_play(a, cfg.anim_eat)
		ST_WALK:
			a.timer = _rng.randf_range(cfg.walk_time.x, cfg.walk_time.y)
			a.want_speed = cfg.walk_speed
			_aim_wander(a)
			_play(a, cfg.anim_walk)
		ST_RUN:
			a.timer = _rng.randf_range(cfg.run_time.x, cfg.run_time.y)
			a.want_speed = cfg.run_speed
			_play(a, cfg.anim_run)
		ST_JUMP:
			a.want_speed = cfg.run_speed
			a.timer = _clip_length(a, cfg.anim_jump, 0.9)
			_play(a, cfg.anim_jump)
		ST_LAND:
			a.want_speed = 0.0
			a.timer = _clip_length(a, cfg.anim_land, 1.0)
			_play(a, cfg.anim_land)
		ST_FLEE:
			a.timer = 999.0
			a.want_speed = cfg.run_speed * cfg.flee_speed_boost
			_play(a, cfg.anim_run)
		ST_WATCH:
			a.timer = 999.0 # held by distance, not by the clock
			a.want_speed = 0.0
			_play(a, cfg.anim_watch if not cfg.anim_watch.is_empty() else _pick(cfg.anim_idle))


## Wander, or head for company. An animal walking toward another one is the
## whole of the social life here, and on a steppe that reads as plenty.
func _aim_wander(a: Dictionary) -> void:
	var cfg: AnimalConfig = a.cfg
	var other: Dictionary = _nearest_other(a)
	if not other.is_empty() and _rng.randf() < cfg.social_chance:
		var to: Vector2 = other.world - a.world
		if to.length() > cfg.social_personal_space:
			a.target_heading = _heading_of(to.normalized())
			return
	# Mostly carry on roughly the way it was going; occasionally think better
	# of it and turn properly.
	var turn: float = _rng.randf_range(-0.9, 0.9)
	if _rng.randf() < 0.25:
		turn = _rng.randf_range(-PI, PI)
	a.target_heading = a.heading + turn


func _nearest_other(a: Dictionary) -> Dictionary:
	var best: Dictionary = {}
	var best_d: float = a.cfg.social_range
	for o in _alive:
		if o == a:
			continue
		var d: float = (o.world - a.world).length()
		if d < best_d:
			best_d = d
			best = o
	return best


# ------------------------------------------------------------------ movement

func _steer(a: Dictionary, delta: float) -> void:
	var diff: float = wrapf(a.target_heading - a.heading, -PI, PI)
	var rate: float = a.cfg.watch_turn_rate_deg if a.state == ST_WATCH else a.cfg.turn_rate_deg
	var step: float = deg_to_rad(rate) * delta
	a.heading += clampf(diff, -step, step)


func _move(a: Dictionary, delta: float) -> void:
	var cfg: AnimalConfig = a.cfg
	a.speed = move_toward(a.speed, a.want_speed, cfg.accel * delta)
	if a.speed > 0.001:
		a.world += _dir_of(a.heading) * a.speed * delta
	# Feet keep up with the ground: playback follows actual speed, so the
	# gait stretches as it accelerates instead of skating.
	var ap: AnimationPlayer = a.anim
	if ap == null:
		return
	match a.state:
		ST_WALK:
			ap.speed_scale = maxf(a.speed / maxf(cfg.walk_speed, 0.01), 0.35) * cfg.walk_anim_speed
		ST_RUN, ST_FLEE, ST_JUMP:
			ap.speed_scale = maxf(a.speed / maxf(cfg.run_speed, 0.01), 0.45) * cfg.run_anim_speed
		_:
			ap.speed_scale = 1.0


func _place(a: Dictionary) -> void:
	a.ground = _world.ground_height(a.world)
	var d: Vector2 = a.world - _world.scroll_offset
	# Same wrap the props use, so nothing jumps when scroll_offset wraps.
	d.x = wrapf(d.x, -_world.WRAP_PERIOD * 0.5, _world.WRAP_PERIOD * 0.5)
	d.y = wrapf(d.y, -_world.WRAP_PERIOD * 0.5, _world.WRAP_PERIOD * 0.5)
	var node: Node3D = a.node
	node.position = Vector3(d.x, a.ground, d.y)
	# Lean into the slope it is standing on. Small, but an animal held level
	# on a hillside looks pasted on.
	var step: Vector2 = _dir_of(a.heading) * 0.7
	var rise: float = _world.ground_height(a.world + step) - _world.ground_height(a.world - step)
	a.pitch = lerpf(a.pitch, clampf(atan2(rise, 1.4), -0.5, 0.5), 0.15)
	node.rotation = Vector3(-a.pitch, a.heading + deg_to_rad(a.cfg.model_yaw_offset_deg), 0.0)


## Heading convention matches world.gd: dir = (-sin h, -cos h), which is also
## a Node3D's own -Z forward, so rotation.y = heading with no correction.
func _dir_of(h: float) -> Vector2:
	return Vector2(-sin(h), -cos(h))


func _heading_of(dir: Vector2) -> float:
	return atan2(-dir.x, -dir.y)


# ----------------------------------------------------------------- the model

func _play(a: Dictionary, clip: String) -> void:
	var ap: AnimationPlayer = a.anim
	if ap == null or clip.is_empty() or clip == a.clip:
		return
	if not ap.has_animation(clip):
		return
	a.clip = clip
	ap.play(clip, a.cfg.anim_blend)


func _clip_length(a: Dictionary, clip: String, fallback: float) -> float:
	var ap: AnimationPlayer = a.anim
	if ap == null or clip.is_empty() or not ap.has_animation(clip):
		return fallback
	return ap.get_animation(clip).length


## glTF brings no loop flags, so every clip would play once and freeze. The
## gaits and idles have to cycle; the jump and the landing are one-shots by
## design and are timed by their own length instead.
func _prepare_clips(cfg: AnimalConfig, ap: AnimationPlayer) -> void:
	var once: Array = [cfg.anim_jump, cfg.anim_land]
	for name in ap.get_animation_list():
		var clip: Animation = ap.get_animation(name)
		if clip == null:
			continue
		clip.loop_mode = Animation.LOOP_NONE if name in once else Animation.LOOP_LINEAR


func _pick(list: PackedStringArray) -> String:
	if list.is_empty():
		return ""
	return list[_rng.randi() % list.size()]


## Repaint named materials. The model arrives with one flat material per part
## and no textures, so this is just an albedo swap -- and a little per-animal
## jitter on top, because two identical foxes on screen look like two copies of
## one fox.
func _recolor(cfg: AnimalConfig, root: Node3D) -> void:
	if cfg.recolor.is_empty():
		return
	var jitter: float = 1.0 + _rng.randf_range(-cfg.coat_jitter, cfg.coat_jitter)
	var warm: float = 1.0 + _rng.randf_range(-cfg.coat_jitter, cfg.coat_jitter) * 0.5
	for mi in _find_meshes(root):
		var mesh: Mesh = mi.mesh
		if mesh == null:
			continue
		for s in range(mesh.get_surface_count()):
			var src: Material = mesh.surface_get_material(s)
			if src == null or not cfg.recolor.has(src.resource_name):
				continue
			var col: Color = cfg.recolor[src.resource_name]
			var mat: StandardMaterial3D = src.duplicate()
			mat.albedo_color = Color(
					clampf(col.r * jitter * warm, 0.0, 1.0),
					clampf(col.g * jitter, 0.0, 1.0),
					clampf(col.b * jitter / maxf(warm, 0.01), 0.0, 1.0),
					col.a)
			mi.set_surface_override_material(s, mat)


func _find_anim_player(n: Node) -> AnimationPlayer:
	if n is AnimationPlayer:
		return n
	for ch in n.get_children():
		var found := _find_anim_player(ch)
		if found != null:
			return found
	return null


func _find_meshes(n: Node, out: Array[MeshInstance3D] = []) -> Array[MeshInstance3D]:
	if n is MeshInstance3D:
		out.append(n)
	for ch in n.get_children():
		_find_meshes(ch, out)
	return out


func alive_count() -> int:
	return _alive.size()


func _log(msg: String) -> void:
	if log_events:
		print("[animals] ", msg)


## For the debug HUD (F3). One line per animal, with where it is relative to
## where you are looking, so you know which way to turn to find it.
func describe() -> String:
	if species.is_empty():
		return "no species configured"
	if _alive.is_empty():
		return "none out there -- next in %ds   (SPACE spawns one in front)" \
				% int(maxf(_spawn_timer, 0.0))
	var bits: PackedStringArray = []
	for a in _alive:
		var d: Vector2 = a.world - _world.scroll_offset
		var deg: float = rad_to_deg(wrapf(_heading_of(d.normalized()) - _world.heading, -PI, PI))
		var where: String = "ahead"
		if absf(deg) > view_half_angle_deg:
			where = "off right" if deg < 0.0 else "off left"
		elif absf(deg) > 8.0:
			where = "right" if deg < 0.0 else "left"
		bits.append("%s %s, %dm %s (%d deg)" % [a.cfg.species_name, _state_name(a.state),
				int(d.length()), where, int(deg)])
	return "   |   ".join(bits)


func _state_name(s: int) -> String:
	match s:
		ST_IDLE: return "idle"
		ST_EAT: return "eating"
		ST_WALK: return "walking"
		ST_RUN: return "running"
		ST_JUMP: return "jumping"
		ST_LAND: return "landing"
		ST_FLEE: return "fleeing"
		ST_WATCH: return "watching you"
	return "?"
