export const VERTEX_SHADER = /* wgsl */`
struct ScreenSize {
    width: f32,
    height: f32,
};

@group(0) @binding(0) var<uniform> screen: ScreenSize;

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) logical_pos: vec2<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let ndcX =  (in.position.x / screen.width)  * 2.0 - 1.0;
    let ndcY = -(in.position.y / screen.height) * 2.0 + 1.0;
    out.clip_position = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
    out.uv = in.uv;
    out.color = in.color;
    out.logical_pos = in.position;
    return out;
}
`;

// Maximum number of lights per layer. Must match MAX_LIGHTS in the fragment shader.
export const MAX_LIGHTS = 64;

// Light buffer size in bytes: 16-byte header + MAX_LIGHTS * 64 bytes per light.
export const LIGHT_BUFFER_SIZE = 16 + MAX_LIGHTS * 64;

export const FRAGMENT_SHADER = /* wgsl */`
const MAX_LIGHTS: u32 = ${MAX_LIGHTS}u;
const LIGHT_AMBIENT:     u32 = 0u;
const LIGHT_POINT:       u32 = 1u;
const LIGHT_DIRECTIONAL: u32 = 2u;

// 64 bytes, 16-byte aligned
struct Light {
    position:  vec2<f32>,  // offset  0
    direction: vec2<f32>,  // offset  8
    color:     vec4<f32>,  // offset 16  (rgb in xyz, intensity in w)
    radius:    f32,        // offset 32
    falloff:   f32,        // offset 36
    kind:      u32,        // offset 40
    height:    f32,        // offset 44
    steps:     f32,        // offset 48  0 = smooth, >0 = number of discrete bands
    _pad0:     f32,        // offset 52
    _pad1:     f32,        // offset 56
    _pad2:     f32,        // offset 60
};

struct LightArray {
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    lights: array<Light, ${MAX_LIGHTS}>,
};

// Optionally quantize a 0–1 value into [steps] discrete bands.
// steps == 0 passes the value through unchanged.
fn quantize(value: f32, steps: f32) -> f32 {
    if (steps <= 0.0) { return value; }
    return floor(value * steps) / steps;
}

@group(1) @binding(0) var<uniform> light_data: LightArray;

@group(2) @binding(0) var diffuse_texture: texture_2d<f32>;
@group(2) @binding(1) var normal_texture:  texture_2d<f32>;
@group(2) @binding(2) var sprite_sampler:  sampler;

@fragment
fn fs_main(
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) logical_pos: vec2<f32>,
) -> @location(0) vec4<f32> {
    let tex_color = textureSample(diffuse_texture, sprite_sampler, uv) * color;

    // No lights in this layer — return full brightness, preserving vertex color
    if (light_data.count == 0u) {
        return tex_color;
    }

    // Decode normal map from [0,1] texture space to [-1,1] normal space
    let normal_sample = textureSample(normal_texture, sprite_sampler, uv).rgb;
    let normal = normalize(normal_sample * 2.0 - 1.0);

    var light_accum = vec3<f32>(0.0);

    for (var i = 0u; i < light_data.count; i++) {
        let light = light_data.lights[i];
        let light_rgb = light.color.rgb * light.color.w;  // rgb * intensity

        if (light.kind == LIGHT_AMBIENT) {
            light_accum += light_rgb;

        } else if (light.kind == LIGHT_POINT) {
            let to_light = vec3<f32>(light.position - logical_pos, light.height);
            let dist = distance(logical_pos, light.position);
            let t = clamp(dist / light.radius, 0.0, 1.0);
            let atten = quantize(pow(1.0 - t, light.falloff), light.steps);
            let light_dir = normalize(to_light);
            let diffuse = quantize(max(dot(normal, light_dir), 0.0), light.steps);
            light_accum += light_rgb * atten * diffuse;

        } else if (light.kind == LIGHT_DIRECTIONAL) {
            // Lift 2D direction into normal-map space (z=1 = facing camera).
            // On a flat-normal sprite the result is uniform, acting like ambient.
            let light_dir = normalize(vec3<f32>(light.direction.x, light.direction.y, 1.0));
            let diffuse = quantize(max(dot(normal, light_dir), 0.0), light.steps);
            light_accum += light_rgb * diffuse;
        }
    }

    return vec4<f32>(tex_color.rgb * light_accum, tex_color.a);
}
`;
