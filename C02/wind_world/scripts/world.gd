extends Node3D
## World
##
## Builds the whole procedural scene at runtime (terrain, grass, flowers,
## particles, props, sky) and, every frame, "scrolls" it under the camera by
## reading WindInput.current_speed / current_direction.
##
## Everything about the LOOK comes from a WorldConfig resource. Presets live in
## res://configs/<n>_name.tres. Switching presets never cuts: the world blends
## into the new one over its `transition_time` -- the land morphs, colors and
## fog drift, grass/flowers thin or thicken, particle layers crossfade, and
## props are gradually replaced as they recycle.
##
## HOW THE INFINITE SCROLL WORKS (read this before tuning anything):
##   The camera never moves horizontally (beyond a small float drift). Instead
##   we keep a single scroll_offset: Vector2 that advances along the heading
##   every frame, at a speed driven by the wind. It is handed to every shader
##   as a uniform. Terrain height, grass position and flower position are all
##   computed as functions of scroll_offset, so moving that one number moves
##   the whole world coherently. Wind *direction* only bends the grass and
##   drives the particles; it never changes where we travel.
##
##   The camera glides over the terrain height (computed on the CPU by
##   TerrainNoise, an exact mirror of the shader height field).
##
##   scroll_offset is wrapped every frame to [0, WRAP_PERIOD) -- it never
##   grows without bound, so float32 precision in the shaders never
##   degrades no matter how long this runs (days, weeks, doesn't matter).
##   The wrap is invisible because the terrain noise is built to tile with
##   exactly that period (see common.gdshaderinc).
##
## KEYS
##   F1  wireframe on/off
##   F2  hide/show grass, flowers and particles (see the terrain clearly)
##   F3  debug HUD on/off
##   1-9 blend to preset res://configs/<n>_name.tres (top row or keypad)
##   F4  blend to the next preset
##   0   auto-cycle presets on/off (every auto_cycle_seconds)
##   F   fullscreen on/off
##   F5  cycle steering source
##   SPACE spawn an animal right in front of you (see scripts/animal_field.gd)
##
## STEERING
##   Where we travel comes from Pilot (scripts/pilot_input.gd), which is fed by
##   the mouse, by the wind on the MQTT bus, or by nothing at all -- this
##   script only reads Pilot.heading_delta / Pilot.throttle, not which.

const WRAP_PERIOD: float = 8192.0  # MUST match W_WRAP_PERIOD in common.gdshaderinc
const CONFIG_DIR := "res://configs/"
const DEFAULT_CONFIG := "res://configs/1_meadow.tres"
## Loaded by path (not by class_name) so it works even before the editor has
## rescanned and registered the global class.
const Plants := preload("res://scripts/plant_meshes.gd")
## Set by the starting preset; can't blend (they size meshes / tiles).
const FIXED_PROPS := ["terrain_size", "terrain_subdivisions", "field_tile_size", "prop_tile_size",
	"grass_clump_size", "grass_clump_radius", "grass_clump_splay"]

## The starting look. Falls back to 1_meadow.tres when empty.
@export var config: WorldConfig
## Wildlife. One AnimalConfig per species; see scripts/animal_field.gd. Empty
## for an empty land.
@export var animals: Array[AnimalConfig] = [
	preload("res://animals/fox.tres"),
	preload("res://animals/wolf.tres"),
	preload("res://animals/deer.tres"),
	preload("res://animals/stag.tres"),
	preload("res://animals/alpaca.tres"),
	preload("res://animals/cow.tres"),
	preload("res://animals/bull.tres"),
	preload("res://animals/horse.tres"),
	preload("res://animals/horse_white.tres"),
	preload("res://animals/donkey.tres"),
	preload("res://animals/husky.tres"),
	preload("res://animals/shibainu.tres"),
]
@export var heading_smoothing: float = 3.0 ## higher = heading follows the steering faster
## Drift through the presets on its own, one blend every this many seconds.
## 0 = off. Key 0 toggles it at runtime.
@export var auto_cycle_seconds: float = 0.0

var scroll_offset: Vector2 = Vector2.ZERO
var forward_speed: float = 0.0
var heading: float = 0.0 ## radians of yaw; 0 = travel toward -Z
var travel_dir: Vector2 = Vector2(0.0, -1.0) ## unit XZ vector we move along

## Live config: every blendable value, interpolated between _from and _to.
var c: WorldConfig
var _from: WorldConfig
var _to: WorldConfig
var _blend: float = 0.0 ## eased 0..1 progress of the current transition
var _trans_time: float = 0.0
var _transitioning: bool = false
var _queued: String = ""
var _lerp_props: Array = []
var _auto_timer: float = 0.0
var _auto_on: bool = false

## Whatever Pilot is steering with (wind, mouse, nothing) lands here.
var speed_multiplier: float = 1.0
var _heading_target: float = 0.0

## Meters of wall on the shallower side of us. Above ~2 we are in something
## trench-like; near 0 we are out in the open.
var canyon_walls: float = 0.0
var _canyon_following: bool = false
var _canyon_timer: float = 0.0
var _animals: AnimalField
var _field_tile: float
var _terrain_cell: float
var _terrain_mi: MeshInstance3D
var _terrain_mat: ShaderMaterial
var _grass_mat: ShaderMaterial
var _flower_mat: ShaderMaterial
var _grass_mmi: MultiMeshInstance3D
var _flower_mmi: MultiMeshInstance3D
var _grass_max: int = 0
var _flower_max: int = 0
var _particles: Array = [] # of { node: GPUParticles3D, pm: ParticleProcessMaterial, layer: ParticleLayer, cfg: WorldConfig }
var _particles_visible: bool = true
var _world_env: WorldEnvironment
var _sky_mat: ProceduralSkyMaterial
var _sun: DirectionalLight3D
var _t: float = 0.0

var _props: Array = [] # of Dictionary, see _respawn_prop
var _pools: Dictionary = {} # WorldConfig -> { meshes, mats, special_meshes, special_mat }
var _prop_refresh_i: int = 0
var _prop_max: int = 0 ## props built = most any preset uses; live prop_count decides how many are active
var _rng := RandomNumberGenerator.new()

var _camera: Camera3D
var _cam_ground: float = 0.0 ## smoothed ground under us, reference for slope pitch
var _cam_y: float = 0.0 ## flight height (without the breathing offset)
var _cam_vy: float = 0.0 ## vertical speed, m/s
var _gaze_yaw: float = 0.0 ## eased yaw offset toward a special prop
var _cam_pitch: float = 0.0
var _cam_roll: float = 0.0
var _prev_heading: float = 0.0
var _interest: Dictionary = {} ## the special prop being watched, or empty
var _interest_gen: int = -1
var _interest_elapsed: float = 0.0
var _interest_cool: float = 0.0
var _interest_w: float = 0.0 ## 0..1 how much we're looking at it
var _interest_yaw: float = 0.0
var _interest_pitch: float = 0.0

var _hud: Label
var _hud_timer: float = 0.0
## Both come from [display] in config.cfg, and both can be flipped at runtime
## by F1-F3 or by the DISPLAY command.
## ALTER: 0 = the world is fine, 1 = fully cracked open and flooded. Eased,
## never snapped -- the whole point is that it is a process.
var alter_amount: float = 0.0
var _alter_left: float = 0.0
var _alter_total: float = 0.0
var _vent_gap: float = 0.0
var _vents: Array[Dictionary] = []
## The grass field is by far the most expensive thing here: every blade is 24
## vertices and EVERY vertex evaluates the terrain noise, so 22000 blades cost
## roughly three times the whole terrain mesh. Off, none of it is built at all
## -- no instances, no material, no draw. The coiron props still carry some of
## the same texture, so the ground does not read as bare.
## Seconds of stillness before the pointer disappears. 0 leaves it on screen.
## A cursor parked in the middle of a projected landscape is the one thing that
## tells everyone it is a computer.
var cursor_hide_after: float = 2.0
var _cursor_idle: float = 0.0
var show_grass: bool = true
var show_primitives: bool = false
var show_hud: bool = false
var _ident: Label ## the big IDENTIFY overlay
var _ident_left: float = 0.0


func _init() -> void:
	# Must be on before any mesh is created, or wireframe debug draw has
	# nothing to draw.
	RenderingServer.set_debug_generate_wireframes(true)


func _ready() -> void:
	# config.cfg wins over whatever the scene has assigned. The scene file is
	# owned by the editor -- it rewrites it from memory on save, so an edit
	# there does not survive -- and this way the gallery machine and a
	# development one can start on different worlds from the same build.
	var want: String = str(Device.setting("display", "preset", ""))
	if not want.is_empty():
		var path: String = CONFIG_DIR + want + ".tres"
		if ResourceLoader.exists(path):
			config = load(path)
			print("[display] starting preset: ", want)
		else:
			push_warning("[display] no preset called %s at %s" % [want, path])
	if config == null:
		config = load(DEFAULT_CONFIG)
	_from = config
	_to = config
	c = config.duplicate()
	for p in c.get_property_list():
		if not (p.usage & PROPERTY_USAGE_SCRIPT_VARIABLE) or p.name in FIXED_PROPS:
			continue
		if p.type in [TYPE_FLOAT, TYPE_INT, TYPE_COLOR, TYPE_VECTOR3]:
			_lerp_props.append(p.name)
	_auto_on = auto_cycle_seconds > 0.0
	show_grass = Device.setting("display", "grass", true)
	cursor_hide_after = float(Device.setting("display", "hide_cursor_after", 2.0))
	show_primitives = Device.setting("display", "primitives", false)
	show_hud = Device.setting("display", "hud", false)
	if Device.setting("display", "fullscreen", false):
		set_fullscreen(true)

	# Tile sizes that divide WRAP_PERIOD exactly, so nothing jumps when
	# scroll_offset wraps around.
	_field_tile = WRAP_PERIOD / round(WRAP_PERIOD / c.field_tile_size)
	_rng.seed = 777

	# Grass/flowers are built once, big enough for any preset; the live count
	# is just how many instances are drawn.
	for path in list_presets():
		var pc: WorldConfig = load(path)
		_grass_max = max(_grass_max, pc.grass_count)
		_flower_max = max(_flower_max, pc.flower_count)
	_grass_max = max(_grass_max, c.grass_count)
	_flower_max = max(_flower_max, c.flower_count)
	_prop_max = c.prop_count
	for path in list_presets():
		_prop_max = max(_prop_max, (load(path) as WorldConfig).prop_count)

	_build_environment()
	_build_sun()
	_build_terrain()
	_build_grass()
	_build_flowers()
	_build_particles(_from)
	_push_terrain_params()
	_push_palettes()
	_apply_live()
	_build_props()
	_build_camera()
	_build_vents()
	_build_animals()
	_build_hud()
	WindInput.wind_changed.connect(_on_wind_changed)
	Device.collect_telemetry.connect(_on_collect_telemetry)
	Device.identify.connect(_on_identify)
	Device.command.connect(_on_device_command)
	Device.collect_announce.connect(_on_collect_announce)


func _process(delta: float) -> void:
	_t += delta

	var dir: Vector2 = WindInput.current_direction
	var speed: float = WindInput.current_speed

	_update_transition(delta)
	_update_auto_cycle(delta)

	# Steering: the wind off the bus, the mouse, or nobody at all.
	Pilot.world_heading = heading  # the wind gives an absolute bearing
	# What we would travel at on full throttle. Pilot divides by this so a
	# source can ask for a speed in m/s and actually get it.
	Pilot.world_base_speed = c.forward_speed_base + WindInput.current_speed * c.scroll_speed_scale
	_heading_target += Pilot.heading_delta
	speed_multiplier = Pilot.throttle
	# The land gets a say too, but only a nudge -- the pilot always wins.
	_update_canyon(delta)

	heading = lerp_angle(heading, _heading_target, clamp(heading_smoothing * delta, 0.0, 1.0))
	travel_dir = Vector2(-sin(heading), -cos(heading))

	# Ease into gusts: we're carried by the wind, not driving.
	var target_speed: float = (c.forward_speed_base + speed * c.scroll_speed_scale) * speed_multiplier
	forward_speed = lerp(forward_speed, target_speed, clamp(c.camera_speed_smoothing * delta, 0.0, 1.0))
	scroll_offset += travel_dir * forward_speed * delta
	scroll_offset.x = fposmod(scroll_offset.x, WRAP_PERIOD)
	scroll_offset.y = fposmod(scroll_offset.y, WRAP_PERIOD)

	if _grass_mat:
		_grass_mat.set_shader_parameter("scroll_offset", scroll_offset)
	_flower_mat.set_shader_parameter("scroll_offset", scroll_offset)
	_update_terrain_snap()

	if _grass_mat:
		_grass_mat.set_shader_parameter("wind_dir", dir)
		_grass_mat.set_shader_parameter("wind_speed", speed)
	_flower_mat.set_shader_parameter("wind_dir", dir)
	_flower_mat.set_shader_parameter("wind_speed", speed)
	_terrain_mat.set_shader_parameter("wind_speed_norm", WindInput.get_speed_normalized())

	_update_particles(dir, speed)
	_update_alter(delta)
	_update_mood()
	_update_props(delta)
	_update_camera(delta)
	_update_hud(delta)
	_update_cursor(delta)
	if _ident_left > 0.0:
		_ident_left -= delta
		# Pulse, so it reads as "this one" across a room.
		_ident.modulate.a = 0.55 + 0.45 * sin(_t * 9.0)
		if _ident_left <= 0.0:
			_ident.visible = false


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseMotion or event is InputEventMouseButton:
		_wake_cursor()
		return
	# Mouse steering lives in Pilot now, so this only
	# handles the look/debug keys.
	if not (event is InputEventKey and event.pressed and not event.echo):
		return
	# 1-9 (top row or keypad): blend to the preset named "<n>_something.tres".
	var k: int = event.keycode
	if k >= KEY_1 and k <= KEY_9:
		start_transition(preset_for_number(k - KEY_0))
		return
	if k >= KEY_KP_1 and k <= KEY_KP_9:
		start_transition(preset_for_number(k - KEY_KP_0))
		return
	match k:
		KEY_F:
			set_fullscreen(not is_fullscreen())
		KEY_SPACE:
			if _animals:
				_animals.spawn_now()
			else:
				print("[animals] no AnimalField -- the World node's `animals` array is empty")
		KEY_0, KEY_KP_0:
			_auto_on = not _auto_on
			_auto_timer = 0.0
		KEY_F1:
			var vp := get_viewport()
			vp.debug_draw = Viewport.DEBUG_DRAW_DISABLED if vp.debug_draw == Viewport.DEBUG_DRAW_WIREFRAME else Viewport.DEBUG_DRAW_WIREFRAME
		KEY_F2:
			var on := not _flower_mmi.visible
			if _grass_mmi:
				_grass_mmi.visible = on
			_flower_mmi.visible = on
			_particles_visible = on
			for e in _particles:
				e.node.visible = on
		KEY_F3:
			_hud.visible = not _hud.visible
		KEY_F4:
			_next_preset()


# --------------------------------------------------------------------- presets

static func list_presets() -> PackedStringArray:
	var out := PackedStringArray()
	for f in DirAccess.get_files_at(CONFIG_DIR):
		# Exported builds list "x.tres.remap"; load() still wants "x.tres".
		f = f.trim_suffix(".remap")
		if f.ends_with(".tres") and not out.has(CONFIG_DIR + f):
			out.append(CONFIG_DIR + f)
	out.sort()
	return out


## Preset whose file name starts with "<number>_", e.g. 2 -> configs/2_wasteland.tres.
static func preset_for_number(n: int) -> String:
	for path in list_presets():
		if path.get_file().begins_with("%d_" % n):
			return path
	return ""


func _next_preset() -> void:
	var presets := list_presets()
	if presets.is_empty():
		return
	var current: String = (_to if _transitioning else _from).resource_path
	var i: int = presets.find(current)
	start_transition(presets[(i + 1) % presets.size()])


func _update_auto_cycle(delta: float) -> void:
	if not _auto_on or auto_cycle_seconds <= 0.0 or _transitioning:
		return
	_auto_timer += delta
	if _auto_timer >= auto_cycle_seconds:
		_auto_timer = 0.0
		_next_preset()


## Blend from the current look into the preset at `path`. If a blend is
## already running, this one starts right after it.
func start_transition(path: String) -> void:
	if path == "":
		return
	if _transitioning:
		if path != _to.resource_path:
			_queued = path
		return
	var target: WorldConfig = load(path)
	if target == null or target == _from:
		return
	_to = target
	_trans_time = 0.0
	_blend = 0.0
	_transitioning = true
	_build_particles(_to)
	_push_terrain_params()
	_push_palettes()


func _update_transition(delta: float) -> void:
	if not _transitioning:
		return
	_trans_time += delta
	var raw: float = clamp(_trans_time / max(_to.transition_time, 0.01), 0.0, 1.0)
	_blend = smoothstep(0.0, 1.0, raw)
	for n in _lerp_props:
		var a = _from.get(n)
		var b = _to.get(n)
		if a is int:
			c.set(n, roundi(lerp(float(a), float(b), _blend)))
		else:
			c.set(n, lerp(a, b, _blend))
	if raw >= 1.0:
		_finish_transition()
	_push_terrain_params()
	_flower_mat.set_shader_parameter("palette_blend", _blend)
	_apply_live()


func _finish_transition() -> void:
	var old := _from
	_from = _to
	_blend = 0.0
	_transitioning = false
	for n in _lerp_props:
		c.set(n, _from.get(n))
	for e in _particles.duplicate():
		if e.cfg == old:
			e.node.queue_free()
			_particles.erase(e)
	_push_palettes()
	if _queued != "":
		var q := _queued
		_queued = ""
		start_transition(q)


# ---------------------------------------------------------------------- ground

func _height_for(cfg: WorldConfig, p: Vector2) -> float:
	return TerrainNoise.height(p, cfg.hill_scale, cfg.hill_height, cfg.mountain_scale,
		cfg.mountain_height, cfg.warp_strength, cfg.terrace_step, cfg.terrace_strength,
		cfg.canyon_scale, cfg.canyon_depth, cfg.canyon_width)


## Same blend as w_ground() in common.gdshaderinc.
func ground_height(world_p: Vector2) -> float:
	var ha: float = _height_for(_from, world_p)
	if not _transitioning or _blend <= 0.0:
		return ha
	return lerp(ha, _height_for(_to, world_p), _blend)


## Swapping this rebuilds the prop pools, then re-seats every prop where it
## already stands so the change is visible at once rather than trickling in as
## they happen to recycle.
func set_primitives(on: bool) -> void:
	if on == show_primitives:
		return
	show_primitives = on
	_pools.clear()
	for p in _props:
		if p.active:
			_respawn_prop(p, _prop_offset(p))
	print("[display] primitives ", "on" if on else "off")


## Borderless fullscreen rather than exclusive: it behaves better with
## compositors and multi-monitor setups, and alt-tabbing does not black the
## screen. [display] fullscreen in config.cfg decides how it starts.
func is_fullscreen() -> bool:
	var m := DisplayServer.window_get_mode()
	return m == DisplayServer.WINDOW_MODE_FULLSCREEN 			or m == DisplayServer.WINDOW_MODE_EXCLUSIVE_FULLSCREEN


func set_fullscreen(on: bool) -> void:
	DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_FULLSCREEN if on
			else DisplayServer.WINDOW_MODE_WINDOWED)


## Hide the pointer once it has been still a while, bring it back the instant
## it moves. Hidden rather than captured: clicks and drags still work, so
## mouse steering is unaffected -- it is only the arrow that goes.
func _update_cursor(delta: float) -> void:
	if cursor_hide_after <= 0.0:
		return
	_cursor_idle += delta
	if _cursor_idle >= cursor_hide_after and Input.mouse_mode == Input.MOUSE_MODE_VISIBLE:
		Input.mouse_mode = Input.MOUSE_MODE_HIDDEN


func _wake_cursor() -> void:
	_cursor_idle = 0.0
	if Input.mouse_mode == Input.MOUSE_MODE_HIDDEN:
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE


func set_hud(on: bool) -> void:
	show_hud = on
	if _hud:
		_hud.visible = on


# ---------------------------------------------------------------------- alter
# ALTER, the capability every device on the bus is expected to have: "be
# wrong for a while". Here that is the ground splitting open, the void showing
# through, and petrol welling out of the fissures until it has covered
# everything -- then the land closes and it drains away.
#
# It tears open faster than it heals, which is what makes it read as damage
# rather than as an effect being toggled.

const ALTER_OPEN := 2.2  ## seconds to reach full disaster
const ALTER_HEAL := 5.0  ## seconds to come back


## Duration is how long it stays at full, not counting the opening and the
## healing either side.
func alter(duration: float = 10.0) -> void:
	_alter_left = maxf(duration, 0.1)
	_alter_total = _alter_left
	print("[alter] the world cracks open for %.1fs" % _alter_left)
	_open_vents()


func _update_alter(delta: float) -> void:
	var target: float = 0.0
	if _alter_left > 0.0:
		_alter_left -= delta
		target = 1.0
	if is_equal_approx(alter_amount, target):
		alter_amount = target
	else:
		var rate: float = 1.0 / (ALTER_OPEN if target > alter_amount else ALTER_HEAL)
		alter_amount = move_toward(alter_amount, target, rate * delta)
	for mat in [_terrain_mat, _grass_mat, _flower_mat]:
		if mat:
			mat.set_shader_parameter("alter", alter_amount)
	_update_vents(delta)


## Deliberately almost nothing. An earlier version drained the colour and
## dimmed the sun, which just made the screen go dark and hid the very thing
## worth looking at. The fissures and the crude coming out of them are the
## effect; the light stays where it was.
func _apply_alter_mood() -> void:
	if alter_amount <= 0.0:
		return
	var env := _world_env.environment
	# Only a faint haze, so the air reads as fouled rather than the picture
	# being turned down.
	env.fog_light_color = env.fog_light_color.lerp(Color(0.16, 0.16, 0.15), alter_amount * 0.35)
	env.fog_density = lerp(env.fog_density, env.fog_density * 1.35, alter_amount)


# --------------------------------------------------------------------- vents
# Crude comes up out of the fissures under pressure: it goes UP, hangs, and
# falls back, and the ground is stained wherever it lands. The plume is
# particles; the stain is four uniforms the terrain shader paints with. They
# are kept separate on purpose -- the spill has to persist long after the
# droplet that made it has hit the ground and gone.

const VENTS := 4
const VENT_SEARCH := 230.0 ## metres ahead we look for somewhere to erupt
const VENT_SPREAD := 42.0  ## keep them this far apart, or they read as one blot
## A vent is chosen well ahead, then waits. It only blows once it is actually
## on screen and close enough to read -- the eruption is the good bit, and
## arriving at one already running wastes it.
## Narrow on purpose. A vent armed well off to the side swings abeam as we
## approach, so by the time it is close it is no longer in front -- it can
## never satisfy both the distance and the view cone, and simply never fires.
## Keeping candidates near our line means we drive straight into them.
## The patch of ground in front of the camera a vent may blow in. Near enough
## that you are on top of it within a few seconds, far enough that the whole
## plume is in frame when it goes up.
const VENT_VIEW_CONE := 24.0
const VENT_NEAR := 45.0
const VENT_FAR := 105.0
## Seconds between eruptions.
const VENT_GAP := Vector2(1.6, 3.6)
const VENT_RETIRE := 25.0
const STAIN_GROWTH := 5.5  ## metres per second the spill creeps outward
const STAIN_MAX := 34.0


func _build_vents() -> void:
	for i in VENTS:
		var pm := ParticleProcessMaterial.new()
		pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_SPHERE
		pm.emission_sphere_radius = 1.6
		pm.direction = Vector3(0, 1, 0)
		pm.spread = 13.0
		pm.initial_velocity_min = 22.0
		pm.initial_velocity_max = 36.0
		pm.gravity = Vector3(0, -16.0, 0)
		# Gobbets, not mist. These are seen from 60-190 m away, so a droplet
		# has to be metres across to be more than one pixel -- the first
		# version used half-metre quads and was invisible from the air.
		pm.scale_min = 0.9
		pm.scale_max = 2.9
		pm.damping_min = 0.0
		pm.damping_max = 0.6
		# Crude is not black: it is a dark brown that goes iridescent at a
		# glancing angle. It has to start light enough to read against dark
		# ground, then thicken toward black as it falls.
		var ramp := Gradient.new()
		ramp.set_color(0, Color(0.17, 0.14, 0.10, 1.0))
		ramp.set_color(1, Color(0.022, 0.020, 0.026, 0.85))
		var tex := GradientTexture1D.new()
		tex.gradient = ramp
		pm.color_ramp = tex

		# A quad with no texture is a visible square. A radial alpha ramp turns
		# each one into a soft blob with no edge of its own, so a few hundred
		# of them read as thrown liquid rather than confetti.
		var blob := Gradient.new()
		blob.set_color(0, Color(1, 1, 1, 1))
		blob.set_color(1, Color(1, 1, 1, 0))
		blob.add_point(0.55, Color(1, 1, 1, 0.85))
		var blob_tex := GradientTexture2D.new()
		blob_tex.gradient = blob
		blob_tex.fill = GradientTexture2D.FILL_RADIAL
		blob_tex.fill_from = Vector2(0.5, 0.5)
		blob_tex.fill_to = Vector2(1.0, 0.5)
		blob_tex.width = 64
		blob_tex.height = 64

		var mat := StandardMaterial3D.new()
		mat.albedo_color = Color(1, 1, 1)
		mat.albedo_texture = blob_tex
		mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		# Without this the colour ramp above is thrown away and every droplet
		# renders in the flat albedo instead.
		mat.vertex_color_use_as_albedo = true
		mat.roughness = 0.14
		mat.metallic = 0.75
		mat.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
		mat.shading_mode = BaseMaterial3D.SHADING_MODE_PER_PIXEL
		# A little glow, so the plume separates from the land behind it rather
		# than merging into the dark ground it just came out of.
		mat.emission_enabled = true
		mat.emission = Color(0.10, 0.075, 0.045)
		mat.emission_energy_multiplier = 0.28

		var mesh := QuadMesh.new()
		mesh.size = Vector2(1.7, 1.7)
		mesh.material = mat

		var node := GPUParticles3D.new()
		node.process_material = pm
		node.draw_pass_1 = mesh
		node.amount = 420
		node.lifetime = 4.2
		node.emitting = false
		node.visible = false
		node.local_coords = false
		# The plume is thrown well clear of its own origin, so let it keep
		# drawing when the vent itself has gone off the edge of the view.
		node.extra_cull_margin = 80.0
		add_child(node)
		_vents.append({"node": node, "world": Vector2.ZERO, "stain": 0.0,
			"blown": false})


## Blow a vent, right now, where you can see it.
##
## An earlier version armed them far ahead and waited for you to arrive. That
## reads better in principle but almost never fired: a spot off to the side
## swings abeam as you approach, so it is never both close AND in front, and
## a spot on your exact line needs a fissure there, which -- at four percent
## ground cover -- there usually is not. The result was you passing through
## spills that had erupted unseen. Erupting in view, on a timer, is simpler
## and it is what was actually asked for.
func _blow_vent() -> bool:
	var slot: Dictionary = {}
	for v in _vents:
		if not v.blown:
			slot = v
			break
	if slot.is_empty():
		return false

	# Straight down the middle of what the camera is looking at.
	var look: float = heading + _gaze_yaw
	var fwd := Vector2(-sin(look), -cos(look))
	var perp := Vector2(fwd.y, -fwd.x)
	var spread: float = tan(deg_to_rad(VENT_VIEW_CONE))

	# Take the deepest fissure in the visible patch, but settle for whatever is
	# there. Crude coming up through a hairline fracture in whole ground is no
	# less alarming than one out of an open fissure, and waiting for a perfect
	# spot is what left the event silent for ten seconds at a time.
	var best := Vector2.ZERO
	var best_score: float = -1.0
	var d: float = VENT_NEAR
	while d <= VENT_FAR:
		var half: float = d * spread
		for k in 5:
			var p: Vector2 = scroll_offset + fwd * d + perp * lerpf(-half, half, float(k) / 4.0)
			var score: float = TerrainNoise.crack(p, 1.0)
			if score <= best_score:
				continue
			var clear := true
			for other in _vents:
				if other.blown and other.world.distance_to(p) < VENT_SPREAD:
					clear = false
					break
			if clear:
				best_score = score
				best = p
		d += 6.0
	if best_score < 0.0:
		return false

	slot.world = best
	slot.blown = true
	slot.stain = 0.0
	slot.node.visible = true
	slot.node.restart()
	slot.node.emitting = true
	print("[alter] a vent blows %dm ahead" % int((best - scroll_offset).length()))
	return true


func _open_vents() -> void:
	if _vents.is_empty():
		return
	for v in _vents:
		v.blown = false
		v.stain = 0.0
		v.node.emitting = false
		v.node.visible = false
	_vent_gap = 0.0  # one straight away, so the command visibly does something


func _update_vents(delta: float) -> void:
	if _vents.is_empty() or _terrain_mat == null:
		return
	var erupting: bool = _alter_left > 0.0

	# A new one every couple of seconds, for as long as the event lasts. This
	# is what spreads the eruptions across a thirty second ALTER instead of
	# firing them all in the first five.
	if erupting:
		_vent_gap -= delta
		if _vent_gap <= 0.0:
			_vent_gap = _rng.randf_range(VENT_GAP.x, VENT_GAP.y) if _blow_vent() else 0.8

	for i in _vents.size():
		var v: Dictionary = _vents[i]
		var g := Vector4.ZERO
		if v.blown:
			var d: Vector2 = v.world - scroll_offset
			if erupting:
				v.stain = minf(v.stain + STAIN_GROWTH * delta, STAIN_MAX)
				# Once it is behind us and off screen, recycle the slot so
				# another can blow ahead. With only four, spent plumes sitting
				# out of sight would starve the rest of the event.
				if -d.dot(travel_dir) > VENT_RETIRE:
					v.blown = false
					v.node.emitting = false
					v.node.visible = false
					_terrain_mat.set_shader_parameter("geyser_%d" % i, Vector4.ZERO)
					continue
			else:
				v.node.emitting = false
				if alter_amount <= 0.001:
					v.blown = false
					v.node.visible = false
			d.x = wrapf(d.x, -WRAP_PERIOD * 0.5, WRAP_PERIOD * 0.5)
			d.y = wrapf(d.y, -WRAP_PERIOD * 0.5, WRAP_PERIOD * 0.5)
			# Erupt from down inside the fissure, not off the surface that used
			# to be there.
			var y: float = ground_height(v.world) - TerrainNoise.crack_drop(v.world, alter_amount) + 1.0
			v.node.position = Vector3(d.x, y, d.y)
			g = Vector4(v.world.x, v.world.y, v.stain, clampf(alter_amount * 1.4, 0.0, 1.0))
		_terrain_mat.set_shader_parameter("geyser_%d" % i, g)


# -------------------------------------------------------------------- animals

func _build_animals() -> void:
	if animals.is_empty():
		return
	_animals = AnimalField.new()
	_animals.name = "Animals"
	_animals.species = animals
	add_child(_animals)
	_animals.setup(self)


# -------------------------------------------------------------------- canyons

const CANYON_SIDE := 26.0  ## meters either side where we feel for walls
const CANYON_AHEAD := 45.0 ## meters ahead we look for the lane


## Meters the ground rises on the SHALLOWER side of us. Positive means the land
## closes in both ways -- we are in a canyon, a gully or at least a dip.
func _measure_walls() -> float:
	var perp := Vector2(travel_dir.y, -travel_dir.x)
	var here: float = ground_height(scroll_offset)
	var left: float = ground_height(scroll_offset + perp * CANYON_SIDE)
	var right: float = ground_height(scroll_offset - perp * CANYON_SIDE)
	return minf(left, right) - here


## Heading offset that keeps the ground lowest ahead. A canyon floor is the
## lowest thing around, so steering downhill IS following the canyon -- no
## need to know anything about the noise that carved it.
func _canyon_bearing() -> float:
	var best: float = 0.0
	var best_h: float = INF
	for i in range(-4, 5):
		var dh: float = deg_to_rad(float(i) * 11.0)
		var d := Vector2(-sin(heading + dh), -cos(heading + dh))
		# Two probes so it commits to a lane that keeps going, not a pothole.
		var h: float = ground_height(scroll_offset + d * CANYON_AHEAD) \
				+ ground_height(scroll_offset + d * (CANYON_AHEAD * 0.5))
		if h < best_h:
			best_h = h
			best = dh
	return best


## Drop into a canyon when one closes in, ride it downstream for a while, then
## let it go and stay out in the open until the next one.
func _update_canyon(delta: float) -> void:
	canyon_walls = _measure_walls()
	if c.canyon_follow_strength <= 0.0:
		_canyon_following = false
		return
	_canyon_timer -= delta
	if not _canyon_following:
		if _canyon_timer <= 0.0 and canyon_walls >= c.canyon_enter_depth:
			_canyon_following = true
			_canyon_timer = c.canyon_follow_time
		return
	# Time's up, or the walls fell away and the canyon opened out.
	if _canyon_timer <= 0.0 or canyon_walls < c.canyon_exit_depth:
		_canyon_following = false
		_canyon_timer = c.canyon_follow_cooldown
		return
	var t: float = clamp(c.canyon_follow_strength * delta * 3.0, 0.0, 1.0)
	_heading_target += _canyon_bearing() * t


func _push_terrain_params() -> void:
	var b: WorldConfig = _to if _transitioning else _from
	var a0 := Vector4(_from.hill_scale, _from.hill_height, _from.mountain_scale, _from.mountain_height)
	var a1 := Vector3(_from.warp_strength, _from.terrace_step, _from.terrace_strength)
	var a2 := Vector3(_from.canyon_scale, _from.canyon_depth, _from.canyon_width)
	var b0 := Vector4(b.hill_scale, b.hill_height, b.mountain_scale, b.mountain_height)
	var b1 := Vector3(b.warp_strength, b.terrace_step, b.terrace_strength)
	var b2 := Vector3(b.canyon_scale, b.canyon_depth, b.canyon_width)
	for mat in [_terrain_mat, _grass_mat, _flower_mat]:
		if mat == null:
			continue
		mat.set_shader_parameter("terrain_a0", a0)
		mat.set_shader_parameter("terrain_a1", a1)
		mat.set_shader_parameter("terrain_a2", a2)
		mat.set_shader_parameter("terrain_b0", b0)
		mat.set_shader_parameter("terrain_b1", b1)
		mat.set_shader_parameter("terrain_b2", b2)
		mat.set_shader_parameter("terrain_blend", _blend if _transitioning else 0.0)


## Push every live (blendable) value that lives in a material.
func _apply_live() -> void:
	_terrain_mat.set_shader_parameter("color_low", c.color_low)
	_terrain_mat.set_shader_parameter("color_high", c.color_high)
	_terrain_mat.set_shader_parameter("color_rock", c.color_rock)
	_terrain_mat.set_shader_parameter("color_peak", c.color_peak)
	_terrain_mat.set_shader_parameter("grid_color", c.terrain_grid_color)
	_terrain_mat.set_shader_parameter("grid_spacing", c.terrain_grid_spacing)
	_terrain_mat.set_shader_parameter("grid_width", c.terrain_grid_width)
	_terrain_mat.set_shader_parameter("contour_color", c.terrain_contour_color)
	_terrain_mat.set_shader_parameter("contour_step", c.terrain_contour_step)
	_terrain_mat.set_shader_parameter("contour_width", c.terrain_contour_width)
	_terrain_mat.set_shader_parameter("line_pulse", c.terrain_line_pulse)

	if _grass_mat:
		_grass_mat.set_shader_parameter("bend_strength", c.grass_bend_strength)
		_grass_mat.set_shader_parameter("color_base", c.grass_color_base)
		_grass_mat.set_shader_parameter("color_tip", c.grass_color_tip)
		_grass_mat.set_shader_parameter("tip_emission", c.grass_tip_emission)
		_grass_mat.set_shader_parameter("height_min", c.grass_height_min)
		_grass_mat.set_shader_parameter("height_max", c.grass_height_max)
		_grass_mmi.multimesh.visible_instance_count = clampi(c.grass_count, 0, _grass_max)

	_flower_mat.set_shader_parameter("bend_strength", c.flower_bend_strength)
	_flower_mat.set_shader_parameter("scale_min", c.flower_scale_min)
	_flower_mat.set_shader_parameter("scale_max", c.flower_scale_max)
	_flower_mat.set_shader_parameter("emission_energy", c.flower_emission_energy)
	_flower_mmi.multimesh.visible_instance_count = clampi(c.flower_count, 0, _flower_max)


## Flower palette padded to the shader's 8 slots.
func _palette(cfg: WorldConfig) -> PackedColorArray:
	var out := cfg.flower_colors.slice(0, 8)
	if out.is_empty():
		out.append(Color.WHITE)
	while out.size() < 8:
		out.append(out[0])
	return out


func _push_palettes() -> void:
	var b: WorldConfig = _to if _transitioning else _from
	for pair in [["palette_a", _from], ["palette_b", b]]:
		var cfg: WorldConfig = pair[1]
		_flower_mat.set_shader_parameter(pair[0], _palette(cfg))
		_flower_mat.set_shader_parameter(pair[0] + "_count", clampi(cfg.flower_colors.size(), 1, 8))
	_flower_mat.set_shader_parameter("palette_blend", _blend if _transitioning else 0.0)


# ---------------------------------------------------------------- environment

func _build_environment() -> void:
	_world_env = WorldEnvironment.new()
	var env := Environment.new()
	env.background_mode = Environment.BG_SKY

	_sky_mat = ProceduralSkyMaterial.new()
	_sky_mat.sun_angle_max = 30.0

	var sky := Sky.new()
	sky.sky_material = _sky_mat
	env.sky = sky

	env.fog_enabled = true
	env.fog_sky_affect = 0.3

	env.tonemap_mode = Environment.TONE_MAPPER_FILMIC
	env.glow_enabled = true
	env.glow_bloom = 0.05

	env.ssao_enabled = false
	env.sdfgi_enabled = false

	_world_env.environment = env
	add_child(_world_env)


func _build_sun() -> void:
	_sun = DirectionalLight3D.new()
	_sun.shadow_enabled = true
	add_child(_sun)
	_update_mood()


func _update_mood() -> void:
	# Purely atmospheric: the live config's calm and windy looks, blended by
	# the live wind value.
	var n: float = WindInput.get_speed_normalized()
	var env := _world_env.environment
	_sky_mat.sky_top_color = c.sky_top_calm.lerp(c.sky_top_windy, n)
	_sky_mat.sky_horizon_color = c.sky_horizon_calm.lerp(c.sky_horizon_windy, n)
	# Beyond the terrain edge: blend into the haze.
	_sky_mat.ground_horizon_color = _sky_mat.sky_horizon_color
	_sky_mat.ground_bottom_color = _sky_mat.sky_horizon_color
	env.fog_light_color = c.fog_color
	env.fog_density = lerp(c.fog_density_calm, c.fog_density_windy, n)
	env.glow_intensity = c.glow_intensity
	env.glow_bloom = c.glow_bloom
	_sun.light_energy = lerp(c.sun_energy_calm, c.sun_energy_windy, n)
	_sun.light_color = c.sun_color
	_sun.rotation_degrees = c.sun_rotation_deg
	_apply_alter_mood()


# --------------------------------------------------------------------- terrain

func _build_terrain() -> void:
	# Grid cell that divides WRAP_PERIOD exactly, so the lattice is identical
	# after scroll_offset wraps. (PlaneMesh has subdivisions + 1 cells per side.)
	var cells: int = c.terrain_subdivisions + 1
	_terrain_cell = WRAP_PERIOD / round(WRAP_PERIOD / (c.terrain_size / cells))

	var mesh := PlaneMesh.new()
	mesh.size = Vector2(_terrain_cell * cells, _terrain_cell * cells)
	mesh.subdivide_width = c.terrain_subdivisions
	mesh.subdivide_depth = c.terrain_subdivisions

	_terrain_mat = ShaderMaterial.new()
	_terrain_mat.shader = load("res://shaders/terrain.gdshader")

	_terrain_mi = MeshInstance3D.new()
	_terrain_mi.mesh = mesh
	_terrain_mi.material_override = _terrain_mat
	# The plane's vertex shader displaces Y itself; a generous AABB stops
	# Godot from culling it before the shader has a chance to run.
	_terrain_mi.extra_cull_margin = 80.0
	add_child(_terrain_mi)


func _update_terrain_snap() -> void:
	# Move the mesh in whole grid cells in world terms: its vertices always sit
	# on the same world lattice points, so the land doesn't shimmer as it
	# scrolls. Only the sub-cell remainder is applied as a node offset.
	var grid := (scroll_offset / _terrain_cell).floor() * _terrain_cell
	var frac := grid - scroll_offset
	_terrain_mi.position = Vector3(frac.x, 0.0, frac.y)
	_terrain_mat.set_shader_parameter("grid_origin", grid)


# ----------------------------------------------------------------------- grass

func _build_blade_mesh(segments: int = 4, base_width: float = 0.05) -> ArrayMesh:
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var left: Array = []
	var right: Array = []
	for i in range(segments + 1):
		var t: float = float(i) / float(segments)
		var w: float = base_width * (1.0 - t) * (1.0 - t * 0.3)
		left.append(Vector3(-w * 0.5, t, 0.0))
		right.append(Vector3(w * 0.5, t, 0.0))
	for i in range(segments):
		var bl: Vector3 = left[i]
		var br: Vector3 = right[i]
		var tl: Vector3 = left[i + 1]
		var top_r: Vector3 = right[i + 1]
		var uv_b: float = float(i) / float(segments)
		var uv_t: float = float(i + 1) / float(segments)
		st.set_uv(Vector2(0, uv_b)); st.add_vertex(bl)
		st.set_uv(Vector2(1, uv_b)); st.add_vertex(br)
		st.set_uv(Vector2(1, uv_t)); st.add_vertex(top_r)
		st.set_uv(Vector2(0, uv_b)); st.add_vertex(bl)
		st.set_uv(Vector2(1, uv_t)); st.add_vertex(top_r)
		st.set_uv(Vector2(0, uv_t)); st.add_vertex(tl)
	st.generate_normals()
	return st.commit()


func _build_grass() -> void:
	if not show_grass:
		print("[display] grass off -- not building the field")
		return
	_grass_mat = ShaderMaterial.new()
	_grass_mat.shader = load("res://shaders/grass.gdshader")
	_grass_mat.set_shader_parameter("tile_size", _field_tile)

	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.use_custom_data = true
	mm.mesh = _build_blade_mesh()
	mm.instance_count = _grass_max

	# Instances are uniformly random, so drawing only the first N of them
	# (visible_instance_count) is still an even field.
	var rng := RandomNumberGenerator.new()
	rng.seed = 1337
	var half: float = _field_tile * 0.5
	# Tussocks: every `clump` consecutive blades share a crown and fan out of
	# it, leaving bare ground between clumps. clump = 1 is the old even lawn.
	# Consecutive so that drawing only the first N instances still yields whole
	# clumps rather than shredding them.
	var clump: int = maxi(c.grass_clump_size, 1)
	var crown := Vector2.ZERO
	for i in range(_grass_max):
		if i % clump == 0:
			crown = Vector2(rng.randf_range(-half, half), rng.randf_range(-half, half))
		var pos := Vector3(crown.x, 0.0, crown.y)
		var width_scale: float = rng.randf_range(0.7, 1.3)
		var rot: float = rng.randf_range(0.0, TAU)
		var b := Basis(Vector3.UP, rot).scaled(Vector3(width_scale, 1.0, 1.0))
		if clump > 1:
			# Biased toward the middle, so the clump has a dense heart.
			var a: float = rng.randf() * TAU
			var d: float = c.grass_clump_radius * pow(rng.randf(), 0.7)
			var out := Vector3(cos(a), 0.0, sin(a))
			pos += out * d
			# Lean away from the crown, more the further out -- a fountain.
			if d > 0.001 and c.grass_clump_splay > 0.0:
				var axis: Vector3 = Vector3.UP.cross(out).normalized()
				var lean: float = c.grass_clump_splay * (d / maxf(c.grass_clump_radius, 0.001))
				b = Basis(axis, lean) * b
		mm.set_instance_transform(i, Transform3D(b, pos))
		mm.set_instance_custom_data(i, Color(rng.randf(), 0.0, 0.0, 0.0)) # r = height pick

	_grass_mmi = MultiMeshInstance3D.new()
	_grass_mmi.multimesh = mm
	_grass_mmi.material_override = _grass_mat
	# Large fixed AABB: instances get shader-displaced far from their
	# authored position, so auto-culling can't be trusted.
	_grass_mmi.extra_cull_margin = _field_tile + 60.0
	add_child(_grass_mmi)


# --------------------------------------------------------------------- flowers

func _build_flower_mesh() -> ArrayMesh:
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)

	# Stem.
	var stem_segments: int = 3
	var stem_top: float = 0.6
	var left: Array = []
	var right: Array = []
	for i in range(stem_segments + 1):
		var t: float = float(i) / float(stem_segments)
		var y: float = t * stem_top
		var w: float = 0.02 * (1.0 - t * 0.4)
		left.append(Vector3(-w * 0.5, y, 0.0))
		right.append(Vector3(w * 0.5, y, 0.0))
	for i in range(stem_segments):
		var bl: Vector3 = left[i]
		var br: Vector3 = right[i]
		var tl: Vector3 = left[i + 1]
		var top_r: Vector3 = right[i + 1]
		var uv_b: float = (float(i) / float(stem_segments)) * 0.6
		var uv_t: float = (float(i + 1) / float(stem_segments)) * 0.6
		st.set_uv(Vector2(0, uv_b)); st.add_vertex(bl)
		st.set_uv(Vector2(1, uv_b)); st.add_vertex(br)
		st.set_uv(Vector2(1, uv_t)); st.add_vertex(top_r)
		st.set_uv(Vector2(0, uv_b)); st.add_vertex(bl)
		st.set_uv(Vector2(1, uv_t)); st.add_vertex(top_r)
		st.set_uv(Vector2(0, uv_t)); st.add_vertex(tl)

	# Flower head: a small fan of petals at the top of the stem.
	var center := Vector3(0, stem_top, 0)
	var petal_count: int = 6
	var petal_len: float = 0.16
	var petal_w: float = 0.09
	for i in range(petal_count):
		var ang: float = TAU * float(i) / float(petal_count)
		var dir3 := Vector3(cos(ang), 0.2, sin(ang)).normalized()
		var side := Vector3(-sin(ang), 0.0, cos(ang)) * petal_w * 0.5
		var tip: Vector3 = center + dir3 * petal_len
		var base_l: Vector3 = center - side
		var base_r: Vector3 = center + side
		st.set_uv(Vector2(0.5, 1.0)); st.add_vertex(base_l)
		st.set_uv(Vector2(0.5, 1.0)); st.add_vertex(base_r)
		st.set_uv(Vector2(0.5, 1.0)); st.add_vertex(tip)

	st.generate_normals()
	return st.commit()


func _build_flowers() -> void:
	_flower_mat = ShaderMaterial.new()
	_flower_mat.shader = load("res://shaders/flower.gdshader")
	_flower_mat.set_shader_parameter("tile_size", _field_tile)

	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.use_custom_data = true
	mm.mesh = _build_flower_mesh()
	mm.instance_count = _flower_max

	var rng := RandomNumberGenerator.new()
	rng.seed = 4242
	var half: float = _field_tile * 0.5
	for i in range(_flower_max):
		var x: float = rng.randf_range(-half, half)
		var z: float = rng.randf_range(-half, half)
		var rot: float = rng.randf_range(0.0, TAU)
		mm.set_instance_transform(i, Transform3D(Basis(Vector3.UP, rot), Vector3(x, 0.0, z)))
		# r = palette pick, g = brightness jitter, b = size pick
		mm.set_instance_custom_data(i, Color(rng.randf(), rng.randf(), rng.randf(), 0.0))

	_flower_mmi = MultiMeshInstance3D.new()
	_flower_mmi.multimesh = mm
	_flower_mmi.material_override = _flower_mat
	_flower_mmi.extra_cull_margin = _field_tile + 60.0
	add_child(_flower_mmi)


# ------------------------------------------------------------------- particles

func _build_particles(cfg: WorldConfig) -> void:
	var shader: Shader = load("res://shaders/petal.gdshader")
	for layer: ParticleLayer in cfg.particle_layers:
		if layer == null or layer.amount <= 0:
			continue
		var p := GPUParticles3D.new()
		p.amount = layer.amount
		p.lifetime = layer.lifetime
		p.local_coords = true  # emitter follows the camera; that's the point
		p.visibility_aabb = AABB(-layer.area - Vector3.ONE * 10.0, (layer.area + Vector3.ONE * 10.0) * 2.0)
		p.visible = _particles_visible
		# A new preset's layers fade in (see _update_particles).
		p.amount_ratio = 0.0 if cfg != _from else 1.0

		var quad := QuadMesh.new()
		quad.size = Vector2(layer.size, layer.size)
		p.draw_pass_1 = quad

		var mat := ShaderMaterial.new()
		mat.shader = shader
		p.material_override = mat

		var pm := ParticleProcessMaterial.new()
		pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_BOX
		pm.emission_box_extents = layer.area
		pm.gravity = Vector3(0, layer.gravity, 0)
		pm.direction = Vector3(1, 0, 0)
		pm.spread = 25.0
		pm.initial_velocity_min = 0.3
		pm.initial_velocity_max = 1.0
		pm.angular_velocity_min = -layer.angular_velocity
		pm.angular_velocity_max = layer.angular_velocity
		pm.scale_min = layer.scale_min
		pm.scale_max = layer.scale_max

		var ramp := Gradient.new()
		var a0 := layer.color_start
		var a1 := layer.color_end
		ramp.set_color(0, Color(a0.r, a0.g, a0.b, 0.0))
		ramp.add_point(0.15, a0)
		ramp.add_point(0.8, a1)
		ramp.set_color(1, Color(a1.r, a1.g, a1.b, 0.0))
		var ramp_tex := GradientTexture1D.new()
		ramp_tex.use_hdr = true # colors above 1.0 glow (embers)
		ramp_tex.gradient = ramp
		pm.color_ramp = ramp_tex

		p.process_material = pm
		add_child(p)
		_particles.append({"node": p, "pm": pm, "layer": layer, "cfg": cfg})


func _update_particles(dir: Vector2, speed: float) -> void:
	# Particles ride the wind, plus the forward travel streaming them past us.
	var v := Vector3(dir.x * speed, 0.0, dir.y * speed) + Vector3(-travel_dir.x, 0.0, -travel_dir.y) * forward_speed
	for e in _particles:
		var pm: ParticleProcessMaterial = e.pm
		var layer: ParticleLayer = e.layer
		if _transitioning:
			e.node.amount_ratio = _blend if e.cfg == _to else 1.0 - _blend
		var lv: Vector3 = v * layer.wind_follow
		var vlen: float = max(lv.length(), 0.01)
		pm.direction = Vector3(lv.x, -0.1 * vlen, lv.z) / vlen
		pm.initial_velocity_min = 0.2 + vlen * 0.15
		pm.initial_velocity_max = 0.6 + vlen * 0.35
		pm.spread = clamp(30.0 - speed * 1.2, 6.0, 30.0)


# ----------------------------------------------------------------------- props
# Placeholder primitives scattered over the land. Each has a fixed world
# position; its on-screen position is (world - scroll_offset). When one drifts
# out of the prop tile it is recycled to the opposite edge (ahead of us, for
# whatever heading) with a new shape, color and size -- taken from the preset
# we're blending toward with probability = blend progress, so a transition
# replaces the props gradually as we travel. It grows in from zero at the edge
# so there's no pop.
#
# A few come back "special": glowing, hovering, spinning. The camera notices
# those and watches them for a while as it passes (see _update_interest).

func _make_prop_mesh(shape: String) -> Array:
	match shape:
		"box": return [BoxMesh.new(), 0.5]
		"sphere": return [SphereMesh.new(), 0.5]
		"cylinder": return [CylinderMesh.new(), 1.0]
		"prism": return [PrismMesh.new(), 0.5]
		"torus": return [TorusMesh.new(), 0.25]
		"capsule": return [CapsuleMesh.new(), 1.0]
		"cone":
			var cone := CylinderMesh.new()
			cone.top_radius = 0.0
			cone.bottom_radius = 0.6
			cone.height = 1.6
			return [cone, 0.8]
	push_warning("WorldConfig: unknown prop shape '%s', using box" % shape)
	return [BoxMesh.new(), 0.5]


## Resolve a list of shape names to [mesh, half_height] entries. Primitives
## are shared; plants get a new variant for each repeat of the name.
func _shape_entries(shapes: PackedStringArray, cache: Dictionary) -> Array:
	var out := []
	var seen := {}
	# With primitives off, keep only the real plants. A preset made ENTIRELY of
	# primitives would be left with nothing to scatter, so in that case we let
	# them through rather than emptying the land.
	var wanted := shapes
	if not show_primitives:
		var plants_only: PackedStringArray = []
		for shape in shapes:
			if Plants.KINDS.has(shape):
				plants_only.append(shape)
		if not plants_only.is_empty():
			wanted = plants_only
	for shape in wanted:
		if Plants.KINDS.has(shape):
			var n: int = seen.get(shape, 0)
			seen[shape] = n + 1
			var key: String = "%s#%d" % [shape, n]
			if not cache.has(key):
				# Plant meshes grow up from their base, so half_height = 0; the
				# third element marks it as a plant.
				cache[key] = [Plants.build(shape, 1000 + n * 7919), 0.0, true]
			out.append(cache[key])
		else:
			if not cache.has(shape):
				cache[shape] = _make_prop_mesh(shape)
			out.append(cache[shape]) # repeats keep their weight
	return out


## Meshes and materials for one preset's props, built on first use.
func _pool(cfg: WorldConfig) -> Dictionary:
	if _pools.has(cfg):
		return _pools[cfg]
	var cache := {}
	var meshes := _shape_entries(cfg.prop_shapes, cache)
	var mats := []
	for col in cfg.prop_colors:
		var m := StandardMaterial3D.new()
		m.albedo_color = col
		m.roughness = cfg.prop_roughness
		# Plants carry their own vertex colors (tinted by albedo); primitives
		# have none, which reads as white, so they're just albedo.
		m.vertex_color_use_as_albedo = true
		m.cull_mode = BaseMaterial3D.CULL_DISABLED
		if cfg.prop_emission_energy > 0.0:
			m.emission_enabled = true
			m.emission = col
			m.emission_energy_multiplier = cfg.prop_emission_energy
		mats.append(m)
	var special_meshes := _shape_entries(cfg.special_shapes, cache)
	var sm := StandardMaterial3D.new()
	sm.albedo_color = cfg.special_albedo
	sm.emission_enabled = true
	sm.emission = cfg.special_emission
	sm.emission_energy_multiplier = cfg.special_emission_energy
	sm.roughness = 0.3
	sm.metallic = 0.2
	sm.rim_enabled = true
	sm.rim = 0.6
	# Plants keep their own vertex colors, only multiplied by plant_tint.
	var pm := StandardMaterial3D.new()
	pm.albedo_color = cfg.plant_tint
	pm.roughness = 0.9
	pm.vertex_color_use_as_albedo = true
	pm.cull_mode = BaseMaterial3D.CULL_DISABLED
	var pool := {"meshes": meshes, "mats": mats, "plant_mat": pm, "special_meshes": special_meshes, "special_mat": sm}
	_pools[cfg] = pool
	return pool


func _build_props() -> void:
	var half: float = c.prop_tile_size * 0.5
	for i in range(_prop_max):
		var p := {"node": MeshInstance3D.new(), "light": null, "gen": 0, "active": i < c.prop_count}
		add_child(p.node)
		_respawn_prop(p, Vector2(_rng.randf_range(-half, half), _rng.randf_range(-half, half)))
		_props.append(p)


## local: camera-relative XZ spot to (re)place the prop at.
func _respawn_prop(p: Dictionary, local: Vector2) -> void:
	var cfg: WorldConfig = _to if (_transitioning and _rng.randf() < _blend) else _from
	p.cfg = cfg
	var pool := _pool(cfg)
	var node: MeshInstance3D = p.node
	p.gen += 1
	var perp := Vector2(travel_dir.y, -travel_dir.x)
	var along: float = local.dot(travel_dir)

	# Specials only appear well ahead, a little off to the side, so the
	# camera has time to notice them and turn to watch.
	p.special = (along > c.prop_tile_size * 0.25 and not pool.special_meshes.is_empty()
		and _rng.randf() < cfg.special_chance and not _special_in_view(p))

	var entry: Array
	if p.special:
		entry = pool.special_meshes[_rng.randi_range(0, pool.special_meshes.size() - 1)]
		node.material_override = pool.special_mat
		p.size = _rng.randf_range(cfg.special_size_min, cfg.special_size_max)
		p.stretch = cfg.special_stretch
		p.hover = cfg.special_hover_height
		p.hover_amp = cfg.special_hover_amplitude
		p.spin = deg_to_rad(cfg.special_spin_deg)
		p.phase = _rng.randf() * TAU
		node.rotation = Vector3(0.0, _rng.randf_range(0.0, TAU), 0.0)
		var side: float = 1.0 if _rng.randf() < 0.5 else -1.0
		local = travel_dir * along + perp * side * _rng.randf_range(cfg.prop_clear_path + p.size * 2.0, 30.0)
		if p.light == null:
			p.light = OmniLight3D.new()
			p.light.shadow_enabled = false
			add_child(p.light)
		p.light.light_color = cfg.special_emission
		p.light.omni_range = cfg.special_light_range
		p.light_energy = cfg.special_light_energy
		p.light.visible = true
	else:
		if pool.meshes.is_empty() or pool.mats.is_empty():
			node.visible = false
			p.size = 0.0
			p.stretch = 1.0
			p.half_h = 0.5
			p.world = scroll_offset + local
			p.ground = 0.0
			p.hover = 0.0
			p.special = false
			if p.light:
				p.light.visible = false
			return
		entry = pool.meshes[_rng.randi_range(0, pool.meshes.size() - 1)]
		var is_plant: bool = entry.size() > 2 and entry[2]
		if is_plant:
			# Plants: natural colors and sizes, upright, sitting on the ground.
			node.material_override = pool.plant_mat
			var lean: float = deg_to_rad(3.0)
			node.rotation = Vector3(_rng.randf_range(-lean, lean), _rng.randf_range(0.0, TAU), _rng.randf_range(-lean, lean))
			p.size = _rng.randf_range(cfg.plant_size_min, cfg.plant_size_max)
			p.stretch = _rng.randf_range(0.9, 1.1)
			p.hover = 0.0
		else:
			node.material_override = pool.mats[_rng.randi_range(0, pool.mats.size() - 1)]
			var tilt: float = deg_to_rad(cfg.prop_tilt_max_deg)
			node.rotation = Vector3(_rng.randf_range(-tilt, tilt), _rng.randf_range(0.0, TAU), _rng.randf_range(-tilt, tilt))
			# Mostly small, now and then a big landmark.
			if _rng.randf() < cfg.prop_landmark_chance:
				p.size = _rng.randf_range(cfg.prop_landmark_size_min, cfg.prop_landmark_size_max)
			else:
				p.size = _rng.randf_range(cfg.prop_size_min, cfg.prop_size_max)
			p.stretch = _rng.randf_range(cfg.prop_stretch_min, cfg.prop_stretch_max)
			p.hover = -p.size * p.stretch * 2.0 * entry[1] * cfg.prop_sink # buried part
		p.hover_amp = 0.0
		p.spin = 0.0
		if p.light:
			p.light.visible = false
		# Keep the lane ahead of the camera clear -- wider for bigger props.
		var clear: float = cfg.prop_clear_path + p.size * 0.8
		var lateral: float = local.dot(perp)
		if along > 0.0 and abs(lateral) < clear:
			local += perp * (clear if lateral >= 0.0 else -clear)

	node.mesh = entry[0]
	p.half_h = entry[1]
	p.world = scroll_offset + local
	p.ground = ground_height(p.world)


## Is some other special prop still ahead of us (or beside us)? Only one is
## ever in view at a time.
func _special_in_view(except: Dictionary) -> bool:
	for q in _props:
		if q != except and q.get("special", false) and _prop_offset(q).dot(travel_dir) > -10.0:
			return true
	return false


## Props left over from the previous preset get swapped out while they're
## behind us (out of view), so a new look fills in quickly instead of waiting
## for everything to recycle naturally.
func _swap_old_props() -> void:
	var target: WorldConfig = _to if _transitioning else _from
	var half: float = c.prop_tile_size * 0.5
	var perp := Vector2(travel_dir.y, -travel_dir.x)
	var budget: int = 4
	for p in _props:
		if budget <= 0:
			break
		if not p.active or p.get("cfg") == target or p == _interest:
			continue
		if _prop_offset(p).dot(travel_dir) > -8.0:
			continue
		# During a blend the respawn picks old/new by blend progress, so the
		# swap-over follows the transition.
		_respawn_prop(p, travel_dir * half * 0.97 + perp * _rng.randf_range(-half, half))
		budget -= 1


func _update_props(delta: float) -> void:
	var half: float = c.prop_tile_size * 0.5
	_swap_old_props()
	# While the land is morphing, keep re-seating props on it, a few per frame.
	if _transitioning and not _props.is_empty():
		for i in range(8):
			_prop_refresh_i = (_prop_refresh_i + 1) % _props.size()
			var q: Dictionary = _props[_prop_refresh_i]
			q.ground = ground_height(q.world)
	var active_count: int = clampi(c.prop_count, 0, _props.size())
	var perp := Vector2(travel_dir.y, -travel_dir.x)
	for i in range(_props.size()):
		var p: Dictionary = _props[i]
		# The live prop_count (blended between presets) decides how many are
		# active. Newly active ones start at the far edge ahead and grow in.
		var want_active: bool = i < active_count
		if want_active != p.active:
			p.active = want_active
			if want_active:
				_respawn_prop(p, travel_dir * half * 0.97 + perp * _rng.randf_range(-half, half))
		if not p.active:
			p.node.visible = false
			p.special = false
			if p.light:
				p.light.visible = false
			continue
		var d: Vector2 = p.world - scroll_offset
		d.x = wrapf(d.x, -WRAP_PERIOD * 0.5, WRAP_PERIOD * 0.5)
		d.y = wrapf(d.y, -WRAP_PERIOD * 0.5, WRAP_PERIOD * 0.5)
		# Left the tile through one side: re-enter through the opposite side,
		# at a random spot along it.
		if abs(d.x) > half:
			_respawn_prop(p, Vector2(wrapf(d.x, -half, half), _rng.randf_range(-half, half)))
			d = p.world - scroll_offset
		elif abs(d.y) > half:
			_respawn_prop(p, Vector2(_rng.randf_range(-half, half), wrapf(d.y, -half, half)))
			d = p.world - scroll_offset
		if p.size <= 0.0:
			continue
		# Grow in over the outer 20% of the tile.
		var grow: float = smoothstep(half, half * 0.8, max(abs(d.x), abs(d.y)))
		var s: float = p.size * grow
		var sy: float = s * p.stretch
		var node: MeshInstance3D = p.node
		node.visible = grow > 0.001
		node.scale = Vector3(s, sy, s)
		var y: float = p.ground + p.half_h * sy + p.hover * grow
		if alter_amount > 0.0:
			y -= TerrainNoise.crack_drop(p.world, alter_amount)
		if p.special:
			y += sin(_t * 0.7 + p.phase) * p.hover_amp
			node.rotation.y += p.spin * delta
			p.light.position = Vector3(d.x, y, d.y)
			p.light.light_energy = p.light_energy * grow
		node.position = Vector3(d.x, y, d.y)


# --------------------------------------------------------------------- camera
# We're the wind, not a walker. Vertical motion is a small flight model: we
# look up to camera_lookahead meters ahead and climb early enough to clear
# whatever is coming; going down we're only pulled by a weak, moon-like
# gravity, so we float over dips and sail past crests. On top of that: slow
# breathing and drift, banking into turns, a gaze that tilts with the slope
# and with our climb, and that turns toward special props.

func _build_camera() -> void:
	_camera = Camera3D.new()
	_camera.current = true
	_camera.fov = c.camera_fov
	_camera.far = c.terrain_size * 0.5
	add_child(_camera)
	_cam_ground = ground_height(scroll_offset)
	_cam_y = _cam_ground + c.camera_height
	_cam_vy = 0.0
	_cam_pitch = -atan2(c.camera_look_down, 10.0)
	_prev_heading = heading
	_update_camera(0.0)


## Vertical speed we'd need right now: enough to reach (most of) cruise height
## above every sample of the ground ahead by the time we get there, or else
## a gentle settle back toward cruise height over the ground below.
func _needed_climb_speed(off: Vector2, ground_here: float) -> float:
	var cruise: float = c.camera_height
	var need: float = (ground_here + cruise - _cam_y) * c.camera_settle
	var spd: float = max(forward_speed, 0.5)
	var la: float = max(c.camera_lookahead, 1.0)
	for i in range(1, 9):
		var dist: float = la * float(i) / 8.0
		var h: float = ground_height(scroll_offset + off + travel_dir * dist)
		var t: float = max(dist / spd, 0.3)
		need = max(need, (h + cruise * 0.85 - _cam_y) / t)
	return need


func _update_camera(delta: float) -> void:
	# Slow sideways drift, perpendicular to travel.
	var perp := Vector2(travel_dir.y, -travel_dir.x)
	var drift: float = (sin(_t * 0.11) * 0.6 + sin(_t * 0.047 + 1.3) * 0.4) * c.camera_drift_amount
	var off: Vector2 = perp * drift
	var ground_here: float = ground_height(scroll_offset + off)
	_cam_ground = lerp(_cam_ground, ground_here, clamp(c.camera_follow_speed * delta, 0.0, 1.0))

	# Flight: accelerate toward the needed vertical speed -- up with some
	# authority, down only as fast as moon gravity allows.
	var need: float = _needed_climb_speed(off, ground_here)
	if need > _cam_vy:
		_cam_vy = min(need, _cam_vy + c.camera_climb_accel * delta)
	else:
		_cam_vy = max(need, _cam_vy - c.camera_gravity * delta)
	_cam_vy = clamp(_cam_vy, -c.camera_max_fall_speed, c.camera_max_climb_speed)
	_cam_y += _cam_vy * delta
	# Hard floor: never skim closer than min clearance to the ground below.
	if _cam_y < ground_here + c.camera_min_clearance:
		_cam_y = ground_here + c.camera_min_clearance
		_cam_vy = max(_cam_vy, 0.0)

	var breath: float = (sin(_t * 0.31) * 0.6 + sin(_t * 0.173 + 2.0) * 0.4) * c.camera_float_amount
	var y: float = max(_cam_y + breath, ground_here + c.camera_min_clearance)
	_camera.position = Vector3(off.x, y, off.y)

	# Pitch: base downward gaze + a little of the slope ahead + our climb
	# (look up as we rise to clear a hill, down as we sink after it).
	var base_pitch: float = -atan2(c.camera_look_down, 10.0)
	var ahead: float = (ground_height(scroll_offset + travel_dir * 15.0) + ground_height(scroll_offset + travel_dir * 35.0)) * 0.5
	var slope_pitch: float = atan2(ahead - _cam_ground, 25.0) * c.camera_pitch_follow
	var climb_pitch: float = atan2(_cam_vy, max(forward_speed, 0.5)) * c.camera_climb_look
	var max_p: float = deg_to_rad(c.camera_pitch_max_deg)
	var pitch_target: float = base_pitch + clamp(slope_pitch + climb_pitch, -max_p, max_p)

	# Gaze toward a special prop: eased weight (smoothstep), then an extra
	# low-pass on the resulting yaw so turning toward it and letting go are
	# both slow, lazy arcs.
	_update_interest(delta)
	var w: float = smoothstep(0.0, 1.0, _interest_w)
	var look: float = w * c.camera_interest_strength
	_gaze_yaw = lerp(_gaze_yaw, _interest_yaw * look, clamp(c.camera_gaze_smoothing * delta, 0.0, 1.0))
	pitch_target = lerp(pitch_target, _interest_pitch, look)
	_cam_pitch = lerp(_cam_pitch, pitch_target, clamp(c.camera_pitch_speed * delta, 0.0, 1.0))

	# Roll: bank into turns + idle sway.
	var turn_rate: float = 0.0 if delta <= 0.0 else wrapf(heading - _prev_heading, -PI, PI) / delta
	_prev_heading = heading
	var roll_target: float = -turn_rate * c.camera_bank_amount + deg_to_rad(c.camera_roll_amount) * sin(_t * 0.19 + 0.7)
	_cam_roll = lerp(_cam_roll, roll_target, clamp(1.5 * delta, 0.0, 1.0))

	_camera.rotation = Vector3(_cam_pitch, heading + _gaze_yaw, _cam_roll)
	_camera.fov = c.camera_fov

	for e in _particles:
		e.node.position = Vector3(0.0, y + e.layer.height_offset, 0.0)


## Yaw (relative to the travel heading) toward a camera-relative XZ offset.
func _yaw_to(d: Vector2) -> float:
	return wrapf(atan2(-d.x, -d.y) - heading, -PI, PI)


func _update_interest(delta: float) -> void:
	var max_yaw: float = deg_to_rad(c.camera_interest_max_deg)
	if not _interest.is_empty():
		_interest_elapsed += delta
		var d: Vector2 = _prop_offset(_interest)
		var yaw: float = _yaw_to(d)
		var lost: bool = (_interest.gen != _interest_gen or not _interest.special
			or abs(yaw) > deg_to_rad(c.camera_interest_hold_deg)
			or _interest_elapsed > c.camera_interest_time)
		if lost:
			_interest = {}
			_interest_cool = c.camera_interest_cooldown
		else:
			_interest_yaw = lerp_angle(_interest_yaw, clamp(yaw, -max_yaw, max_yaw), clamp(1.5 * delta, 0.0, 1.0))
			var node: MeshInstance3D = _interest.node
			var pt: float = atan2(node.position.y - _cam_y, max(d.length(), 1.0))
			_interest_pitch = lerp(_interest_pitch, clamp(pt, -0.6, 0.4), clamp(3.0 * delta, 0.0, 1.0))
	else:
		_interest_cool -= delta
		if _interest_cool <= 0.0:
			var best: Dictionary = {}
			var best_along: float = INF
			for p in _props:
				if not p.special or not p.node.visible:
					continue
				var d: Vector2 = _prop_offset(p)
				var along: float = d.dot(travel_dir)
				if along < 8.0 or along > c.camera_interest_range or abs(_yaw_to(d)) > max_yaw:
					continue
				if along < best_along:
					best_along = along
					best = p
			if not best.is_empty():
				_interest = best
				_interest_gen = best.gen
				_interest_elapsed = 0.0
				_interest_pitch = _cam_pitch
	# Ease the gaze toward / away (smoothstep of a linear ramp).
	var want: float = 0.0 if _interest.is_empty() else 1.0
	var rate: float = c.camera_interest_speed * 0.5 if want > _interest_w else c.camera_interest_release_speed
	_interest_w = move_toward(_interest_w, want, rate * delta)
	if _interest.is_empty() and _interest_w <= 0.0 and abs(_gaze_yaw) < 0.01:
		_interest_yaw = 0.0
	_interest_w = clamp(_interest_w, 0.0, 1.0)


func _prop_offset(p: Dictionary) -> Vector2:
	var d: Vector2 = p.world - scroll_offset
	return Vector2(wrapf(d.x, -WRAP_PERIOD * 0.5, WRAP_PERIOD * 0.5), wrapf(d.y, -WRAP_PERIOD * 0.5, WRAP_PERIOD * 0.5))


# ------------------------------------------------------------------------ hud

func _build_hud() -> void:
	var layer := CanvasLayer.new()
	add_child(layer)
	_hud = Label.new()
	_hud.position = Vector2(16, 12)
	_hud.add_theme_font_size_override("font_size", 18)
	_hud.add_theme_color_override("font_color", Color(1, 1, 1))
	_hud.add_theme_color_override("font_outline_color", Color(0, 0, 0))
	_hud.add_theme_constant_override("outline_size", 5)
	_hud.visible = show_hud  # [display] hud in config.cfg; F3 toggles
	layer.add_child(_hud)


func _update_hud(delta: float) -> void:
	_hud_timer -= delta
	if not _hud.visible or _hud_timer > 0.0:
		return
	_hud_timer = 0.1
	var dir: Vector2 = WindInput.current_direction
	var wire := get_viewport().debug_draw == Viewport.DEBUG_DRAW_WIREFRAME
	var n_particles: int = 0
	for e in _particles:
		n_particles += int(e.node.amount * e.node.amount_ratio)
	var preset := _from.resource_path.get_file().get_basename()
	if _transitioning:
		preset += " -> %s  %d%%" % [_to.resource_path.get_file().get_basename(), int(_blend * 100.0)]
	var n_special: int = 0
	for p in _props:
		if p.special:
			n_special += 1
	_hud.text = "\n".join([
		"FPS %d   preset %s   auto %s" % [Engine.get_frames_per_second(), preset, ("every %ds" % int(auto_cycle_seconds)) if _auto_on and auto_cycle_seconds > 0.0 else "off"],
		"wind  %.1f m/s  dir (%.2f, %.2f)" % [WindInput.current_speed, dir.x, dir.y],
		"travel  %.1f m/s  (x%.2f)   heading %d°   %s" % [forward_speed, speed_multiplier, int(fposmod(rad_to_deg(-heading), 360.0)), _steering_text()],
		"camera  %.1f m above ground   pitch %.1f°   watching %s (%d specials around)" % [_cam_y - ground_height(scroll_offset), rad_to_deg(_cam_pitch), "yes" if not _interest.is_empty() else "no", n_special],
		"canyon  walls %+.1f m   %s" % [canyon_walls, ("following, %ds left" % int(_canyon_timer)) if _canyon_following else (("open, next in %ds" % int(_canyon_timer)) if _canyon_timer > 0.0 else "open, watching")],
		"animals  %s" % (_animals.describe() if _animals else "off"),
		"alter  %s" % _alter_text(),
		"particles %d" % n_particles,
		"",
		"F1 wireframe [%s]   F2 grass/flowers [%s]   F3 hud   1-9 / F4 preset   0 auto-cycle" % ["on" if wire else "off", "on" if (_grass_mmi and _grass_mmi.visible) else "off"],
		"F fullscreen   F5 steering source   SPACE spawn animal   drag: heading   wheel: speed   +/- wind speed   arrows/WASD wind direction",
	])


## "off" / "76%   18s left   2 vent(s) erupting" / "healing 40% ...".
func _alter_text() -> String:
	if alter_amount <= 0.001 and _alter_left <= 0.0:
		return "off"
	var blown := 0
	for v in _vents:
		if v.blown:
			blown += 1
	if _alter_left <= 0.0:
		return "healing %d%%   %d vent(s) draining" % [int(alter_amount * 100.0), blown]
	return "%d%%   %ds left   %d vent(s) erupting" % [
			int(alter_amount * 100.0), int(_alter_left), blown]


## "steering mqtt" / "steering mqtt (auto offline)".
func _steering_text() -> String:
	return "steering " + Pilot.active_source_name()


## IDENTIFY: the ESP32s blink their LED. A screen can do better -- name itself,
## big, in the middle, for however long the brain asked.
func _on_identify(duration: float) -> void:
	if _ident == null:
		_ident = Label.new()
		_ident.add_theme_font_size_override("font_size", 64)
		_ident.add_theme_color_override("font_outline_color", Color(0, 0, 0))
		_ident.add_theme_constant_override("outline_size", 12)
		_ident.set_anchors_preset(Control.PRESET_CENTER)
		_ident.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		_ident.grow_horizontal = Control.GROW_DIRECTION_BOTH
		_ident.grow_vertical = Control.GROW_DIRECTION_BOTH
		_hud.get_parent().add_child(_ident)
	_ident.text = "%s
%s / %s" % [Device.device_name, Device.zone, Device.device_id]
	_ident.visible = true
	_ident_left = maxf(duration, 0.5)
	print("[device] IDENTIFY for %.1fs" % _ident_left)


## The capabilities we announce, beyond IDENTIFY. Keep SUBSCRIBES in
## scripts/mqtt_device.gd in step with what is actually handled here.
func _on_device_command(capability: String, params: Dictionary) -> void:
	match capability:
		"PRESET":
			# {"n": 3} or {"name": "3_estepa"}
			if params.has("n"):
				start_transition(preset_for_number(int(params["n"])))
			elif params.has("name"):
				start_transition(CONFIG_DIR + str(params["name"]) + ".tres")
		"PILOT":
			# {"source": "mqtt" | "auto" | "mouse" | "serial"}
			var want := str(params.get("source", "")).to_upper()
			var names := PilotConfig.Source.keys()
			if want in names:
				Pilot.set_source(names.find(want))
			else:
				print("[device] PILOT: unknown source ", want, " -- have ", names)
		"ALTER":
			# {"duration": 10000} -- milliseconds, as the firmware uses.
			alter(float(params.get("duration", 10000)) / 1000.0)
		"DISPLAY":
			# {"hud": true, "primitives": false, "fullscreen": true} -- any of
			# them, in any combination.
			if params.has("hud"):
				set_hud(bool(params["hud"]))
			if params.has("primitives"):
				set_primitives(bool(params["primitives"]))
			if params.has("fullscreen"):
				set_fullscreen(bool(params["fullscreen"]))
				print("[display] fullscreen ", "on" if is_fullscreen() else "off")
		"WIND":
			# {"gain": 2.5} scales every reading before it drives anything, for
			# when real wind is too sedate to watch. Independent of the
			# speed/direction override below, which fakes a reading outright.
			if params.has("gain"):
				Pilot.config.mqtt_speed_per_ms = maxf(float(params["gain"]), 0.0)
				print("[wind] gain x%.2f" % Pilot.config.mqtt_speed_per_ms)
			if not (params.has("speed") or params.has("direction")):
				return
			# {"speed": 6.5, "direction": 225} -- the dashboard sliders.
			WindInput.set_wind(
					float(params.get("speed", WindInput.current_speed)),
					float(params.get("direction", rad_to_deg(WindInput.current_direction.angle()))))
		"SPAWN":
			# {"species": "zorro"} or {} for whatever turns up. Same thing the
			# spacebar does, so the dashboard can put an animal in front of you
			# from the other side of the gallery.
			if _animals:
				_animals.spawn_now(str(params.get("species", "")))


## A dashboard cannot offer a preset or a species it has never heard of, so we
## advertise both in the announce and it builds its controls from that. Same
## trick the polargraph uses to publish its geometry.
func _on_collect_announce(into: Dictionary) -> void:
	var names: PackedStringArray = []
	for path in list_presets():
		names.append(path.get_file().get_basename())
	into["presets"] = names
	var species: PackedStringArray = []
	for a in animals:
		if a != null:
			species.append(a.species_name)
	into["species"] = species


## What this device reports on installation/<zone>/<id>/telemetry, once a
## second, same as any sensor on the bus.
func _on_collect_telemetry(into: Dictionary) -> void:
	into["speed"] = snappedf(forward_speed, 0.01)
	into["heading"] = int(fposmod(rad_to_deg(-heading), 360.0))
	into["preset"] = _from.resource_path.get_file().get_basename()
	into["pilot"] = Pilot.source_name()
	into["pilot_active"] = Pilot.active_source_id()
	into["hud"] = show_hud
	into["primitives"] = show_primitives
	into["grass"] = show_grass
	into["fullscreen"] = is_fullscreen()
	into["alter"] = snappedf(alter_amount, 0.01)
	into["wind"] = snappedf(WindInput.current_speed, 0.01)
	into["wind_dir"] = int(fposmod(rad_to_deg(WindInput.current_direction.angle()), 360.0))
	into["wind_gain"] = snappedf(Pilot.config.mqtt_speed_per_ms, 0.01)
	into["wind_steady"] = snappedf(WindInput.tendency_steadiness, 0.01)
	if _animals:
		into["animals"] = _animals.alive_count()


func _on_wind_changed(_speed: float, _direction: Vector2) -> void:
	pass # world reacts every _process(); signal kept for UI/debug hookups
