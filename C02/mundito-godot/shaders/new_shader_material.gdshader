shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_disabled, diffuse_lambert, specular_schlick_ggx;

uniform sampler2D albedo_texture : source_color, filter_linear_mipmap;
uniform float curvature : hint_range(0.0, 0.0001) = 0.00002;

void vertex() {
	// Get the vertex position relative to the camera
	vec4 world_pos = MODEL_MATRIX * vec4(VERTEX, 1.0);
	vec4 cam_pos = INV_VIEW_MATRIX * vec4(0.0, 0.0, 0.0, 1.0);
	
	// Calculate horizontal distance over the flat plane
	float dist_x = world_pos.x - cam_pos.x;
	float dist_z = world_pos.z - cam_pos.z;
	float dist_squared = (dist_x * dist_x) + (dist_z * dist_z);
	
	// Drop the vertex down based on distance squared
	VERTEX.y -= dist_squared * curvature;
}

void fragment() {
	vec4 tex = texture(albedo_texture, UV);
	ALBEDO = tex.rgb;
	ROUGHNESS = 1.0;
}