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

// Shared lighting structs, constants, and the @group(1) binding.
// Included verbatim in any shader that supports lights.
const LIGHT_PRELUDE = /* wgsl */`
const MAX_LIGHTS: u32 = ${MAX_LIGHTS}u;
const LIGHT_AMBIENT:     u32 = 0u;
const LIGHT_POINT:       u32 = 1u;
const LIGHT_DIRECTIONAL: u32 = 2u;

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

fn quantize(value: f32, steps: f32) -> f32 {
    if (steps <= 0.0) { return value; }
    return floor(value * steps) / steps;
}

@group(1) @binding(0) var<uniform> light_data: LightArray;
`;

// compute_lighting — shared lighting accumulation function.
// Requires light_data, normal_texture, sprite_sampler declared in the same module.
const LIGHTING_FN = /* wgsl */`
fn compute_lighting(tex_color: vec4<f32>, uv: vec2<f32>, logical_pos: vec2<f32>) -> vec4<f32> {
    if (light_data.count == 0u) { return tex_color; }

    let normal_sample = textureSample(normal_texture, sprite_sampler, uv).rgb;
    let normal = normalize(normal_sample * 2.0 - 1.0);

    var light_accum = vec3<f32>(0.0);

    for (var i = 0u; i < light_data.count; i++) {
        let light = light_data.lights[i];
        let light_rgb = light.color.rgb * light.color.w;

        if (light.kind == LIGHT_AMBIENT) {
            light_accum += light_rgb;

        } else if (light.kind == LIGHT_POINT) {
            let delta = light.position - logical_pos;
            let to_light = vec3<f32>(delta.x, -delta.y, light.height);
            let dist = distance(logical_pos, light.position);
            let t = clamp(dist / light.radius, 0.0, 1.0);
            let atten = quantize(pow(1.0 - t, light.falloff), light.steps);
            let light_dir = normalize(to_light);
            let diffuse = quantize(max(dot(normal, light_dir), 0.0), light.steps);
            light_accum += light_rgb * atten * diffuse;

        } else if (light.kind == LIGHT_DIRECTIONAL) {
            let light_dir = normalize(vec3<f32>(light.direction.x, -light.direction.y, 1.0));
            let diffuse = quantize(max(dot(normal, light_dir), 0.0), light.steps);
            light_accum += light_rgb * diffuse;
        }
    }

    return vec4<f32>(tex_color.rgb * light_accum, tex_color.a);
}
`;

// Standard lit sprite shader.
export const FRAGMENT_SHADER = /* wgsl */`
${LIGHT_PRELUDE}

@group(2) @binding(0) var diffuse_texture: texture_2d<f32>;
@group(2) @binding(1) var normal_texture:  texture_2d<f32>;
@group(2) @binding(2) var sprite_sampler:  sampler;

${LIGHTING_FN}

@fragment
fn fs_main(
    @location(0) uv:          vec2<f32>,
    @location(1) color:       vec4<f32>,
    @location(2) logical_pos: vec2<f32>,
) -> @location(0) vec4<f32> {
    let tex_color = textureSample(diffuse_texture, sprite_sampler, uv) * color;
    return compute_lighting(tex_color, uv, logical_pos);
}
`;

// Palette-swap shader. Bindings 3 and 4 are the source and destination palette strips
// (1×N textures where N is the number of palette entries). Each pixel's RGB is compared
// against each source entry; if it matches within 8-bit precision, the destination RGB
// replaces it. Alpha is preserved from the original pixel, multiplied by the destination
// alpha (so dst.a = 255 is a no-op on alpha; lower values add transparency).
export const PALETTE_FRAGMENT_SHADER = /* wgsl */`
${LIGHT_PRELUDE}

@group(2) @binding(0) var diffuse_texture: texture_2d<f32>;
@group(2) @binding(1) var normal_texture:  texture_2d<f32>;
@group(2) @binding(2) var sprite_sampler:  sampler;
@group(2) @binding(3) var palette_src:     texture_2d<f32>;
@group(2) @binding(4) var palette_dst:     texture_2d<f32>;

${LIGHTING_FN}

fn palette_remap(raw: vec4<f32>) -> vec4<f32> {
    let count = i32(textureDimensions(palette_src).x);
    for (var i: i32 = 0; i < count; i++) {
        let src = textureLoad(palette_src, vec2<i32>(i, 0), 0);
        if (all(abs(raw.rgb - src.rgb) < vec3<f32>(0.5 / 255.0))) {
            let dst = textureLoad(palette_dst, vec2<i32>(i, 0), 0);
            return vec4<f32>(dst.rgb, raw.a * dst.a);
        }
    }
    return raw;
}

@fragment
fn fs_main(
    @location(0) uv:          vec2<f32>,
    @location(1) color:       vec4<f32>,
    @location(2) logical_pos: vec2<f32>,
) -> @location(0) vec4<f32> {
    let raw_color = textureSample(diffuse_texture, sprite_sampler, uv);
    let tex_color = palette_remap(raw_color) * color;
    return compute_lighting(tex_color, uv, logical_pos);
}
`;

// Overlay shader. Ignores the texture's RGB entirely — uses vertex color as a flat
// fill color and the texture's alpha as the shape mask. Unlit by design (overlay is
// intended for effects like hit-flash where lighting would fight the effect).
// Set all four vertex colors to the desired overlay color before drawing.
export const OVERLAY_FRAGMENT_SHADER = /* wgsl */`
@group(2) @binding(0) var diffuse_texture: texture_2d<f32>;
@group(2) @binding(2) var sprite_sampler:  sampler;

@fragment
fn fs_main(
    @location(0) uv:          vec2<f32>,
    @location(1) color:       vec4<f32>,
    @location(2) logical_pos: vec2<f32>,
) -> @location(0) vec4<f32> {
    let alpha = textureSample(diffuse_texture, sprite_sampler, uv).a;
    return vec4<f32>(color.rgb, alpha * color.a);
}
`;

// Point vertex shader. No UV — points have no texture.
export const POINT_VERTEX_SHADER = /* wgsl */`
struct ScreenSize {
    width: f32,
    height: f32,
};

@group(0) @binding(0) var<uniform> screen: ScreenSize;

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) color:    vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) color:       vec4<f32>,
    @location(1) logical_pos: vec2<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let ndcX =  (in.position.x / screen.width)  * 2.0 - 1.0;
    let ndcY = -(in.position.y / screen.height) * 2.0 + 1.0;
    out.clip_position = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
    out.color = in.color;
    out.logical_pos = in.position;
    return out;
}
`;

// Point fragment shader. Uses a hardcoded flat normal (0, 0, 1) — equivalent to a
// surface facing directly at the camera — so points respond to lighting in the same
// way a sprite with no normal map would. No texture bindings needed.
export const POINT_FRAGMENT_SHADER = /* wgsl */`
${LIGHT_PRELUDE}

fn compute_lighting(color: vec4<f32>, logical_pos: vec2<f32>) -> vec4<f32> {
    if (light_data.count == 0u) { return color; }

    let normal = vec3<f32>(0.0, 0.0, 1.0);
    var light_accum = vec3<f32>(0.0);

    for (var i = 0u; i < light_data.count; i++) {
        let light = light_data.lights[i];
        let light_rgb = light.color.rgb * light.color.w;

        if (light.kind == LIGHT_AMBIENT) {
            light_accum += light_rgb;

        } else if (light.kind == LIGHT_POINT) {
            let delta = light.position - logical_pos;
            let to_light = vec3<f32>(delta.x, -delta.y, light.height);
            let dist = distance(logical_pos, light.position);
            let t = clamp(dist / light.radius, 0.0, 1.0);
            let atten = quantize(pow(1.0 - t, light.falloff), light.steps);
            let light_dir = normalize(to_light);
            let diffuse = quantize(max(dot(normal, light_dir), 0.0), light.steps);
            light_accum += light_rgb * atten * diffuse;

        } else if (light.kind == LIGHT_DIRECTIONAL) {
            let light_dir = normalize(vec3<f32>(light.direction.x, -light.direction.y, 1.0));
            let diffuse = quantize(max(dot(normal, light_dir), 0.0), light.steps);
            light_accum += light_rgb * diffuse;
        }
    }

    return vec4<f32>(color.rgb * light_accum, color.a);
}

@fragment
fn fs_main(
    @location(0) color:       vec4<f32>,
    @location(1) logical_pos: vec2<f32>,
) -> @location(0) vec4<f32> {
    return compute_lighting(color, logical_pos);
}
`;
