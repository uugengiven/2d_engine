export const VERTEX_SHADER = /* wgsl */`
struct ScreenSize {
    width: f32,
    height: f32,
};

@group(0) @binding(0) var<uniform> screen: ScreenSize;

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) uv: vec2<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let ndcX =  (in.position.x / screen.width)  * 2.0 - 1.0;
    let ndcY = -(in.position.y / screen.height) * 2.0 + 1.0;
    out.clip_position = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
    out.uv = in.uv;
    return out;
}
`;

export const FRAGMENT_SHADER = /* wgsl */`
@group(1) @binding(0) var sprite_texture: texture_2d<f32>;
@group(1) @binding(1) var sprite_sampler: sampler;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    return textureSample(sprite_texture, sprite_sampler, uv);
}
`;
