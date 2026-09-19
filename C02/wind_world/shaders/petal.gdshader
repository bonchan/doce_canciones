shader_type spatial;
render_mode unshaded, cull_disabled, blend_mix, depth_prepass_alpha;

// Particles closer than this fade out, so none of them pops out of view (near
// plane / passing the camera) while it looks big.
uniform float near_fade_start = 0.5;
uniform float near_fade_end = 3.0;

void vertex() {
	// Simple camera-facing billboard so petals always read as little
	// flecks of color regardless of drift direction.
	MODELVIEW_MATRIX = VIEW_MATRIX * mat4(
		INV_VIEW_MATRIX[0],
		INV_VIEW_MATRIX[1],
		INV_VIEW_MATRIX[2],
		MODEL_MATRIX[3]
	);
}

void fragment() {
	vec2 centered = UV - vec2(0.5);
	float d = length(centered);
	float mask = smoothstep(0.5, 0.35, d);
	float near = smoothstep(near_fade_start, near_fade_end, -VERTEX.z);
	ALBEDO = COLOR.rgb;
	ALPHA = mask * COLOR.a * near;
}
