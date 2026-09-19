class_name WorldConfig
extends Resource
## A complete look for the world: terrain, vegetation, props, sky, particles,
## travel and camera. Presets live in res://configs/ as .tres files; assign
## one to the World node's `config`, or press F4 while running to cycle them.
##
## The defaults below are the original "meadow" look.

@export_group("Terrain shape")
@export var terrain_size: float = 320.0
@export var terrain_subdivisions: int = 240
@export var hill_scale: float = 0.035
@export var hill_height: float = 4.5
@export var mountain_scale: float = 0.012
@export var mountain_height: float = 14.0
@export var warp_strength: float = 25.0 ## meters; bends the hills out of their grid
@export var terrace_step: float = 2.5 ## meters between terrace shelves
@export_range(0.0, 1.0) var terrace_strength: float = 0.0 ## 0 = smooth, 1 = hard mesas

@export_group("Terrain colors")
@export var color_low: Color = Color(0.11, 0.28, 0.14)
@export var color_high: Color = Color(0.55, 0.75, 0.35)
@export var color_rock: Color = Color(0.42, 0.38, 0.33)
@export var color_peak: Color = Color(0.88, 0.88, 0.84)

@export_group("Terrain glow")
## Glowing lines drawn into the ground (neon looks). Black = off. Colors are
## linear light and can go above 1.0 to bloom.
@export var terrain_grid_color: Color = Color(0, 0, 0) ## world-space grid that scrolls with the land
@export var terrain_grid_spacing: float = 8.0 ## meters between grid lines
@export var terrain_grid_width: float = 0.04 ## line width, fraction of a cell
@export var terrain_contour_color: Color = Color(0, 0, 0) ## height contour lines
@export var terrain_contour_step: float = 2.0 ## meters between contours
@export var terrain_contour_width: float = 0.05
@export_range(0.0, 1.0) var terrain_line_pulse: float = 0.0 ## a slow wave of brightness running over the lines

@export_group("Grass")
@export var field_tile_size: float = 90.0 ## grass/flower recycle square
@export var grass_count: int = 14000
@export var grass_height_min: float = 0.28
@export var grass_height_max: float = 0.6
@export var grass_color_base: Color = Color(0.09, 0.24, 0.10)
@export var grass_color_tip: Color = Color(0.42, 0.62, 0.22)
@export var grass_bend_strength: float = 0.9
@export var grass_tip_emission: Color = Color(0, 0, 0) ## glow at the blade tips (black = off)

@export_group("Flowers")
@export var flower_count: int = 700
@export var flower_scale_min: float = 0.8
@export var flower_scale_max: float = 1.4
## Each flower picks one of these, with a little hue/saturation jitter.
@export var flower_colors: PackedColorArray = PackedColorArray([
	Color.from_hsv(0.02, 0.7, 1.0), Color.from_hsv(0.08, 0.7, 1.0),
	Color.from_hsv(0.13, 0.7, 1.0), Color.from_hsv(0.55, 0.7, 1.0),
	Color.from_hsv(0.62, 0.7, 1.0), Color.from_hsv(0.85, 0.7, 1.0),
	Color.from_hsv(0.95, 0.7, 1.0),
])
@export var flower_bend_strength: float = 0.5
@export var flower_emission_energy: float = 0.0 ## flowers glow in their own color

@export_group("Props")
@export var prop_count: int = 70
@export var prop_tile_size: float = 200.0 ## props recycle within this square around the camera
@export var prop_clear_path: float = 4.0 ## keep this many meters either side of the lane ahead empty
## Any of: box, sphere, cylinder, prism, torus, capsule, cone -- or the
## Patagonian steppe plants: zampa, jarilla, alpataco, coiron (see
## plant_meshes.gd). Repeat a name to make it more common (plants also get a
## different variant for each repeat). Plants keep their own colors, tinted by
## plant_tint (see below).
@export var prop_shapes: PackedStringArray = PackedStringArray(["box", "sphere", "cylinder", "prism", "torus", "capsule", "cone"])
@export var prop_colors: PackedColorArray = PackedColorArray([
	Color.from_hsv(0.0, 0.45, 0.95), Color.from_hsv(0.07, 0.45, 0.95),
	Color.from_hsv(0.13, 0.45, 0.95), Color.from_hsv(0.5, 0.45, 0.95),
	Color.from_hsv(0.58, 0.45, 0.95), Color.from_hsv(0.75, 0.45, 0.95),
	Color.from_hsv(0.9, 0.45, 0.95), Color(0.95, 0.94, 0.9),
])
@export var prop_roughness: float = 0.7
@export var prop_emission_energy: float = 0.0 ## primitives glow in their prop_color
@export var prop_size_min: float = 0.6
@export var prop_size_max: float = 2.0
@export_range(0.0, 1.0) var prop_landmark_chance: float = 0.15 ## chance of a big one
@export var prop_landmark_size_min: float = 3.0
@export var prop_landmark_size_max: float = 7.0
@export var prop_stretch_min: float = 1.0 ## extra vertical scale (towers, pillars)
@export var prop_stretch_max: float = 1.0
@export var prop_tilt_max_deg: float = 0.0 ## random lean
@export_range(0.0, 1.0) var prop_sink: float = 0.1 ## fraction of the height buried
## Plants (zampa, jarilla, alpataco, coiron) ignore prop_colors / landmark /
## stretch / sink and use these instead, so they keep natural colors and sizes.
@export var plant_tint: Color = Color(1, 1, 1) ## multiplies the plants' own colors (e.g. dry/dead look)
@export var plant_size_min: float = 0.75
@export var plant_size_max: float = 1.3

@export_group("Special props")
## Chance that a recycled prop comes back as a "special" one: it glows,
## hovers, spins, and the camera turns its gaze to watch it for a while.
@export_range(0.0, 1.0) var special_chance: float = 0.04
@export var special_shapes: PackedStringArray = PackedStringArray(["torus", "sphere", "prism"])
@export var special_albedo: Color = Color(1.0, 0.95, 0.85)
@export var special_emission: Color = Color(1.0, 0.8, 0.45) ## glow color
@export var special_emission_energy: float = 2.5
@export var special_size_min: float = 1.2
@export var special_size_max: float = 2.5
@export var special_stretch: float = 1.0 ## vertical scale (tall monoliths > 1)
@export var special_hover_height: float = 1.5 ## meters above the ground
@export var special_hover_amplitude: float = 0.4 ## slow up/down bob
@export var special_spin_deg: float = 20.0 ## degrees per second
@export var special_light_energy: float = 1.5 ## small light cast on the ground around it
@export var special_light_range: float = 9.0

@export_group("Sky and light")
@export var sky_top_calm: Color = Color(0.28, 0.5, 0.85)
@export var sky_top_windy: Color = Color(0.16, 0.32, 0.62)
@export var sky_horizon_calm: Color = Color(0.75, 0.82, 0.85)
@export var sky_horizon_windy: Color = Color(0.85, 0.86, 0.8)
@export var fog_color: Color = Color(0.8, 0.85, 0.85)
@export var fog_density_calm: float = 0.006
@export var fog_density_windy: float = 0.014
@export var sun_color: Color = Color(1.0, 0.97, 0.9)
@export var sun_energy_calm: float = 1.15
@export var sun_energy_windy: float = 0.9
@export var sun_rotation_deg: Vector3 = Vector3(-48, -35, 0)
@export var glow_intensity: float = 0.35
@export var glow_bloom: float = 0.05 ## how much everything (not just bright bits) blooms

@export_group("Particles")
@export var particle_layers: Array[ParticleLayer] = []

@export_group("Travel")
@export var forward_speed_base: float = 1.5 ## m/s of travel even with no wind
@export var scroll_speed_scale: float = 1.0 ## extra m/s of travel per m/s of wind

@export_group("Camera")
@export var camera_height: float = 3.5 ## meters above the (smoothed) ground
@export var camera_min_clearance: float = 1.2 ## never closer than this to the ground right below
@export var camera_lookahead: float = 60.0 ## meters of terrain ahead the glide anticipates
@export var camera_follow_speed: float = 0.8 ## how quickly the slope reference for pitch follows the ground

@export_group("Camera flight")
## Vertical motion is a little flight model: it sees terrain coming up to
## camera_lookahead meters ahead and climbs early enough to clear it; going
## down it's only pulled by a weak, moon-like gravity, so it floats over dips
## and past crests.
@export var camera_gravity: float = 1.2 ## m/s^2 pulling down (the Moon is 1.6)
@export var camera_climb_accel: float = 2.5 ## m/s^2 available to climb
@export var camera_max_climb_speed: float = 6.0 ## m/s
@export var camera_max_fall_speed: float = 2.5 ## m/s
@export var camera_settle: float = 0.4 ## how eagerly it returns to cruise height (1/s)
@export var camera_climb_look: float = 0.6 ## how much climbing/sinking tilts the gaze up/down
@export var camera_look_down: float = 1.0 ## meters the gaze drops over 10 m ahead
@export var camera_fov: float = 65.0

@export_group("Camera float")
@export var camera_float_amount: float = 0.35 ## meters of slow vertical breathing
@export var camera_drift_amount: float = 1.2 ## meters of slow sideways drift
@export var camera_roll_amount: float = 1.5 ## degrees of idle roll sway
@export var camera_bank_amount: float = 0.35 ## roll into turns
@export var camera_speed_smoothing: float = 0.6 ## lower = gusts ease in more gently

@export_group("Camera pitch")
@export var camera_pitch_follow: float = 0.45 ## 0 = level gaze, 1 = look straight along the slope
@export var camera_pitch_max_deg: float = 9.0 ## cap on terrain pitch, up or down
@export var camera_pitch_speed: float = 1.2 ## how quickly pitch adjusts

@export_group("Camera interest")
## How much the gaze turns toward a special prop (0 = ignore, 1 = look right at it).
@export_range(0.0, 1.0) var camera_interest_strength: float = 0.7
@export var camera_interest_max_deg: float = 60.0 ## never turn the gaze further than this
@export var camera_interest_range: float = 130.0 ## start noticing specials this far ahead
@export var camera_interest_time: float = 14.0 ## max seconds watching one prop
@export var camera_interest_hold_deg: float = 115.0 ## keep watching until it is this far off our heading (behind us)
@export var camera_interest_cooldown: float = 4.0 ## seconds before noticing the next one
@export var camera_interest_speed: float = 0.7 ## how quickly the gaze turns toward it
@export var camera_interest_release_speed: float = 0.2 ## how slowly the gaze lets go (lower = lazier)
@export var camera_gaze_smoothing: float = 0.8 ## extra easing on the gaze turn (lower = smoother)

@export_group("Transition")
## Seconds to blend INTO this preset from the current one (no hard cut).
@export var transition_time: float = 25.0
