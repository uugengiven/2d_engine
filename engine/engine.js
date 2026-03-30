import { VERTEX_SHADER, FRAGMENT_SHADER } from './shaders.js';
import { BackBuffer } from './backbuffer.js';
import { NearestNeighborScaler } from './scalers/nearest-neighbor.js';

export class Engine {
    /** @type {GPUDevice} */
    device;
    /** @type {GPUCanvasContext} */
    context;
    /** @type {GPUTextureFormat} */
    format;
    /** @type {GPURenderPipeline} */
    pipeline;
    /** @type {GPUBuffer} */
    uniformBuffer;
    /** @type {GPUBuffer} */
    vertexBuffer;
    /** @type {GPUBindGroup} */
    frameBindGroup;
    /** @type {GPUBindGroupLayout} */
    spriteBindGroupLayout;
    /** @type {GPUTexture} */
    internalTexture;
    /** @type {GPUTextureView} */
    internalTextureView;
    /** @type {BackBuffer} */
    backbuffer;
    /** @type {{ scale(encoder: GPUCommandEncoder, sourceView: GPUTextureView, destView: GPUTextureView): void }} */
    scaler;
    /** @type {number} */
    width;
    /** @type {number} */
    height;

    /**
     * @param {HTMLCanvasElement} canvas
     * @param {number} width   Logical pixel width (internal render resolution)
     * @param {number} height  Logical pixel height (internal render resolution)
     * @param {{ Scaler?: new(device: GPUDevice, format: GPUTextureFormat) => any }} options
     * @returns {Promise<Engine>}
     */
    static async init(canvas, width, height, options = {}) {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('WebGPU not supported: no adapter found');

        const device = await adapter.requestDevice();
        const context = canvas.getContext('webgpu');
        const format = navigator.gpu.getPreferredCanvasFormat();

        // Canvas CSS/display size is whatever the HTML sets; do not override it here.
        // Internal resolution is tracked separately.
        context.configure({ device, format, alphaMode: 'opaque' });

        const engine = new Engine();
        engine.device = device;
        engine.context = context;
        engine.format = format;
        engine.width = width;
        engine.height = height;
        engine.backbuffer = new BackBuffer();

        // Internal render target at logical resolution
        engine.internalTexture = device.createTexture({
            size: [width, height],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        engine.internalTextureView = engine.internalTexture.createView();

        // Uniform buffer: screenWidth, screenHeight as f32 (padded to 16 bytes)
        engine.uniformBuffer = device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(engine.uniformBuffer, 0, new Float32Array([width, height]));

        // Scratch vertex buffer for one quad: 6 vertices * 4 floats * 4 bytes
        engine.vertexBuffer = device.createBuffer({
            size: 6 * 4 * 4,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });

        engine._buildPipeline();

        const ScalerClass = options.Scaler ?? NearestNeighborScaler;
        engine.scaler = new ScalerClass(device, format);

        return engine;
    }

    _buildPipeline() {
        const { device } = this;

        // Group 0: screen size uniform — bound once per frame
        const frameBindGroupLayout = device.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'uniform' },
            }],
        });

        // Group 1: texture + sampler — bound once per sprite draw
        this.spriteBindGroupLayout = device.createBindGroupLayout({
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

        this.frameBindGroup = device.createBindGroup({
            layout: frameBindGroupLayout,
            entries: [{
                binding: 0,
                resource: { buffer: this.uniformBuffer },
            }],
        });

        this.pipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({
                bindGroupLayouts: [frameBindGroupLayout, this.spriteBindGroupLayout],
            }),
            vertex: {
                module: device.createShaderModule({ code: VERTEX_SHADER }),
                entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: 4 * 4,
                    attributes: [
                        { shaderLocation: 0, offset: 0,     format: 'float32x2' }, // position
                        { shaderLocation: 1, offset: 2 * 4, format: 'float32x2' }, // uv
                    ],
                }],
            },
            fragment: {
                module: device.createShaderModule({ code: FRAGMENT_SHADER }),
                entryPoint: 'fs_main',
                targets: [{
                    format: 'rgba8unorm',
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                    },
                }],
            },
            primitive: { topology: 'triangle-list' },
        });
    }

    /**
     * Flushes all queued commands to the GPU and presents the frame.
     */
    buffer_flip() {
        const { device } = this;
        const commands = this.backbuffer.commands;

        const clearCmd = commands.find(c => c.type === 'clear');
        const clearColor = clearCmd
            ? { r: clearCmd.r, g: clearCmd.g, b: clearCmd.b, a: clearCmd.a }
            : { r: 0, g: 0, b: 0, a: 1 };

        const encoder = device.createCommandEncoder();

        // Pass 1: render all sprites to the internal texture at logical resolution
        const spritePass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.internalTextureView,
                clearValue: clearColor,
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });

        spritePass.setPipeline(this.pipeline);
        spritePass.setBindGroup(0, this.frameBindGroup);

        for (const cmd of commands) {
            if (cmd.type !== 'draw') continue;

            const { sprite } = cmd;
            const { x, y, width, height, texture: tex, frameIndex } = sprite;
            const { u0, v0, u1, v1 } = tex.getUVs(frameIndex);

            // Two triangles (CCW winding) forming a quad
            const verts = new Float32Array([
                x,         y,          u0, v0,  // top-left
                x + width, y,          u1, v0,  // top-right
                x,         y + height, u0, v1,  // bottom-left
                x + width, y,          u1, v0,  // top-right
                x + width, y + height, u1, v1,  // bottom-right
                x,         y + height, u0, v1,  // bottom-left
            ]);

            device.queue.writeBuffer(this.vertexBuffer, 0, verts);

            spritePass.setBindGroup(1, device.createBindGroup({
                layout: this.spriteBindGroupLayout,
                entries: [
                    { binding: 0, resource: tex.view },
                    { binding: 1, resource: tex.sampler },
                ],
            }));

            spritePass.setVertexBuffer(0, this.vertexBuffer);
            spritePass.draw(6);
        }

        spritePass.end();

        // Pass 2: scale the internal texture to the canvas
        const canvasView = this.context.getCurrentTexture().createView();
        this.scaler.scale(encoder, this.internalTextureView, canvasView);

        device.queue.submit([encoder.finish()]);
        this.backbuffer.commands = [];
    }
}
