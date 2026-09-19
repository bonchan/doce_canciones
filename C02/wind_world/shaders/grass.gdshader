shader_type spatial;
render_mode diffuse_burley, cull_disabled, world_vertex_coords;

#include "res://shaders/common.gdshaderinc"

uniform vec2 scroll_offset = vec2(0.0);

uniform float tile_size : hint_range(10.0, 400.0) = 90.0;

uniform vec2 wind_dir = vec2(1.0, 0.0); // normalized XZ
uniform float wind_speed = 0.0;         // m/s, unclamped display value
uniform float bend_strength : hint_range(0.0, 3.0) = 0.9;
uniform float time_scale : hint_range(0.0, 5.0) = 1.0;

// Blade height = mix(min, max, per-instance random in INSTANCE_CUSTOM.r), so
// it can blend live between presets.
uniform float height_min = 0.28;
uniform float height_max = 0.6;

uniform vec4 color_base : source_color = vec4(0.09, 0.24, 0.10, 1.0);
uniform vec4 color_tip : source_color = vec4(0.42, 0.62, 0.22, 1.0);
// Glow at the blade tips (linear, may exceed 1.0). Black = off.
uniform vec4 tip_emission = vec4(0.0);

void vertex() {
	// True (unwrapped) instance position: this node sits at the origin, so
	// MODEL_MATRIX's translation column is exactly this blade's planted
	// position in the field.
	vec3 instance_pos = MODEL_MATRIX[3].xyz;

	// The blade mesh is 1 m tall; scale it to this instance's height.
	VERTEX.y = instance_pos.y + (VERTEX.y - instance_pos.y) * mix(height_min, height_max, INSTANCE_CUSTOM.r);

	vec2 raw = instance_pos.xz - scroll_offset;
	vec2 half_tile = vec2(tile_size * 0.5);
	vec2 wrapped = mod(raw + half_tile, tile_size) - half_tile;
	// Move the blade from its planted spot to its wrapped, camera-relative spot.
	vec2 correction = wrapped - instance_pos.xz;

	// The world-space point this instance currently represents (it "steps"
	// forward by tile_size each time it wraps back into view) -- same
	// convention the terrain mesh uses, so heights match.
	vec2 world_p = wrapped + scroll_offset;
	float ground_h = w_ground(world_p);

	VERTEX.xz += correction;
	VERTEX.y += ground_h;

	// Bend: UV.y = 0 at the root (no bend), 1 at the tip (full bend).
	float bend_amount = UV.y * UV.y;
	float gust = w_noise(world_p * 0.15 + vec2(TIME * time_scale * 0.6, 0.0)) * 0.6 + 0.7;
	vec2 bend = wind_dir * wind_speed * bend_strength * 0.12 * bend_amount * gust;
	VERTEX.xz += bend;
	VERTEX.y -= abs(bend.x + bend.y) * 0.05; // slight droop as it bends
}

void fragment() {
	float grad = clamp(UV.y, 0.0, 1.0);
	ALBEDO = mix(color_base.rgb, color_tip.rgb, grad);
	EMISSION = tip_emission.rgb * grad * grad;
	ROUGHNESS = 0.85;
	SPECULAR = 0.02;
}
