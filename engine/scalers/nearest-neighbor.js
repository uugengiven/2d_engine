// Scaler interface:
//   constructor(device: GPUDevice, destFormat: GPUTextureFormat)
//   scale(encoder: GPUCommandEncoder, sourceView: GPUTextureView, destView: GPUTextureView): void

const SCALE_VERTEX = /* wgsl */`
struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
    // Fullscreen quad as two triangles, no vertex buffer needed
    var positions = array<vec2<f32>, 6>(
        vec2<f32>(-1.0,  1.0),
        vec2<f32>( 1.0,  1.0),
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 1.0,  1.0),
        vec2<f32>( 1.0, -1.0),
        vec2<f32>(-1.0, -1.0),
    );
    var uvs = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 1.0),
    );

    var out: VertexOutput;
    out.clip_position = vec4<f32>(positions[idx], 0.0, 1.0);
    out.uv = uvs[idx];
    return out;
}
`;

const SCALE_FRAGMENT = /* wgsl */`
@group(0) @binding(0) var src_texture: texture_2d<f32>;
@group(0) @binding(1) var src_sampler: sampler;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    return textureSample(src_texture, src_sampler, uv);
}
`;

export class NearestNeighborScaler {
    /** @type {GPUDevice} */         #device;
    /** @type {GPURenderPipeline} */ #pipeline;
    /** @type {GPUSampler} */        #sampler;
    /** @type {GPUBindGroupLayout} */ #bindGroupLayout;

    /**
     * @param {GPUDevice} device
     * @param {GPUTextureFormat} destFormat  Format of the render target (canvas format)
     */
    constructor(device, destFormat) {
        this.#device = device;

        this.#sampler = device.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
        });

        this.#bindGroupLayout = device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: {},
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: {},
                },
            ],
        });

        this.#pipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({
                bindGroupLayouts: [this.#bindGroupLayout],
            }),
            vertex: {
                module: device.createShaderModule({ code: SCALE_VERTEX }),
                entryPoint: 'vs_main',
            },
            fragment: {
                module: device.createShaderModule({ code: SCALE_FRAGMENT }),
                entryPoint: 'fs_main',
                targets: [{ format: destFormat }],
            },
            primitive: { topology: 'triangle-list' },
        });
    }

    /**
     * Records a scale blit from sourceView into destView.
     * Both views must already be valid for this frame.
     * @param {GPUCommandEncoder} encoder
     * @param {GPUTextureView} sourceView
     * @param {GPUTextureView} destView
     */
    scale(encoder, sourceView, destView) {
        const bindGroup = this.#device.createBindGroup({
            layout: this.#bindGroupLayout,
            entries: [
                { binding: 0, resource: sourceView },
                { binding: 1, resource: this.#sampler },
            ],
        });

        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: destView,
                loadOp: 'clear',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                storeOp: 'store',
            }],
        });

        pass.setPipeline(this.#pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(6);
        pass.end();
    }
}
