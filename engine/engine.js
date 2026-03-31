import { VERTEX_SHADER, FRAGMENT_SHADER, MAX_LIGHTS, LIGHT_BUFFER_SIZE } from './shaders.js';
import { BackBuffer } from './backbuffer.js';
import { NearestNeighborScaler } from './scalers/nearest-neighbor.js';

const LIGHT_TYPE = { ambient: 0, point: 1, directional: 2 };

// Size in bytes of one Light struct on the GPU (must match WGSL struct)
const LIGHT_STRUCT_BYTES = 64;
// Byte offset of the lights array inside the LightArray uniform
const LIGHTS_ARRAY_OFFSET = 16;

export class Engine {
    /** @type {GPUDevice} */
    device;
    /** @type {GPUCanvasContext} */
    context;
    /** @type {GPUTextureFormat} */
    format;
    /** @type {GPURenderPipeline} */
    pipeline;
    /** @type {GPURenderPipeline} */
    compositePipeline;
    /** @type {GPUBuffer} */
    uniformBuffer;
    /** @type {GPUBuffer} */
    vertexBuffer;
    /** @type {GPUBindGroup} */
    frameBindGroup;
    /** @type {GPUBindGroupLayout} */
    lightBindGroupLayout;
    /** @type {GPUBindGroupLayout} */
    spriteBindGroupLayout;
    /** @type {GPUBindGroupLayout} */
    compositeBindGroupLayout;
    /** @type {GPUTexture} */
    internalTexture;
    /** @type {GPUTextureView} */
    internalTextureView;
    /** @type {GPUTextureView} */
    flatNormalView;
    /** @type {GPUSampler} */
    flatSampler;
    /** @type {BackBuffer} */
    backbuffer;
    /** @type {{ scale(encoder: GPUCommandEncoder, sourceView: GPUTextureView, destView: GPUTextureView): void }} */
    scaler;
    /** @type {number} */
    width;
    /** @type {number} */
    height;

    // Reusable per-frame pools — grown as needed, never shrunk
    /** @type {Array<{ texture: GPUTexture, view: GPUTextureView, compositeBindGroup: GPUBindGroup | null }>} */
    #layerPool = [];
    /** @type {Array<{ buffer: GPUBuffer, bindGroup: GPUBindGroup | null }>} */
    #lightBufferPool = [];
    // Sprite bind groups cached by Texture instance — same views/sampler every frame
    /** @type {WeakMap<import('./texture.js').Texture, GPUBindGroup>} */
    #spriteBindGroupCache = new WeakMap();

    /**
     * @param {HTMLCanvasElement} canvas
     * @param {number} width   Logical pixel width
     * @param {number} height  Logical pixel height
     * @param {{ Scaler?: new(device: GPUDevice, format: GPUTextureFormat) => any }} options
     * @returns {Promise<Engine>}
     */
    static async init(canvas, width, height, options = {}) {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('WebGPU not supported: no adapter found');

        const device = await adapter.requestDevice();
        const context = canvas.getContext('webgpu');
        const format = navigator.gpu.getPreferredCanvasFormat();

        // Sync the canvas pixel buffer to its CSS display size so WebGPU renders
        // at the right resolution and the scaler does a single clean integer upscale.
        // Falls back to the internal resolution if no CSS size is set.
        canvas.width  = canvas.clientWidth  || width;
        canvas.height = canvas.clientHeight || height;

        context.configure({ device, format, alphaMode: 'opaque' });

        const engine = new Engine();
        engine.device = device;
        engine.context = context;
        engine.format = format;
        engine.width = width;
        engine.height = height;
        engine.backbuffer = new BackBuffer();

        // Internal composite target — layers blit into this before scaling
        engine.internalTexture = device.createTexture({
            size: [width, height],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        engine.internalTextureView = engine.internalTexture.createView();

        // 1×1 flat normal texture (128, 128, 255, 255) — the "no normal map" fallback.
        // Decodes to normal (0, 0, 1), which is a surface facing directly at the camera.
        const flatNormalTex = device.createTexture({
            size: [1, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
            { texture: flatNormalTex },
            new Uint8Array([128, 128, 255, 255]),
            { bytesPerRow: 4 },
            [1, 1],
        );
        engine.flatNormalView = flatNormalTex.createView();

        engine.flatSampler = device.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
        });

        // Uniform buffer: screenWidth, screenHeight (padded to 16 bytes)
        engine.uniformBuffer = device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(engine.uniformBuffer, 0, new Float32Array([width, height]));

        // Vertex buffer — sized dynamically at flip time to fit all sprites in a layer
        engine.vertexBuffer = null;
        engine.vertexBufferCapacity = 0; // capacity in number of sprites

        engine._buildPipelines();

        const ScalerClass = options.Scaler ?? NearestNeighborScaler;
        engine.scaler = new ScalerClass(device, format);

        return engine;
    }

    _buildPipelines() {
        const { device } = this;

        // --- Sprite pipeline bind group layouts ---

        // Group 0: screen size uniform
        const frameBindGroupLayout = device.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'uniform' },
            }],
        });

        // Group 1: light array uniform
        this.lightBindGroupLayout = device.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' },
            }],
        });

        // Group 2: diffuse texture, normal texture, sampler
        this.spriteBindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            ],
        });

        this.frameBindGroup = device.createBindGroup({
            layout: frameBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
        });

        this.pipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({
                bindGroupLayouts: [
                    frameBindGroupLayout,
                    this.lightBindGroupLayout,
                    this.spriteBindGroupLayout,
                ],
            }),
            vertex: {
                module: device.createShaderModule({ code: VERTEX_SHADER }),
                entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: 8 * 4,
                    attributes: [
                        { shaderLocation: 0, offset: 0,     format: 'float32x2' }, // position
                        { shaderLocation: 1, offset: 2 * 4, format: 'float32x2' }, // uv
                        { shaderLocation: 2, offset: 4 * 4, format: 'float32x4' }, // color
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

        // --- Composite pipeline ---
        // Blends layer textures in order onto the internal texture.

        const COMPOSITE_VERT = /* wgsl */`
        struct VertexOutput {
            @builtin(position) pos: vec4<f32>,
            @location(0) uv: vec2<f32>,
        };
        @vertex fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
            var positions = array<vec2<f32>, 6>(
                vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0,  1.0), vec2<f32>(-1.0, -1.0),
                vec2<f32>( 1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0, -1.0),
            );
            var uvs = array<vec2<f32>, 6>(
                vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
                vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0),
            );
            var out: VertexOutput;
            out.pos = vec4<f32>(positions[idx], 0.0, 1.0);
            out.uv = uvs[idx];
            return out;
        }`;

        const COMPOSITE_FRAG = /* wgsl */`
        @group(0) @binding(0) var src: texture_2d<f32>;
        @group(0) @binding(1) var src_sampler: sampler;
        @fragment fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
            return textureSample(src, src_sampler, uv);
        }`;

        this.compositeBindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            ],
        });

        this.compositePipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({
                bindGroupLayouts: [this.compositeBindGroupLayout],
            }),
            vertex: {
                module: device.createShaderModule({ code: COMPOSITE_VERT }),
                entryPoint: 'vs_main',
            },
            fragment: {
                module: device.createShaderModule({ code: COMPOSITE_FRAG }),
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

    // Returns a layer pool entry, creating one if needed.
    // compositeBindGroup is lazily created once and reused every frame.
    #getLayerTexture(index) {
        if (!this.#layerPool[index]) {
            const texture = this.device.createTexture({
                size: [this.width, this.height],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
            });
            const view = texture.createView();
            const compositeBindGroup = this.device.createBindGroup({
                layout: this.compositeBindGroupLayout,
                entries: [
                    { binding: 0, resource: view },
                    { binding: 1, resource: this.flatSampler },
                ],
            });
            this.#layerPool[index] = { texture, view, compositeBindGroup };
        }
        return this.#layerPool[index];
    }

    // Returns a light buffer pool entry, creating one if needed.
    // bindGroup is created once against the stable buffer and reused every frame.
    #getLightBuffer(index) {
        if (!this.#lightBufferPool[index]) {
            const buffer = this.device.createBuffer({
                size: LIGHT_BUFFER_SIZE,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            const bindGroup = this.device.createBindGroup({
                layout: this.lightBindGroupLayout,
                entries: [{ binding: 0, resource: { buffer } }],
            });
            this.#lightBufferPool[index] = { buffer, bindGroup };
        }
        return this.#lightBufferPool[index];
    }

    // Returns a sprite bind group for a texture, creating and caching it on first use.
    #getSpriteBindGroup(tex) {
        if (!this.#spriteBindGroupCache.has(tex)) {
            const normalView = tex.normalView ?? this.flatNormalView;
            this.#spriteBindGroupCache.set(tex, this.device.createBindGroup({
                layout: this.spriteBindGroupLayout,
                entries: [
                    { binding: 0, resource: tex.view },
                    { binding: 1, resource: normalView },
                    { binding: 2, resource: this.flatSampler },
                ],
            }));
        }
        return this.#spriteBindGroupCache.get(tex);
    }

    // Writes a light array into a uniform buffer.
    #writeLightBuffer(buffer, lights) {
        const count = Math.min(lights.length, MAX_LIGHTS);
        // Write count into the 16-byte header
        this.device.queue.writeBuffer(buffer, 0, new Uint32Array([count]));

        if (count === 0) return;

        const data = new ArrayBuffer(count * LIGHT_STRUCT_BYTES);
        const f32 = new Float32Array(data);
        const u32 = new Uint32Array(data);

        for (let i = 0; i < count; i++) {
            const light = lights[i];
            const base = i * (LIGHT_STRUCT_BYTES / 4); // index into f32 view
            f32[base + 0] = light.position.x;
            f32[base + 1] = light.position.y;
            f32[base + 2] = light.direction.x;
            f32[base + 3] = light.direction.y;
            f32[base + 4] = light.color.r / 255;
            f32[base + 5] = light.color.g / 255;
            f32[base + 6] = light.color.b / 255;
            f32[base + 7] = light.intensity;
            f32[base + 8] = light.radius;
            f32[base + 9] = light.falloff;
            u32[base + 10] = LIGHT_TYPE[light.type] ?? 0;
            f32[base + 11] = light.height ?? 50;
            f32[base + 12] = light.steps ?? 0;
            // base + 13, 14, 15 are padding
        }

        this.device.queue.writeBuffer(buffer, LIGHTS_ARRAY_OFFSET, data);
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

        // Split command list into layers.
        // Draws before the first layer() are an implicit unlit layer.
        const layers = [];
        let current = { lights: [], draws: [] };
        for (const cmd of commands) {
            if (cmd.type === 'layer') {
                if (current.draws.length > 0) layers.push(current);
                current = { lights: cmd.lights, draws: [] };
            } else if (cmd.type === 'draw') {
                current.draws.push(cmd.sprite);
            }
        }
        if (current.draws.length > 0) layers.push(current);

        const encoder = device.createCommandEncoder();

        // Render each layer into its own pooled texture
        for (let li = 0; li < layers.length; li++) {
            const layer = layers[li];
            const layerTex = this.#getLayerTexture(li);
            const lightBuffer = this.#getLightBuffer(li);

            this.#writeLightBuffer(lightBuffer.buffer, layer.lights);

            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: layerTex.view,
                    clearValue: { r: 0, g: 0, b: 0, a: 0 }, // transparent — composited later
                    loadOp: 'clear',
                    storeOp: 'store',
                }],
            });

            // Build all vertex data for this layer into one array before the pass.
            // Each sprite is 6 vertices × 8 floats = 48 floats = 192 bytes.
            const FLOATS_PER_SPRITE = 6 * 8;
            const BYTES_PER_SPRITE  = FLOATS_PER_SPRITE * 4;
            const spriteCount = layer.draws.length;

            // Grow the vertex buffer if this layer has more sprites than it can hold.
            if (spriteCount > this.vertexBufferCapacity) {
                this.vertexBuffer?.destroy();
                this.vertexBuffer = device.createBuffer({
                    size: spriteCount * BYTES_PER_SPRITE,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
                this.vertexBufferCapacity = spriteCount;
            }

            const allVerts = new Float32Array(spriteCount * FLOATS_PER_SPRITE);
            for (let si = 0; si < spriteCount; si++) {
                const sprite = layer.draws[si];
                const { x, y, width, height, texture: tex, frameIndex, vertexColors } = sprite;
                const { u0, v0, u1, v1 } = tex.getUVs(frameIndex);
                const [tl, tr, bl, br] = vertexColors.map(c => [
                    c.r / 255, c.g / 255, c.b / 255, c.a / 255,
                ]);
                const base = si * FLOATS_PER_SPRITE;
                allVerts.set([
                    x,         y,          u0, v0, ...tl,
                    x + width, y,          u1, v0, ...tr,
                    x,         y + height, u0, v1, ...bl,
                    x + width, y,          u1, v0, ...tr,
                    x + width, y + height, u1, v1, ...br,
                    x,         y + height, u0, v1, ...bl,
                ], base);
            }
            device.queue.writeBuffer(this.vertexBuffer, 0, allVerts);

            pass.setPipeline(this.pipeline);
            pass.setBindGroup(0, this.frameBindGroup);
            pass.setBindGroup(1, lightBuffer.bindGroup);

            for (let si = 0; si < spriteCount; si++) {
                const sprite = layer.draws[si];
                pass.setBindGroup(2, this.#getSpriteBindGroup(sprite.texture));
                pass.setVertexBuffer(0, this.vertexBuffer, si * BYTES_PER_SPRITE, BYTES_PER_SPRITE);
                pass.draw(6);
            }

            pass.end();
        }

        // Composite all layer textures onto the internal texture in order.
        // First layer clears the internal texture; subsequent layers alpha-blend on top.
        for (let li = 0; li < layers.length; li++) {
            const layerTex = this.#getLayerTexture(li);

            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: this.internalTextureView,
                    clearValue: clearColor,
                    loadOp: li === 0 ? 'clear' : 'load',
                    storeOp: 'store',
                }],
            });

            pass.setPipeline(this.compositePipeline);
            pass.setBindGroup(0, layerTex.compositeBindGroup);
            pass.draw(6);
            pass.end();
        }

        // Scale the composited internal texture to the canvas
        const canvasView = this.context.getCurrentTexture().createView();
        this.scaler.scale(encoder, this.internalTextureView, canvasView);

        device.queue.submit([encoder.finish()]);
        this.backbuffer.commands = [];
    }
}
