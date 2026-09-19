class_name PlantMeshes
## Procedural low-poly plants of the Patagonian steppe (estepa patagonica).
## Each is an ArrayMesh with vertex colors, origin at its base, sized in
## meters, so a prop size of 1.0 is a typical adult plant.
##
##   zampa     Atriplex lampa -- rounded, dense, silvery grey-green mound (~1 m)
##   jarilla   Larrea -- many slender upright branches fanning out from the
##             base, small dark resinous leaves, a few yellow flowers (~1.5-2 m)
##   alpataco  Prosopis alpataco -- low, wide, spreading shrub with zigzag
##             thorny branches and a flat grey-green canopy (~0.6 m tall, 3 m wide)
##   coiron    tussock grass (Pappostipa / Festuca) -- straw-colored clump of
##             blades, the texture of the whole steppe (~0.5 m)

const KINDS := ["zampa", "jarilla", "alpataco", "coiron"]

const BARK := Color(0.34, 0.29, 0.23)


static func build(kind: String, seed1: int) -> ArrayMesh:
	var rng := RandomNumberGenerator.new()
	rng.seed = seed1
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	match kind:
		"zampa": _zampa(st, rng)
		"jarilla": _jarilla(st, rng)
		"alpataco": _alpataco(st, rng)
		"coiron": _coiron(st, rng)
	st.generate_normals()
	return st.commit()


# ---------------------------------------------------------------- the plants

static func _zampa(st: SurfaceTool, rng: RandomNumberGenerator) -> void:
	var h: float = rng.randf_range(0.8, 1.1)
	var rad: float = rng.randf_range(0.6, 0.85)
	# A few woody stems at the base.
	for i in range(5):
		var az: float = rng.randf() * TAU
		_branch(st, Vector3(0, 0, 0), Vector3(cos(az) * 0.3, 0.4 * h, sin(az) * 0.3), 0.035, 0.015, BARK)
	# Dense dome of silvery foliage clumps.
	var silver := Color(0.5, 0.56, 0.45)
	var sage := Color(0.4, 0.48, 0.36)
	for i in range(rng.randi_range(13, 17)):
		var az: float = rng.randf() * TAU
		var el: float = rng.randf_range(0.1, 1.3)
		var p := Vector3(cos(az) * cos(el) * rad * 0.75, 0.3 * h + sin(el) * h * 0.55, sin(az) * cos(el) * rad * 0.75)
		var r: float = rng.randf_range(0.22, 0.34)
		_blob(st, rng, p, Vector3(r, r * 0.8, r), silver.lerp(sage, rng.randf()))


static func _jarilla(st: SurfaceTool, rng: RandomNumberGenerator) -> void:
	var leaf := Color(0.25, 0.36, 0.15)
	var leaf2 := Color(0.33, 0.42, 0.17)
	var flower := Color(0.97, 0.8, 0.18)
	for i in range(rng.randi_range(14, 20)):
		var az: float = rng.randf() * TAU
		var lean: float = rng.randf_range(0.12, 0.5)
		var height: float = rng.randf_range(1.2, 2.0)
		var base := Vector3(rng.randf_range(-0.08, 0.08), 0.0, rng.randf_range(-0.08, 0.08))
		var mid: Vector3 = base + Vector3(sin(lean) * cos(az), cos(lean), sin(lean) * sin(az)) * height * 0.5
		var az2: float = az + rng.randf_range(-0.3, 0.3)
		var lean2: float = lean * 1.3
		var tip: Vector3 = mid + Vector3(sin(lean2) * cos(az2), cos(lean2), sin(lean2) * sin(az2)) * height * 0.5
		_branch(st, base, mid, 0.025, 0.017, BARK)
		_branch(st, mid, tip, 0.017, 0.006, BARK)
		# Small leaf clusters along the upper part of each branch.
		for k in range(rng.randi_range(3, 5)):
			var t: float = rng.randf_range(0.2, 1.0)
			var p: Vector3 = mid.lerp(tip, t) if rng.randf() < 0.75 else base.lerp(mid, rng.randf_range(0.6, 1.0))
			var r: float = rng.randf_range(0.07, 0.13)
			_blob(st, rng, p, Vector3(r, r * 1.2, r), leaf.lerp(leaf2, rng.randf()))
		if rng.randf() < 0.35:
			_blob(st, rng, tip, Vector3(0.045, 0.045, 0.045), flower)


static func _alpataco(st: SurfaceTool, rng: RandomNumberGenerator) -> void:
	var canopy := Color(0.46, 0.52, 0.36)
	var canopy2 := Color(0.4, 0.46, 0.3)
	var n: int = rng.randi_range(6, 9)
	for i in range(n):
		var az: float = TAU * float(i) / float(n) + rng.randf_range(-0.3, 0.3)
		var length: float = rng.randf_range(1.0, 1.6)
		var segs: int = 4
		var p := Vector3(0.0, 0.02, 0.0)
		for s in range(segs):
			# Zigzag: alternate left/right of the main direction.
			var a: float = az + (0.35 if s % 2 == 0 else -0.35) + rng.randf_range(-0.1, 0.1)
			var step: float = length / float(segs)
			var rise: float = rng.randf_range(0.08, 0.2) * (1.0 if s < 2 else 0.3)
			var q: Vector3 = p + Vector3(cos(a) * step, rise, sin(a) * step)
			_branch(st, p, q, 0.035 * (1.0 - s * 0.2), 0.035 * (1.0 - (s + 1) * 0.2), BARK)
			if s >= 1:
				var r: float = rng.randf_range(0.3, 0.45)
				_blob(st, rng, q + Vector3(0, 0.12, 0), Vector3(r, rng.randf_range(0.13, 0.2), r), canopy.lerp(canopy2, rng.randf()))
			p = q
	_blob(st, rng, Vector3(0, 0.42, 0), Vector3(0.5, 0.22, 0.5), canopy)


static func _coiron(st: SurfaceTool, rng: RandomNumberGenerator) -> void:
	var straw := Color(0.8, 0.72, 0.46)
	var grey := Color(0.58, 0.6, 0.42)
	for i in range(rng.randi_range(32, 46)):
		var az: float = rng.randf() * TAU
		var base := Vector3(cos(az), 0.0, sin(az)) * rng.randf_range(0.0, 0.12)
		var out: float = rng.randf_range(0.12, 0.45)
		var h: float = rng.randf_range(0.3, 0.6)
		var tip: Vector3 = base * 0.5 + Vector3(cos(az) * out, h, sin(az) * out)
		var side := Vector3(-sin(az), 0.0, cos(az)) * rng.randf_range(0.012, 0.022)
		var col: Color = straw.lerp(grey, rng.randf())
		var dark: Color = col * 0.6
		dark.a = 1.0
		st.set_color(dark); st.add_vertex(base - side)
		st.set_color(dark); st.add_vertex(base + side)
		st.set_color(col); st.add_vertex(tip)


# ------------------------------------------------------------------ helpers

static func _tri(st: SurfaceTool, a: Vector3, b: Vector3, c: Vector3, col: Color) -> void:
	st.set_color(col); st.add_vertex(a)
	st.set_color(col); st.add_vertex(b)
	st.set_color(col); st.add_vertex(c)


## Tapered 4-sided stick from a to b.
static func _branch(st: SurfaceTool, a: Vector3, b: Vector3, r0: float, r1: float, col: Color, sides: int = 4) -> void:
	var axis: Vector3 = (b - a).normalized()
	var ref := Vector3.UP if abs(axis.dot(Vector3.UP)) < 0.9 else Vector3.RIGHT
	var u: Vector3 = axis.cross(ref).normalized()
	var v: Vector3 = axis.cross(u).normalized()
	for i in range(sides):
		var a0: float = TAU * float(i) / float(sides)
		var a1: float = TAU * float(i + 1) / float(sides)
		var d0: Vector3 = u * cos(a0) + v * sin(a0)
		var d1: Vector3 = u * cos(a1) + v * sin(a1)
		var p0: Vector3 = a + d0 * r0
		var p1: Vector3 = a + d1 * r0
		var q0: Vector3 = b + d0 * r1
		var q1: Vector3 = b + d1 * r1
		_tri(st, p0, q0, p1, col)
		_tri(st, p1, q0, q1, col)


## Lumpy low-poly ellipsoid (foliage clump). Each face gets a slightly
## different shade, which reads as leafy texture.
static func _blob(st: SurfaceTool, rng: RandomNumberGenerator, center: Vector3, radius: Vector3, col: Color) -> void:
	var seg: int = 6
	var lats: Array = [-0.9, -0.3, 0.3, 0.9] # radians
	var rings: Array = []
	for lat in lats:
		var ring: Array = []
		for j in range(seg):
			var lon: float = TAU * (float(j) + (0.5 if rings.size() % 2 == 1 else 0.0)) / float(seg)
			var offset := Vector3(cos(lat) * cos(lon) * radius.x, sin(lat) * radius.y, cos(lat) * sin(lon) * radius.z)
			ring.append(center + offset * rng.randf_range(0.8, 1.15))
		rings.append(ring)
	var top: Vector3 = center + Vector3(0, radius.y * rng.randf_range(0.9, 1.1), 0)
	var bottom: Vector3 = center - Vector3(0, radius.y * 0.9, 0)
	for j in range(seg):
		var j1: int = (j + 1) % seg
		_tri(st, top, rings[3][j1], rings[3][j], _shade(col, rng))
		_tri(st, bottom, rings[0][j], rings[0][j1], _shade(col, rng))
		for r in range(3):
			var lo: Array = rings[r]
			var hi: Array = rings[r + 1]
			_tri(st, lo[j], hi[j], lo[j1], _shade(col, rng))
			_tri(st, lo[j1], hi[j], hi[j1], _shade(col, rng))


static func _shade(col: Color, rng: RandomNumberGenerator) -> Color:
	var k: float = rng.randf_range(0.85, 1.12)
	return Color(col.r * k, col.g * k, col.b * k, 1.0)
