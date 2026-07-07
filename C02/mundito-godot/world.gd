# world.gd
extends Node3D

@onready var camera = $Camera3D
@onready var terrain_container = $TerrainContainer

# --- GLOBAL DYNAMIC START POINT SETUP ---
@export_category("Coordinates Origin Target")
@export var START_LAT: float = -38.9516  # Default: Neuquén, Argentina
@export var START_LON: float = -68.0591  # Default: Neuquén, Argentina
@export var debug_mode: bool = true

# Core calculated reference points (computed inside _ready)
var z11_start_x: int = 624
var z11_start_y: int = 964

var show_low_res: bool = true
var show_high_res: bool = true

var _debug_line_mesh: CylinderMesh

# --- DISTANCE LIMITS ---
const Z11_SIZE: float = 2000.0           
const HQ_NEAR_CIRCLE: float = 6000.0       

const Z8_SIZE: float = 16000.0  
const LQ_FAR_CIRCLE: float = 40000.0       
const MEMORY_LIMIT_DISTANCE: float = 95000.0 

var z8_center_x: int = 78
var z8_center_y: int = 120

var loaded_tiles: Dictionary = {} 
var requested_tiles: Dictionary = {}
var debug_mesh_instance: MeshInstance3D

# How many of the closest z11 tiles get flagged "urgent" (jump the queue)
# on the very first scan, so something is on screen immediately at startup.
const STARTUP_URGENT_COUNT := 4
var _did_startup_burst := false

# Throttle the memory-limit sweep instead of running it every single frame.
var _memory_check_accum := 0.0
const MEMORY_CHECK_INTERVAL := 1.0

# Throttle how often we prune the stale part of the load queue -- doesn't
# need to be every frame, but needs to be often enough to keep the queue
# from ballooning while flying fast in one direction.
var _queue_prune_accum := 0.0
const QUEUE_PRUNE_INTERVAL := 0.3
# Small margin over the actual selection circles so we don't cancel a tile
# the exact same frame it'd otherwise get re-requested.
const QUEUE_PRUNE_MARGIN := 1.15

func _ready():
	TerrainService.tile_ready.connect(_on_service_instanced_tile)
	TerrainService.tile_cancelled.connect(_on_service_cancelled_tile)
	
	# Calculate structural Web Mercator grid numbers dynamically
	calculate_start_tiles_from_coords()
	
	debug_mesh_instance = MeshInstance3D.new()
	var mat = ORMMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.vertex_color_use_as_albedo = true
	debug_mesh_instance.material_override = mat
	add_child(debug_mesh_instance)
	
	# Shared unit-height cylinder reused (via per-instance scale.y) as the
	# vertical status pole above every tile -- built once here, never per-tile.
	_debug_line_mesh = CylinderMesh.new()
	_debug_line_mesh.top_radius = 3.0
	_debug_line_mesh.bottom_radius = 3.0
	_debug_line_mesh.height = 1.0
	
	recalculate_tile_anchors()
	scan_and_request_tiles()

func calculate_start_tiles_from_coords():
	var n = pow(2.0, 11.0) # Zoom level 11 multiplier mapping matrix bounds
	
	# 1. Longitude calculation
	z11_start_x = int(floori((START_LON + 180.0) / 360.0 * n))
	
	# 2. Latitude calculation (Web Mercator projection formula)
	var lat_rad = deg_to_rad(START_LAT)
	z11_start_y = int(floori((1.0 - log(tan(lat_rad) + (1.0 / cos(lat_rad))) / PI) / 2.0 * n))
	
	print("Dynamic Origin Settled. Initializing World at Z11 Master Tile Coordinates -> X: ", z11_start_x, " | Y: ", z11_start_y)

func _input(_event):
	if Input.is_key_pressed(KEY_1) and Engine.get_frames_drawn() % 10 == 0:
		show_low_res = not show_low_res
		update_layer_visibilities()
	if Input.is_key_pressed(KEY_2) and Engine.get_frames_drawn() % 10 == 0:
		show_high_res = not show_high_res
		update_layer_visibilities()
	if Input.is_key_pressed(KEY_3) and Engine.get_frames_drawn() % 10 == 0:
		debug_mode = not debug_mode
		update_layer_visibilities()

func _process(delta):
	var cam_pos = camera.global_position

	# Keep the load queue re-sorted toward wherever the camera is currently
	# pointed, every frame -- this is what makes tiles ahead of you load
	# before tiles behind you.
	TerrainService.update_view(cam_pos, -camera.global_transform.basis.z)

	var z11_current_x = z11_start_x + floori((cam_pos.x / Z11_SIZE))
	var z11_current_y = z11_start_y + floori((cam_pos.z / Z11_SIZE))
	var active_z8_x = floori(float(z11_current_x) / 8.0)
	var active_z8_y = floori(float(z11_current_y) / 8.0)

	if active_z8_x != z8_center_x or active_z8_y != z8_center_y:
		z8_center_x = active_z8_x
		z8_center_y = active_z8_y
		scan_and_request_tiles()

	manage_dynamic_lod_and_offloading(cam_pos)
	if debug_mode:
		draw_debug_distance_circles(cam_pos)

	_memory_check_accum += delta
	if _memory_check_accum >= MEMORY_CHECK_INTERVAL:
		_memory_check_accum = 0.0
		evaluate_memory_limits()

	_queue_prune_accum += delta
	if _queue_prune_accum >= QUEUE_PRUNE_INTERVAL:
		_queue_prune_accum = 0.0
		TerrainService.prune_stale_queue(
			cam_pos,
			HQ_NEAR_CIRCLE * QUEUE_PRUNE_MARGIN,
			LQ_FAR_CIRCLE * QUEUE_PRUNE_MARGIN
		)

# Helper function to check if a circle intersects a square tile chunk
func is_circle_touching_tile(circle_center: Vector3, radius: float, tile_min_x: float, tile_min_z: float, tile_size: float) -> bool:
	var closest_x = clamp(circle_center.x, tile_min_x, tile_min_x + tile_size)
	var closest_z = clamp(circle_center.z, tile_min_z, tile_min_z + tile_size)
	
	var dx = circle_center.x - closest_x
	var dz = circle_center.z - closest_z
	var distance_squared = (dx * dx) + (dz * dz)
	
	return distance_squared <= (radius * radius)

func scan_and_request_tiles():
	var cam_pos = camera.global_position
	var cam_forward = -camera.global_transform.basis.z
	cam_forward.y = 0
	cam_forward = cam_forward.normalized()
	
	var z11_center_x = z11_start_x + floori((cam_pos.x / Z11_SIZE))
	var z11_center_y = z11_start_y + floori((cam_pos.z / Z11_SIZE))
	
	z8_center_x = floori(float(z11_center_x) / 8.0)
	z8_center_y = floori(float(z11_center_y) / 8.0)

	# --- SCAN LAYER 1: Zoom 8 Flat Horizon Chunks ---
	var z8_range = int(ceil(LQ_FAR_CIRCLE / Z8_SIZE))
	for dy in range(-z8_range, z8_range + 1):
		for dx in range(-z8_range, z8_range + 1):
			var tx = z8_center_x + dx
			var ty = z8_center_y + dy
			var tile_key = "z8_%d_%d" % [tx, ty]
			
			if loaded_tiles.has(tile_key) or requested_tiles.has(tile_key): continue
			
			# Locked Unified Origin Offset Calculation
			var ox = (tx * 8 - z11_start_x) * Z11_SIZE
			var oz = (ty * 8 - z11_start_y) * Z11_SIZE
			var tile_center = Vector3(ox + (Z8_SIZE / 2.0), 0, oz + (Z8_SIZE / 2.0))
			
			if cam_pos.distance_to(tile_center) <= LQ_FAR_CIRCLE:
				requested_tiles[tile_key] = true
				TerrainService.request_tile({"z": 8, "x": tx, "y": ty, "key": tile_key, "offset_x": ox, "offset_z": oz, "scale_size": Z8_SIZE, "is_flat": true, "queue_idx": -1, "world_center": tile_center})

	# --- SCAN LAYER 2: Zoom 11 Core 3D Mesh ---
	var z11_candidates = []
	var z11_range = int(ceil(HQ_NEAR_CIRCLE / Z11_SIZE))
	
	for dy in range(-z11_range, z11_range + 1):
		for dx in range(-z11_range, z11_range + 1):
			var tx = z11_center_x + dx
			var ty = z11_center_y + dy
			var tile_key = "z11_%d_%d" % [tx, ty]
			
			if loaded_tiles.has(tile_key) or requested_tiles.has(tile_key): continue
			
			var ox = (tx - z11_start_x) * Z11_SIZE
			var oz = (ty - z11_start_y) * Z11_SIZE
			var tile_center = Vector3(ox + (Z11_SIZE / 2.0), 0, oz + (Z11_SIZE / 2.0))
			var dist_to_center = cam_pos.distance_to(tile_center)
			
			if is_circle_touching_tile(cam_pos, HQ_NEAR_CIRCLE, ox, oz, Z11_SIZE):
				var to_tile_vector = (tile_center - cam_pos).normalized()
				var dot_product = cam_forward.dot(to_tile_vector)
				
				if dot_product >= 0.0 or (abs(dx) <= 1 and abs(dy) <= 1):
					z11_candidates.append({
						"tx": tx, "ty": ty, "key": tile_key, "ox": ox, "oz": oz, 
						"distance": dist_to_center, "world_center": tile_center
					})
				
	z11_candidates.sort_custom(func(a, b): return a["distance"] < b["distance"])
	
	for i in range(z11_candidates.size()):
		var c = z11_candidates[i]
		requested_tiles[c["key"]] = true
		# Only the very first scan (startup) forces the closest few tiles to
		# the front of the queue so the ground appears right away. After
		# that, everything -- including newly-entered chunks as you fly --
		# is left to the normal distance/facing priority queue.
		var urgent = (not _did_startup_burst) and i < STARTUP_URGENT_COUNT
		TerrainService.request_tile({
			"z": 11, "x": c["tx"], "y": c["ty"], "key": c["key"], 
			"offset_x": c["ox"], "offset_z": c["oz"], "scale_size": Z11_SIZE, 
			"is_flat": false, "queue_idx": i, "world_center": c["world_center"]
		}, urgent)
	
	_did_startup_burst = true

func _on_service_instanced_tile(mesh: ArrayMesh, image: Image, task: Dictionary):
	requested_tiles.erase(task["key"])
	if loaded_tiles.has(task["key"]): return
	
	var texture = ImageTexture.create_from_image(image)
	
	
	var mat = ORMMaterial3D.new()
	mat.albedo_texture = texture
	mat.roughness = 1.0
	mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	var mesh_instance = MeshInstance3D.new()
	mesh_instance.mesh = mesh
	mesh_instance.set_surface_override_material(0, mat)
	
	
	#var mat = load("res://shaders/new_shader_material.tres") # Make sure this matches your file path!
	#var unique_mat = mat.duplicate()
	#unique_mat.set_shader_parameter("albedo_texture", texture)
	#var mesh_instance = MeshInstance3D.new()
	#mesh_instance.mesh = mesh
	#mesh_instance.set_surface_override_material(0, unique_mat)
	
	
	var yOffset = 0 if not task["is_flat"] else -10
	mesh_instance.position = Vector3(task["offset_x"], yOffset, task["offset_z"])
	
	var tile_size = task["scale_size"]
	var marker = _build_debug_marker(task, tile_size)
	marker.visible = debug_mode
	mesh_instance.add_child(marker)
	
	if not task["is_flat"]:
		mesh_instance.visible = show_high_res
	else:
		mesh_instance.visible = show_low_res
		
	terrain_container.add_child(mesh_instance)
	loaded_tiles[task["key"]] = mesh_instance

# Builds a status pole + floating label above a tile's center: a colored
# vertical line (green = HQ/z11, orange = LQ/z8) topped with a label showing
# resolution tier, grid coordinates, and (for HQ tiles) load priority order.
func _build_debug_marker(task: Dictionary, tile_size: float) -> Node3D:
	var marker = Node3D.new()
	marker.name = "DebugMarker"
	
	var is_hq = not task["is_flat"]
	var pole_color = Color.LIME_GREEN if is_hq else Color.ORANGE
	var pole_height = 200.0 if is_hq else 600.0
	
	var pole = MeshInstance3D.new()
	pole.mesh = _debug_line_mesh
	var pole_mat = StandardMaterial3D.new()
	pole_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	pole_mat.albedo_color = pole_color
	pole.material_override = pole_mat
	pole.scale = Vector3(1, pole_height, 1)
	pole.position = Vector3(tile_size / 2.0, pole_height / 2.0, tile_size / 2.0)
	marker.add_child(pole)
	
	var label_3d = Label3D.new()
	var tier_line = "HQ (z11)" if is_hq else "LQ (z8)"
	var coord_line = "%d, %d" % [task["x"], task["y"]]
	var extra_line = ("load #%d" % task["queue_idx"]) if is_hq else ""
	label_3d.text = "%s\n%s\n%s" % [tier_line, coord_line, extra_line]
	label_3d.font_size = 50000
	label_3d.modulate = pole_color
	label_3d.outline_modulate = Color.BLACK
	label_3d.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	label_3d.position = Vector3(tile_size / 2.0, pole_height + 30.0, tile_size / 2.0)
	marker.add_child(label_3d)
	
	return marker

func _on_service_cancelled_tile(task: Dictionary):
	# The tile never got a mesh, so nothing to free from the scene -- just
	# forget we requested it, so a future scan can queue it again if the
	# camera swings back this way.
	requested_tiles.erase(task["key"])

func manage_dynamic_lod_and_offloading(cam_pos: Vector3):
	for key in loaded_tiles.keys():
		var node = loaded_tiles[key]
		if not is_instance_valid(node): continue
		
		var ox = node.position.x
		var oz = node.position.z
		
		if key.begins_with("z11_"):
			if not is_circle_touching_tile(cam_pos, HQ_NEAR_CIRCLE, ox, oz, Z11_SIZE):
				node.queue_free()
				loaded_tiles.erase(key)
				scan_and_request_tiles()
				
		elif key.begins_with("z8_"):
			if not is_circle_touching_tile(cam_pos, LQ_FAR_CIRCLE, ox, oz, Z8_SIZE):
				node.queue_free()
				loaded_tiles.erase(key)

func draw_debug_distance_circles(center_pos: Vector3):
	var imm_mesh = ImmediateMesh.new()
	debug_mesh_instance.mesh = imm_mesh
	imm_mesh.surface_begin(Mesh.PRIMITIVE_LINES)
	var points_count = 64
	var step = (PI * 2.0) / points_count
	
	for i in range(points_count):
		var theta1 = i * step
		var theta2 = (i + 1) * step
		
		imm_mesh.surface_set_color(Color.GREEN)
		imm_mesh.surface_add_vertex(Vector3(center_pos.x + cos(theta1) * HQ_NEAR_CIRCLE, 0, center_pos.z + sin(theta1) * HQ_NEAR_CIRCLE))
		imm_mesh.surface_set_color(Color.GREEN)
		imm_mesh.surface_add_vertex(Vector3(center_pos.x + cos(theta2) * HQ_NEAR_CIRCLE, 0, center_pos.z + sin(theta2) * HQ_NEAR_CIRCLE))
		
		imm_mesh.surface_set_color(Color.RED)
		imm_mesh.surface_add_vertex(Vector3(center_pos.x + cos(theta1) * LQ_FAR_CIRCLE, -1.0, center_pos.z + sin(theta1) * LQ_FAR_CIRCLE))
		imm_mesh.surface_set_color(Color.RED)
		imm_mesh.surface_add_vertex(Vector3(center_pos.x + cos(theta2) * LQ_FAR_CIRCLE, -1.0, center_pos.z + sin(theta2) * LQ_FAR_CIRCLE))
	imm_mesh.surface_end()

func update_layer_visibilities():
	for key in loaded_tiles.keys():
		var node = loaded_tiles[key]
		if is_instance_valid(node):
			node.visible = show_low_res if key.begins_with("z8_") else show_high_res
			var marker = node.get_node_or_null("DebugMarker")
			if marker:
				marker.visible = debug_mode

func evaluate_memory_limits():
	var cam_pos = camera.global_position
	for key in loaded_tiles.keys():
		var node = loaded_tiles[key]
		if is_instance_valid(node):
			if cam_pos.distance_to(node.global_position) > MEMORY_LIMIT_DISTANCE:
				node.queue_free()
				loaded_tiles.erase(key)
				requested_tiles.erase(key)

func recalculate_tile_anchors():
	var cam_pos = camera.global_position
	var z11_current_x = z11_start_x + floori((cam_pos.x / Z11_SIZE))
	var z11_current_y = z11_start_y + floori((cam_pos.z / Z11_SIZE))
	
	z8_center_x = floori(float(z11_current_x) / 8.0)
	z8_center_y = floori(float(z11_current_y) / 8.0)
