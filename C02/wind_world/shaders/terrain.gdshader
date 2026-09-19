shader_type spatial;
render_mode diffuse_burley, specular_schlick_ggx;

#include "res://shaders/common.gdshaderinc"

// scroll_offset snapped down to the terrain grid (see _update_terrain_snap in
// world.gd). The mesh itself is shifted by the leftover fraction, so every
// vertex always samples the same fixed world lattice points -- otherwise the
// triangles slide over the height field and sharp ridges shimmer.
uniform vec2 grid_origin = vec2(0.0);

uniform vec4 color_low : source_color = vec4(0.11, 0.28, 0.14, 1.0);
uniform vec4 color_high : source_color = vec4(0.55, 0.75, 0.35, 1.0);
uniform vec4 color_rock : source_color = vec4(0.42, 0.38, 0.33, 1.0);
uniform vec4 color_peak : source_color = vec4(0.88, 0.88, 0.84, 1.0);
uniform float wind_speed_norm : hint_range(0.0, 1.0) = 0.0;

// Optional glowing lines drawn into the surface (neon looks). All zero =
// off. Colors are linear and may go above 1.0 to bloom.
//   grid    : world-space square grid, scrolls with the land
//   contour : height contour lines (topographic)
//   pulse   : 0..1, a slow wave of brightness running across the lines
uniform vec4 grid_color = vec4(0.0);
uniform float grid_spacing = 8.0;
uniform float grid_width = 0.04;
uniform vec4 contour_color = vec4(0.0);
uniform float contour_step = 2.0;
uniform float contour_width = 0.05;
uniform float line_pulse = 0.0;

varying float v_height01;
varying float v_peak01;
varying float v_slope;
varying vec2 v_world;
varying float v_h;

float ground(vec2 p) {
	return w_ground(p);
}

// 1 on the integer lines of v, 0 between; antialiased, and fading out where
// the lines get denser than a pixel (distance) instead of shimmering.
float neon_line(float v, float width) {
	float d = abs(fract(v - 0.5) - 0.5);
	float fw = max(fwidth(v), 1e-4);
	float l = 1.0 - smoothstep(width, width + fw * 1.5, d);
	return l * (1.0 - smoothstep(0.15, 0.5, fw));
}

void vertex() {
	// VERTEX is in the plane's local space; grid_origin places it on the
	// fixed world lattice.
	vec2 world_p = VERTEX.xz + grid_origin;
	float h = ground(world_p);
	VERTEX.y = h;

	// Normal from finite differences (the plane's own normal is flat up).
	float e = 0.75;
	float hx = ground(world_p + vec2(e, 0.0));
	float hz = ground(world_p + vec2(0.0, e));
	NORMAL = normalize(vec3(h - hx, e, h - hz));

	float hill_height = mix(terrain_a0.y, terrain_b0.y, terrain_blend);
	float mountain_height = mix(terrain_a0.w, terrain_b0.w, terrain_blend);
	v_height01 = clamp(h / max(hill_height, 0.001) + 0.5, 0.0, 1.0);
	v_peak01 = clamp((h - hill_height * 0.5) / max(mountain_height * 0.6, 0.001), 0.0, 1.0);
	v_slope = 1.0 - NORMAL.y;
	v_world = world_p;
	v_h = h;
}

void fragment() {
	vec3 col = mix(color_low.rgb, color_high.rgb, v_height01);
	col = mix(col, color_rock.rgb, smoothstep(0.18, 0.4, v_slope));
	col = mix(col, color_peak.rgb, smoothstep(0.55, 0.9, v_peak01) * (1.0 - smoothstep(0.3, 0.5, v_slope)));
	// A touch more saturation/brightness when the wind picks up, so the
	// whole scene visibly "wakes up" with the anemometer reading.
	ALBEDO = mix(col, col * vec3(1.05, 1.08, 0.95), wind_speed_norm);
	ROUGHNESS = 0.92;
	SPECULAR = 0.05;

	if (grid_color.rgb != vec3(0.0) || contour_color.rgb != vec3(0.0)) {
		// The grid is flat (XZ): on steep faces it would smear into solid
		// blocks, so it fades out there and the contours take over.
		float g = max(neon_line(v_world.x / grid_spacing, grid_width), neon_line(v_world.y / grid_spacing, grid_width));
		// Per-pixel steepness: how fast height changes vs. horizontal position
		// (vertex normals are too smooth to catch sharp terrace risers).
		float steep = (abs(dFdx(v_h)) + abs(dFdy(v_h))) / max(length(dFdx(v_world)) + length(dFdy(v_world)), 1e-4);
		g *= 1.0 - smoothstep(0.5, 1.0, steep);
		// Contours only on slopes: on flat ground (e.g. a terrace shelf sitting
		// right at a contour height) they would flood the whole floor.
		float cl = neon_line(v_h / contour_step, contour_width) * smoothstep(0.05, 0.2, steep);
		float wave = 0.5 + 0.5 * sin(v_h * 0.8 + v_world.x * 0.03 - TIME * 2.0);
		float pulse = mix(1.0, 0.35 + 1.8 * wave * wave, line_pulse);
		EMISSION = (grid_color.rgb * g + contour_color.rgb * cl) * pulse;
	}
}
