# terrain_data.gd
extends Resource
class_name TerrainData

# Packed raw binary arrays are extremely fast to read/write on disk
@export var elevations: PackedFloat32Array
@export var texture_bytes: PackedByteArray
