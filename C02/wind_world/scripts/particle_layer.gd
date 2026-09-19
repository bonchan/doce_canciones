class_name ParticleLayer
extends Resource
## One layer of airborne particles (petals, ash, dust, embers...).
## The emitter follows the camera; particles drift with the wind plus the
## travel speed, so they stream past as we move.

@export var amount: int = 180
@export var lifetime: float = 9.0
@export var size: float = 0.06 ## quad size in meters
@export var scale_min: float = 0.6
@export var scale_max: float = 1.4
## Color over life. Alpha fades in/out at the ends automatically.
## Values above 1.0 glow (the environment has glow on).
@export var color_start: Color = Color(1.0, 0.85, 0.9, 0.9)
@export var color_end: Color = Color(1.0, 0.8, 0.85, 0.9)
@export var area: Vector3 = Vector3(45.0, 3.0, 45.0) ## emission box half-extents
@export var height_offset: float = -0.4 ## emitter center relative to the camera
@export var gravity: float = -0.15 ## negative falls, positive rises
@export var wind_follow: float = 1.0 ## how strongly wind + travel push the particles
@export var angular_velocity: float = 60.0 ## max spin, degrees/second
