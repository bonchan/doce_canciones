// common.gdshaderinc
// Shared procedural noise + terrain height field used by every surface
// (terrain, grass, flowers) so they all agree on where the ground is.
// Pure value-noise FBM, no textures needed.
//
// IMPORTANT: scripts/terrain_noise.gd is a line-by-line CPU mirror of this
// file (the camera and props use it to sit on the ground). If you change the
// math here, change it there too.

// World position repeats with this period so that scroll_offset (also kept
// wrapped to this same period, in world.gd) can wrap around without ever
// producing a visible pop: height(p) == height(p + W_WRAP_PERIOD), exactly.
// Must match WRAP_PERIOD in world.gd.
const float W_WRAP_PERIOD = 8192.0;

// Integer hash -> [0, 1]. Integer math so the GPU and the GDScript mirror
// produce bit-identical lattice values.
float w_hash(int x, int y) {
	uint h = uint(x) * 374761393u + uint(y) * 668265263u;
	h = (h ^ (h >> 13u)) * 1274126177u;
	h = h ^ (h >> 16u);
	return float(h >> 8u) / 16777215.0;
}

// Value noise whose lattice wraps every k cells, so it tiles perfectly.
float w_pnoise(vec2 p, float k) {
	int K = int(k + 0.5);
	vec2 i = floor(p);
	vec2 f = p - i;
	int x0 = int(mod(i.x, k) + 0.5) % K;
	int y0 = int(mod(i.y, k) + 0.5) % K;
	int x1 = (x0 + 1) % K;
	int y1 = (y0 + 1) % K;
	float a = w_hash(x0, y0);
	float b = w_hash(x1, y0);
	float c = w_hash(x0, y1);
	float d = w_hash(x1, y1);
	vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Plain (non-tiling) noise for small cosmetic effects (gusts, sway phase).
float w_noise(vec2 p) {
	return w_pnoise(p, 65536.0);
}

// Number of lattice cells per wrap period for a given frequency (1/meters).
float w_cells(float scale) {
	return max(1.0, floor(W_WRAP_PERIOD * scale + 0.5));
}

// uv = world position / W_WRAP_PERIOD. Returns [0, 1].
float w_fbm(vec2 uv, float k_in, int octaves, vec2 offset_in) {
	float k = k_in;
	vec2 offset = offset_in;
	float v = 0.0;
	float amp = 0.5;
	float norm = 0.0;
	for (int i = 0; i < octaves; i++) {
		v += amp * w_pnoise(uv * k + offset, k);
		norm += amp;
		k *= 2.0;
		amp *= 0.5;
		offset += vec2(17.3, 31.7);
	}
	return v / norm;
}

// Ridged FBM: sharp crests, soft valleys. Returns [0, 1].
float w_ridged(vec2 uv, float k_in, int octaves) {
	float k = k_in;
	float v = 0.0;
	float amp = 0.5;
	float norm = 0.0;
	vec2 offset = vec2(41.0, 23.0);
	for (int i = 0; i < octaves; i++) {
		float n = w_pnoise(uv * k + offset, k);
		float r = 1.0 - abs(n * 2.0 - 1.0);
		v += amp * r * r;
		norm += amp;
		k *= 2.0;
		amp *= 0.5;
		offset += vec2(17.3, 31.7);
	}
	return v / norm;
}

// Height field of the terrain at a world-space XZ position.
//   hill_scale / hill_height        : everyday rolling hills
//   mountain_scale / mountain_height: ridged ranges that come and go
//   warp                            : meters of domain warp (less grid-like)
//   terrace_step / terrace_strength : flat shelves + steep risers (mesas)
float w_terrain_height(vec2 p, float hill_scale, float hill_height,
		float mountain_scale, float mountain_height, float warp,
		float terrace_step, float terrace_strength) {
	vec2 uv = p / W_WRAP_PERIOD;
	float kh = w_cells(hill_scale);
	float km = w_cells(mountain_scale);
	float kr = w_cells(mountain_scale * 0.3);

	// Domain warp. Periodic in p, so the whole field stays periodic.
	vec2 w = vec2(w_fbm(uv, km, 3, vec2(3.1, 7.7)), w_fbm(uv, km, 3, vec2(11.3, 1.9))) - 0.5;
	vec2 q = uv + w * (2.0 * warp / W_WRAP_PERIOD);

	// Regions: 0 = open meadow, 1 = mountain range. (FBM clusters around
	// 0.5, so the thresholds are tight.)
	float region = smoothstep(0.45, 0.65, w_fbm(uv, kr, 3, vec2(5.0, 9.0)));

	// Stretch the FBM out of its narrow band around 0.5.
	float rolling = (w_fbm(q, kh, 5, vec2(0.0)) - 0.5) * 2.2;
	float ridged = smoothstep(0.2, 0.85, w_ridged(q, km, 5));

	float h = rolling * hill_height * mix(0.5, 1.0, region);
	h += ridged * ridged * mountain_height * region;

	if (terrace_strength > 0.0) {
		float step = max(terrace_step, 0.01);
		float t = h / step;
		float fl = floor(t);
		float terraced = (fl + smoothstep(0.3, 0.7, t - fl)) * step;
		h = mix(h, terraced, terrace_strength);
	}
	return h;
}

// ---------------------------------------------------------------------------
// Terrain parameters, shared by every shader that needs the ground height.
// Two full parameter sets, A (current preset) and B (the preset we're
// transitioning to), and the blend between them. The *heights* are mixed, not
// the parameters -- lerping the frequencies would make the lattice jump.
//   x0 = (hill_scale, hill_height, mountain_scale, mountain_height)
//   x1 = (warp_strength, terrace_step, terrace_strength)
uniform vec4 terrain_a0 = vec4(0.035, 4.5, 0.012, 14.0);
uniform vec3 terrain_a1 = vec3(25.0, 2.5, 0.0);
uniform vec4 terrain_b0 = vec4(0.035, 4.5, 0.012, 14.0);
uniform vec3 terrain_b1 = vec3(25.0, 2.5, 0.0);
uniform float terrain_blend : hint_range(0.0, 1.0) = 0.0;

float w_ground(vec2 p) {
	if (terrain_blend <= 0.0) {
		return w_terrain_height(p, terrain_a0.x, terrain_a0.y, terrain_a0.z, terrain_a0.w, terrain_a1.x, terrain_a1.y, terrain_a1.z);
	}
	float hb = w_terrain_height(p, terrain_b0.x, terrain_b0.y, terrain_b0.z, terrain_b0.w, terrain_b1.x, terrain_b1.y, terrain_b1.z);
	if (terrain_blend >= 1.0) {
		return hb;
	}
	float ha = w_terrain_height(p, terrain_a0.x, terrain_a0.y, terrain_a0.z, terrain_a0.w, terrain_a1.x, terrain_a1.y, terrain_a1.z);
	return mix(ha, hb, terrain_blend);
}
