class_name AnimalConfig
extends Resource
## One species living on the land: which model, which clips, how it moves and
## how it behaves. Everything here is per-species, so adding a guanaco later is
## a new .tres and a line in the World node's `animals` array -- no code.
##
## Presets live in res://animals/.

@export var species_name: String = "fox"
@export var model: PackedScene

@export_group("Animations")
## Clip names exactly as they appear in the imported AnimationPlayer. Anything
## left empty is simply never played, so a model missing a clip still works.
## Several idles get picked between, which is most of what stops a standing
## animal looking like a statue.
@export var anim_idle: PackedStringArray = PackedStringArray(["Idle", "Idle_2", "Idle_2_HeadLow"])
@export var anim_eat: String = "Eating"
@export var anim_walk: String = "Walk"
@export var anim_run: String = "Gallop"
@export var anim_jump: String = "Gallop_Jump"
## Played once on dropping out of a run, so it doesn't stop dead.
## NOTE the capital T: the canines in this pack spell it Jump_ToIdle and the
## hoofed animals spell it Jump_toIdle. Same for Idle_2_HeadLow vs Idle_Headlow.
@export var anim_land: String = "Jump_ToIdle"
## Head up, alert -- what it holds while watching you go past. Falls back to
## the first idle if empty. For grazers pick the plain Idle, not the head-low
## one, or they "watch" you with their nose in the grass.
@export var anim_watch: String = ""
@export var anim_blend: float = 0.2 ## seconds of crossfade between clips

@export_group("Size")
## The Quaternius fox is ~5.9 m nose to tail in its own units, so ~0.18 gives
## a real zorro gris of about a meter.
@export var scale_min: float = 0.165
@export var scale_max: float = 0.20
## Set to 180 if it runs backwards -- glTF models don't agree on which way is
## forward, and this is quicker than re-exporting.
@export var model_yaw_offset_deg: float = 0.0

@export_group("Movement")
@export var walk_speed: float = 1.5 ## m/s
@export var run_speed: float = 8.0 ## m/s
@export var accel: float = 6.0 ## m/s^2, how fast it reaches its gait speed
@export var turn_rate_deg: float = 170.0 ## degrees/s it can swing its heading
## Playback multipliers, for matching foot speed to ground speed. Raise if the
## feet skate, lower if they scrub.
@export var walk_anim_speed: float = 1.0
@export var run_anim_speed: float = 1.0

@export_group("Behaviour")
@export var idle_time: Vector2 = Vector2(2.0, 6.0) ## seconds, min/max
@export var eat_time: Vector2 = Vector2(3.0, 8.0)
@export var walk_time: Vector2 = Vector2(4.0, 13.0)
@export var run_time: Vector2 = Vector2(2.0, 5.0)
## Weights for what it does next when it is calm: walking, eating, standing,
## breaking into a run. They don't have to add up to anything.
@export var want_walk: float = 36.0
@export var want_eat: float = 24.0
@export var want_idle: float = 26.0
@export var want_run: float = 14.0
## Chance per second, while running, of clearing something.
@export_range(0.0, 1.0) var jump_chance: float = 0.3
## Chance, on starting a walk, of heading toward another animal instead of
## wandering. This is all the "interaction" there is, and it is enough.
@export_range(0.0, 1.0) var social_chance: float = 0.35
@export var social_range: float = 70.0 ## won't notice one further than this
@export var social_personal_space: float = 4.5 ## stops approaching this close

@export_group("Shyness")
## Wild animals don't let you walk up to them. Inside this range it bolts, and
## keeps bolting until it is flee_release times this distance away.
## 0 = never runs from you. Livestock should be 0.
@export var flee_distance: float = 30.0
@export var flee_release: float = 2.2
@export var flee_speed_boost: float = 1.15

@export_group("Curiosity")
## The opposite temperament. A cow doesn't run from you -- it stops chewing,
## lifts its head and turns to watch you go by, then goes back to the grass.
## Inside this range it does that. 0 = never; it ignores you completely.
## If flee_distance is also set, bolting wins.
@export var watch_distance: float = 0.0
## Deliberately slower than turn_rate_deg. Cattle swing round to look at you;
## they don't snap to it.
@export var watch_turn_rate_deg: float = 40.0

@export_group("Population")
@export var max_alive: int = 2
@export var spawn_interval: Vector2 = Vector2(10.0, 35.0) ## seconds between attempts
## Spawned ahead and off to one side, in this angle band off the travel
## direction, so they walk into frame rather than popping into the middle of it.
@export var spawn_angle_deg: Vector2 = Vector2(18.0, 78.0)
@export var spawn_distance: Vector2 = Vector2(55.0, 100.0)
@export var despawn_distance: float = 170.0 ## gone once this far off
@export var despawn_behind: float = 45.0 ## or this far back past the camera

@export_group("Look")
## Material name -> new albedo. The Quaternius fox has five: Main (the coat),
## Main_Light, Black, Grey and Eyes. Only the ones named here are touched.
@export var recolor: Dictionary = {}
## Per-individual variation on the recolored parts, so two foxes on screen
## aren't the same fox twice.
@export_range(0.0, 0.5) var coat_jitter: float = 0.07
