# telemetry_hud.gd
extends Label

@onready var world_node = get_tree().root.get_node("World") # Adjust path if your root node has a different name
@onready var camera = get_tree().root.get_node("World/Camera3D")

func _process(_delta):
	if not is_instance_valid(world_node) or not is_instance_valid(camera): 
		return
		
	var cam_pos = camera.global_position
	var raw_pitch = rad_to_deg(camera.global_rotation.x)
	var raw_yaw = rad_to_deg(camera.global_rotation.y)
	var compass_yaw = fmod(raw_yaw, 360.0)
	if compass_yaw < 0: compass_yaw += 360.0
	
	var z8_active = 0
	var z8_pending = 0
	var z11_active = 0
	var z11_pending = 0
	
	for k in world_node.loaded_tiles.keys():
		if k.begins_with("z8_"): z8_active += 1
		else: z11_active += 1
	for k in world_node.requested_tiles.keys():
		if k.begins_with("z8_"): z8_pending += 1
		else: z11_pending += 1

	text = "POS: X: %.1f | Y: %.1f | Z: %.1f\n" % [cam_pos.x, cam_pos.y, cam_pos.z]
	text += "HEADING YAW: %.1f° | " % compass_yaw
	text += "CAMERA PITCH: %.1f°\n" % raw_pitch
	text += "-----------------------------------------\n"
	text += "[Z8 LQ HORIZON]: Active: %d | Queued: %d\n" % [z8_active, z8_pending]
	text += "[Z11 HQ MESH]:   Active: %d | Queued: %d" % [z11_active, z11_pending]
