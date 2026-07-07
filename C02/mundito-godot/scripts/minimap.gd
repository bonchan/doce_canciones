# minimap.gd
extends Camera3D

@export var drone_camera_path: NodePath = "../../../../Camera3D"
var drone_camera: Camera3D

# Dropped down slightly so it's below the default far clipping plane limit
const MAP_HEIGHT: float = 1000.0 

func _ready():
	if has_node(drone_camera_path):
		drone_camera = get_node(drone_camera_path)
		
	projection = Camera3D.PROJECTION_ORTHOGONAL
	
	# Set safe rendering ranges so meshes don't clip out
	near = 0.1
	far = 4000.0
	
	# Zoom mapping scale: Shows a 4km x 4km sector area around the drone
	size = 4000.0 
	
	# Explicitly lock your manual editor fix directly into the code rotation matrix
	rotation_degrees = Vector3(-90, 0, 0)

func _process(_delta):
	if not is_instance_valid(drone_camera):
		drone_camera = get_node(drone_camera_path)
		return
	
	var drone_pos = drone_camera.global_position
	var drone_rot = drone_camera.global_rotation
	
	# Move seamlessly along the X and Z planes exactly alongside the drone,
	# while remaining floating directly above it.
	#global_position = Vector3(drone_pos.x, drone_pos.y + MAP_HEIGHT, drone_pos.z)
	global_position = Vector3(drone_pos.x, MAP_HEIGHT, drone_pos.z)
	global_rotation = Vector3(-90, drone_rot.y, 0)
	
