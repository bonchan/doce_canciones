# terrain_service.gd
extends Node

# Signal to alert world.gd when a thread finishes processing a tile mesh package
signal tile_ready(mesh: ArrayMesh, image: Image, task: Dictionary)
signal tile_failed(task: Dictionary)
signal tile_cancelled(task: Dictionary)

const CACHE_DIR = "user://terrain_cache_binary/"

# How many tile "pipelines" (cache-read OR download+decode+mesh) may run
# at once. This is the main freeze-prevention knob:
#   - too high  -> every tile fires at once, CPU/network contention, hitching
#   - too low   -> map fills in too slowly
# 3-4 is a good starting point on most machines; tune to taste.
const MAX_CONCURRENT_PIPELINES := 4

var active_threads: Array[Thread] = []
var active_pipelines: int = 0
var pending_queue: Array[Dictionary] = []

# Kept up to date by world.gd so we can re-sort the queue toward wherever
# the camera is currently pointed.
var _cam_pos: Vector3 = Vector3.ZERO
var _cam_forward: Vector3 = Vector3.FORWARD

func _ready():
	if not DirAccess.dir_exists_absolute(CACHE_DIR):
		DirAccess.make_dir_absolute(CACHE_DIR)

# ----------------------------------------------------------------------
# PUBLIC API
# ----------------------------------------------------------------------

# task must contain: key, z, x, y, is_flat, scale_size
# Also include "world_center": Vector3 (the tile's approximate center in
# world space) if you want distance/yaw-based prioritization to work for it.
#
# Pass urgent = true for the initial "4 surrounding tiles at startup" ring
# so they always jump straight to the front of the queue, regardless of
# camera state.
func request_tile(task: Dictionary, urgent := false):
	task["priority"] = -1e9 if urgent else _score(task, _cam_pos, _cam_forward)
	pending_queue.append(task)
	pending_queue.sort_custom(func(a, b): return a["priority"] < b["priority"])
	_drain_queue()

# Call this once per frame (every 2-3 frames is also fine, it's cheap) from
# world.gd's _process, e.g.:
#   terrain_service.update_view(camera.global_position, -camera.global_transform.basis.z)
func update_view(cam_pos: Vector3, cam_forward: Vector3):
	_cam_pos = cam_pos
	_cam_forward = cam_forward.normalized()
	if pending_queue.is_empty():
		return
	for t in pending_queue:
		t["priority"] = _score(t, _cam_pos, _cam_forward)
	pending_queue.sort_custom(func(a, b): return a["priority"] < b["priority"])
	# Don't call _drain_queue() here on every frame purely for re-sorting;
	# it's already draining whenever a slot frees up in _pipeline_finished().

# Drops any tile still WAITING in the queue whose world_center is now
# further than the given distance from cam_pos (separate thresholds for
# flat/background tiles vs 3D mesh tiles, since they use very different
# ranges). Never touches a pipeline that has already started -- those
# threads/downloads run to completion regardless, so nothing already in
# flight gets interrupted. Fires tile_cancelled for each dropped tile so
# world.gd can clear its own bookkeeping (e.g. requested_tiles) and allow
# that tile to be re-requested later if the camera comes back around.
# Returns how many tiles were dropped, mainly useful for debug logging.
func prune_stale_queue(cam_pos: Vector3, hq_max_distance: float, lq_max_distance: float) -> int:
	if pending_queue.is_empty():
		return 0
	var kept: Array[Dictionary] = []
	var removed := 0
	for t in pending_queue:
		var max_dist = lq_max_distance if t.get("is_flat", false) else hq_max_distance
		var too_far = t.has("world_center") and cam_pos.distance_to(t["world_center"]) > max_dist
		if too_far:
			removed += 1
			tile_cancelled.emit(t)
		else:
			kept.append(t)
	pending_queue = kept
	return removed

func get_queue_size() -> int:
	return pending_queue.size()

# ----------------------------------------------------------------------
# PRIORITY SCORING
# ----------------------------------------------------------------------

func _score(task: Dictionary, cam_pos: Vector3, cam_forward: Vector3) -> float:
	if not task.has("world_center"):
		return 0.0 # no positional info supplied -> neutral priority, FIFO-ish
	var to_tile: Vector3 = task["world_center"] - cam_pos
	var dist := to_tile.length()
	if dist < 0.01:
		return 0.0
	# facing_penalty: 0.0 = dead ahead of the camera, 2.0 = directly behind it
	var facing_penalty := 1.0 - cam_forward.dot(to_tile / dist)
	# Distance dominates the score, but tiles behind the camera get pushed
	# back further even if they're close. Tune the 0.5 weight to taste.
	return dist * (0.5 + facing_penalty)

# ----------------------------------------------------------------------
# QUEUE / CONCURRENCY THROTTLING
# ----------------------------------------------------------------------

func _drain_queue():
	while active_pipelines < MAX_CONCURRENT_PIPELINES and not pending_queue.is_empty():
		var task = pending_queue.pop_front()
		active_pipelines += 1
		_begin_pipeline(task)

func _pipeline_finished():
	active_pipelines -= 1
	_drain_queue()

func _begin_pipeline(task: Dictionary):
	var file_path = CACHE_DIR + task["key"] + ".res"
	if ResourceLoader.exists(file_path):
		# Cache hit: the disk read + deserialize now happens fully inside a
		# worker thread instead of blocking the main thread like before.
		var worker_thread = Thread.new()
		active_threads.append(worker_thread)
		worker_thread.start(_async_load_cache_and_compile.bind(file_path, task))
	else:
		_download_tile_from_web(task)

func _async_load_cache_and_compile(file_path: String, task: Dictionary):
	var cached_res: TerrainData = load(file_path)
	if cached_res == null:
		call_deferred("_retry_as_download", task)
		return
	_compile_tile(cached_res.elevations, cached_res.texture_bytes, task, false)

func _retry_as_download(task: Dictionary):
	push_warning("Cache read failed for %s, re-downloading" % task["key"])
	_download_tile_from_web(task) # same pipeline slot, no new one consumed

# ----------------------------------------------------------------------
# DOWNLOAD PIPELINE
# ----------------------------------------------------------------------

func _download_tile_from_web(task: Dictionary):
	var http_node = HTTPRequest.new()
	add_child(http_node)

	var url = ""
	if task["is_flat"]:
		url = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/%d/%d/%d" % [task["z"], task["y"], task["x"]]
	else:
		url = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/%d/%d/%d.png" % [task["z"], task["x"], task["y"]]

	http_node.request_completed.connect(func(result, code, headers, body):
		http_node.queue_free()
		if code == 200:
			if task["is_flat"]:
				_spawn_worker_thread(PackedFloat32Array(), body, task, false)
			else:
				_download_satellite_texture_fallback(body, task)
		else:
			push_warning("Tile download failed (%d) for %s" % [code, task["key"]])
			tile_failed.emit(task)
			_pipeline_finished()
	)
	http_node.request(url)

func _download_satellite_texture_fallback(elevation_png_bytes: PackedByteArray, task: Dictionary):
	var http_node = HTTPRequest.new()
	add_child(http_node)
	var esri_url = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/11/%d/%d" % [task["y"], task["x"]]

	http_node.request_completed.connect(func(result, code, headers, body):
		http_node.queue_free()
		if code == 200:
			var worker_thread = Thread.new()
			worker_thread.start(_async_extract_and_compile.bind({
				"ele_bytes": elevation_png_bytes, "tex_bytes": body, "task": task, "save_to_disk": true
			}))
			active_threads.append(worker_thread)
		else:
			push_warning("Satellite texture download failed (%d) for %s" % [code, task["key"]])
			tile_failed.emit(task)
			_pipeline_finished()
	)
	http_node.request(esri_url)

func _spawn_worker_thread(elevations: PackedFloat32Array, texture_bytes: PackedByteArray, task: Dictionary, from_cache: bool):
	var worker_thread = Thread.new()
	worker_thread.start(_async_extract_and_compile.bind({
		"ele_floats": elevations, "tex_bytes": texture_bytes, "task": task, "save_to_disk": not from_cache
	}))
	active_threads.append(worker_thread)

# --- ASYNCHRONOUS BACKGROUND THREAD WORKER ---
func _async_extract_and_compile(args: Dictionary):
	var task = args["task"]
	var tex_bytes = args["tex_bytes"]
	var elevations = PackedFloat32Array()

	if args.has("ele_bytes"):
		var raw_img = Image.new()
		if raw_img.load_png_from_buffer(args["ele_bytes"]) == OK:
			# Faster decode: read raw bytes directly instead of get_pixel()
			# per-pixel (which allocates a Color each call). ~5-10x faster
			# for a 256x256 tile.
			raw_img.convert(Image.FORMAT_RGB8)
			var raw_bytes := raw_img.get_data()
			elevations.resize(256 * 256)
			for i in range(256 * 256):
				var idx = i * 3
				var r = raw_bytes[idx]
				var g = raw_bytes[idx + 1]
				var b = raw_bytes[idx + 2]
				elevations[i] = (r * 256.0) + g + (b / 256.0) - 32768.0
	elif args.has("ele_floats"):
		elevations = args["ele_floats"]

	if args["save_to_disk"]:
		var res_save = TerrainData.new()
		res_save.elevations = elevations
		res_save.texture_bytes = tex_bytes
		ResourceSaver.save(res_save, CACHE_DIR + task["key"] + ".res")

	_compile_tile(elevations, tex_bytes, task, false)

func _compile_tile(elevations: PackedFloat32Array, tex_bytes: PackedByteArray, task: Dictionary, _unused: bool):
	var st = SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var scale_size = task["scale_size"]
	var step = scale_size / 254.0

	# Indexed mesh: build the 255x255 vertex grid once, then stitch
	# triangles with an index buffer instead of emitting 6 duplicate
	# vertices per quad. ~6x fewer vertices, cheaper generate_normals(),
	# and smooth-shaded terrain instead of faceted quads.
	for y in range(255):
		for x in range(255):
			var h = -5.0 if task["is_flat"] else elevations[(y * 256) + x] * 0.1
			st.set_uv(Vector2(float(x) / 254.0, float(y) / 254.0))
			st.add_vertex(Vector3(x * step, h, y * step))

	for y in range(254):
		for x in range(254):
			var i00 = y * 255 + x
			var i10 = y * 255 + (x + 1)
			var i01 = (y + 1) * 255 + x
			var i11 = (y + 1) * 255 + (x + 1)
			st.add_index(i00)
			st.add_index(i01)
			st.add_index(i10)
			st.add_index(i10)
			st.add_index(i01)
			st.add_index(i11)

	st.generate_normals()
	var mesh = st.commit()

	var image = Image.new()
	var img_error = image.load_jpg_from_buffer(tex_bytes)

	if img_error == OK:
		call_deferred("_emit_tile_ready", mesh, image, task)
	else:
		print("Background JPEG decompression failed for key: ", task["key"])
		call_deferred("_pipeline_finished")

func _emit_tile_ready(mesh: ArrayMesh, image: Image, task: Dictionary):
	tile_ready.emit(mesh, image, task)
	_pipeline_finished()

func _process(_delta):
	for i in range(active_threads.size() - 1, -1, -1):
		if not active_threads[i].is_alive():
			active_threads[i].wait_to_finish()
			active_threads[i] = null
			active_threads.remove_at(i)
