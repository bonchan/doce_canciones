class_name TerrainNoise
## CPU mirror of shaders/common.gdshaderinc -> w_terrain_height().
##
## The camera and the props use this to know where the ground is. It must
## stay a line-by-line copy of the shader math; if you touch one, touch both.

const WRAP_PERIOD: float = 8192.0  # == W_WRAP_PERIOD


static func _hash(x: int, y: int) -> float:
	var h: int = (x * 374761393 + y * 668265263) & 0xFFFFFFFF
	h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
	h = h ^ (h >> 16)
	return float(h >> 8) / 16777215.0


static func _pnoise(p: Vector2, k: float) -> float:
	var K: int = int(k + 0.5)
	var ix: float = floor(p.x)
	var iy: float = floor(p.y)
	var fx: float = p.x - ix
	var fy: float = p.y - iy
	var x0: int = posmod(int(ix), K)
	var y0: int = posmod(int(iy), K)
	var x1: int = (x0 + 1) % K
	var y1: int = (y0 + 1) % K
	var a: float = _hash(x0, y0)
	var b: float = _hash(x1, y0)
	var c: float = _hash(x0, y1)
	var d: float = _hash(x1, y1)
	var ux: float = fx * fx * (3.0 - 2.0 * fx)
	var uy: float = fy * fy * (3.0 - 2.0 * fy)
	return lerp(lerp(a, b, ux), lerp(c, d, ux), uy)


static func _cells(scale: float) -> float:
	return max(1.0, floor(WRAP_PERIOD * scale + 0.5))


static func _fbm(uv: Vector2, k: float, octaves: int, offset: Vector2) -> float:
	var v: float = 0.0
	var amp: float = 0.5
	var norm: float = 0.0
	for i in range(octaves):
		v += amp * _pnoise(uv * k + offset, k)
		norm += amp
		k *= 2.0
		amp *= 0.5
		offset += Vector2(17.3, 31.7)
	return v / norm


static func _ridged(uv: Vector2, k: float, octaves: int) -> float:
	var v: float = 0.0
	var amp: float = 0.5
	var norm: float = 0.0
	var offset := Vector2(41.0, 23.0)
	for i in range(octaves):
		var n: float = _pnoise(uv * k + offset, k)
		var r: float = 1.0 - abs(n * 2.0 - 1.0)
		v += amp * r * r
		norm += amp
		k *= 2.0
		amp *= 0.5
		offset += Vector2(17.3, 31.7)
	return v / norm


## CPU mirror of w_crack / w_crack_drop in common.gdshaderinc. Kept OUT of
## height() on purpose -- the camera reads height() and must sail over the
## disaster, not drop into it. Props read this separately so the fissures
## swallow the vegetation while the view keeps flying.
const CRACK_DEPTH: float = 46.0


static func crack(p: Vector2, alter: float) -> float:
	if alter <= 0.0:
		return 0.0
	var uv: Vector2 = p / WRAP_PERIOD
	var n: float = _ridged(uv, _cells(0.010), 3)
	var lo: float = lerp(0.965, 0.780, alter)
	return smoothstep(lo, min(lo + 0.09, 0.999), n)


static func crack_drop(p: Vector2, alter: float) -> float:
	var c: float = crack(p, alter)
	return c * c * alter * alter * CRACK_DEPTH


static func height(p: Vector2, hill_scale: float, hill_height: float,
		mountain_scale: float, mountain_height: float, warp: float,
		terrace_step: float, terrace_strength: float,
		canyon_scale: float = 0.0, canyon_depth: float = 0.0,
		canyon_width: float = 0.35) -> float:
	var uv: Vector2 = p / WRAP_PERIOD
	var kh: float = _cells(hill_scale)
	var km: float = _cells(mountain_scale)
	var kr: float = _cells(mountain_scale * 0.3)

	var w := Vector2(_fbm(uv, km, 3, Vector2(3.1, 7.7)), _fbm(uv, km, 3, Vector2(11.3, 1.9))) - Vector2(0.5, 0.5)
	var q: Vector2 = uv + w * (2.0 * warp / WRAP_PERIOD)

	var region: float = smoothstep(0.45, 0.65, _fbm(uv, kr, 3, Vector2(5.0, 9.0)))

	var rolling: float = (_fbm(q, kh, 5, Vector2.ZERO) - 0.5) * 2.2
	var ridged: float = smoothstep(0.2, 0.85, _ridged(q, km, 5))

	var h: float = rolling * hill_height * lerp(0.5, 1.0, region)
	h += ridged * ridged * mountain_height * region

	if canyon_depth > 0.0 and canyon_scale > 0.0:
		var kc: float = _cells(canyon_scale)
		var kcr: float = _cells(canyon_scale * 0.25)
		var cn: float = _ridged(q, kc, 4)
		var lo: float = lerp(0.90, 0.52, clamp(canyon_width, 0.0, 1.0))
		var channel: float = smoothstep(lo, lo + 0.13, cn)
		var creg: float = smoothstep(0.42, 0.58, _fbm(uv, kcr, 3, Vector2(23.0, 47.0)))
		var canyon: float = channel * creg
		h = h * lerp(1.0, 0.35, canyon) - canyon * canyon_depth

	if terrace_strength > 0.0:
		var step: float = max(terrace_step, 0.01)
		var t: float = h / step
		var fl: float = floor(t)
		var terraced: float = (fl + smoothstep(0.3, 0.7, t - fl)) * step
		h = lerp(h, terraced, terrace_strength)
	return h
