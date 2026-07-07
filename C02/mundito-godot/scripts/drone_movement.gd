# drone_movement.gd
extends Camera3D

@export var move_speed: float = 500.0
@export var look_speed: float = 2.0

@export var rotation_smoothness: float = 0.5
@export var acceleration_smoothness: float = 3.0

# Interpolation targets set by MQTT
var desired_yaw_rad: float = 0.0
var desired_speed: float = 0.0
var current_speed: float = 0.0

func _ready():
	# Initialize the target angle to our starting editor rotation
	desired_yaw_rad = global_rotation.y

# --- THE RECEIVER FUNCTION FOR MQTT ---
func drive_to_target(target_yaw_degrees: float, target_speed_scale: float):
	# 1. Convert incoming 0-360 yaw map to engine radians
	desired_yaw_rad = deg_to_rad(target_yaw_degrees)
	
	# 2. Map the 1-100 country speed scale to your move_speed limits
	desired_speed = remap(clamp(target_speed_scale, 0.0, 100.0), 0.0, 100.0, 0.0, move_speed)

func _process(delta):
	# 1. TRANSLATION FLIGHT MOVEMENT (WASD + ZC)
	var input_vector = Vector3.ZERO
	if Input.is_key_pressed(KEY_W): input_vector.z -= 1 # Local Forward
	if Input.is_key_pressed(KEY_S): input_vector.z += 1 # Local Backward
	if Input.is_key_pressed(KEY_A): input_vector.x -= 1 # Local Left
	if Input.is_key_pressed(KEY_D): input_vector.x += 1 # Local Right
	if Input.is_key_pressed(KEY_C): input_vector.y += 1 # Global Up
	if Input.is_key_pressed(KEY_Z): input_vector.y -= 1 # Global Down
	
	# Extract facing targets directly from local transform vectors
	var forward_dir = global_transform.basis.z
	var right_dir = global_transform.basis.x
	
	# Check if player is giving manual keyboard input
	var has_manual_input = input_vector != Vector3.ZERO
	
	if has_manual_input:
		# --- MANUAL KEYBOARD FLIGHT MODE ---
		var horizontal_movement = (right_dir * input_vector.x) + (forward_dir * input_vector.z)
		horizontal_movement.y = 0
		horizontal_movement = horizontal_movement.normalized()
		
		var final_velocity = horizontal_movement + (Vector3.UP * input_vector.y)
		global_position += final_velocity * move_speed * delta
		
		# Reset automated speeds so the drone doesn't zoom off when keys are released
		desired_speed = 0.0
		current_speed = 0.0
		desired_yaw_rad = global_rotation.y
	else:
		# --- AUTOMATED MQTT DATA FLIGHT MODE ---
		# Smoothly interpolate the looking heading angle using lerp_angle
		global_rotation.y = lerp_angle(global_rotation.y, desired_yaw_rad, rotation_smoothness * delta)
		
		# Smoothly ramp speed up/down
		current_speed = lerp(current_speed, desired_speed, acceleration_smoothness * delta)
		
		# Move forward along our horizontal face vector direction
		var auto_forward = -global_transform.basis.z
		auto_forward.y = 0
		auto_forward = auto_forward.normalized()
		
		global_position += auto_forward * current_speed * delta

	# 2. YAW & PITCH LOOK ROTATION (MANUAL OVERRIDES)
	if Input.is_key_pressed(KEY_Q) or Input.is_key_pressed(KEY_LEFT): 
		rotate_y(look_speed * delta)
		desired_yaw_rad = global_rotation.y
	if Input.is_key_pressed(KEY_E) or Input.is_key_pressed(KEY_RIGHT): 
		rotate_y(-look_speed * delta)
		desired_yaw_rad = global_rotation.y
		
	if Input.is_key_pressed(KEY_UP):
		rotate_object_local(Vector3.RIGHT, look_speed * delta)
	if Input.is_key_pressed(KEY_DOWN):
		rotate_object_local(Vector3.RIGHT, -look_speed * delta)
		
	rotation.x = clamp(rotation.x, deg_to_rad(-85), deg_to_rad(85))
	rotation.z = 0
