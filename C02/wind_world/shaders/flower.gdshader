shader_type spatial;
render_mode diffuse_burley, cull_disabled, world_vertex_coords;

#include "res://shaders/common.gdshaderinc"

uniform vec2 scroll_offset = vec2(0.0);

uniform float tile_size : hint_range(10.0, 400.0) = 90.0;

uniform vec2 wind_dir = vec2(1.0, 0.0);
uniform float wind_speed = 0.0;
uniform float bend_strength : hint_range(0.0, 3.0) = 0.5;

// Size = mix(min, max, INSTANCE_CUSTOM.b).
uniform float scale_min = 0.8;
uniform float scale_max = 1.4;

// Two palettes (current preset A, next preset B) and the blend between them.
// Each flower picks a slot with INSTANCE_CUSTOM.r and jitters its brightness
// with INSTANCE_CUSTOM.g.
uniform vec4 palette_a[8];
uniform int palette_a_count = 1;
uniform vec4 palette_b[8];
uniform int palette_b_count = 1;
uniform float palette_blend = 0.0;
// Flowers glow in their own color (0 = off).
uniform float emission_energy = 0.0;

varying vec3 v_color;

void vertex() {
	vec3 instance_pos = MODEL_MATRIX[3].xyz;

	VERTEX = instance_pos + (VERTEX - instance_pos) * mix(scale_min, scale_max, INSTANCE_CUSTOM.b);

	vec2 raw = instance_pos.xz - scroll_offset;
	vec2 half_tile = vec2(tile_size * 0.5);
	vec2 wrapped = mod(raw + half_tile, tile_size) - half_tile;
	// Move the flower from its planted spot to its wrapped, camera-relative spot.
	vec2 correction = wrapped - instance_pos.xz;

	vec2 world_p = wrapped + scroll_offset;
	float ground_h = w_ground(world_p);

	VERTEX.xz += correction;
	VERTEX.y += ground_h;

	// Flowers are stiffer than grass and sway rather than bend hard;
	// UV.y = 0 at the base of the stem, 1 at the flower head.
	float sway_amount = UV.y * UV.y * UV.y;
	float phase = w_noise(world_p * 0.3) * 6.2831853;
	float wobble = sin(TIME * 1.6 + phase) * 0.35 + 0.65;
	vec2 sway = wind_dir * wind_speed * bend_strength * 0.06 * sway_amount * wobble;
	VERTEX.xz += sway;

	int ia = clamp(int(INSTANCE_CUSTOM.r * float(palette_a_count)), 0, max(palette_a_count - 1, 0));
	int ib = clamp(int(INSTANCE_CUSTOM.r * float(palette_b_count)), 0, max(palette_b_count - 1, 0));
	vec3 col = mix(palette_a[ia].rgb, palette_b[ib].rgb, palette_blend);
	v_color = col * (0.85 + 0.3 * INSTANCE_CUSTOM.g);
}

void fragment() {
	ALBEDO = v_color;
	EMISSION = v_color * emission_energy;
	ROUGHNESS = 0.5;
	SPECULAR = 0.2;
}
