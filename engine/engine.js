import { VERTEX_SHADER, FRAGMENT_SHADER, PALETTE_FRAGMENT_SHADER, OVERLAY_FRAGMENT_SHADER, POINT_VERTEX_SHADER, POINT_FRAGMENT_SHADER, MAX_LIGHTS, LIGHT_BUFFER_SIZE } from './shaders.js';
import { BackBuffer } from './backbuffer.js';
import { NearestNeighborScaler } from './scalers/nearest-neighbor.js';

const LIGHT_TYPE = { ambient: 0, point: 1, directional: 2 };

// Rotate point (px, py) around center (cx, cy) and snap to the pixel grid.
function _rotatePixel(cx, cy, px, py, cosA, sinA) {
    const dx = px - cx;
    const dy = py - cy;
    return [
        Math.round(cx + dx * cosA - dy * sinA),
        Math.round(cy + dx * sinA + dy * cosA),
    ];
}

// Size in bytes of one Light struct on the GPU (must match WGSL struct)
const LIGHT_STRUCT_BYTES = 64;
// Byte offset of the lights array inside the LightArray uniform
const LIGHTS_ARRAY_OFFSET = 16;

// Vertex buffer layout sizes
const FLOATS_PER_SPRITE = 48; // 6 vertices × 8 floats
const BYTES_PER_SPRITE  = 192;
const FLOATS_PER_POINT  = 6;  // position (2) + color (4)
const BYTES_PER_POINT   = 24;

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
    palettePipeline;
    /** @type {GPURenderPipeline} */
    overlayPipeline;
    /** @type {GPURenderPipeline} */
    pointPipeline;
    /** @type {GPURenderPipeline} */
    compositePipeline;
    /** @type {GPUBuffer} */
    uniformBuffer;
    /** @type {GPUBindGroup} */
    frameBindGroup;
    /** @type {GPUBindGroupLayout} */
    lightBindGroupLayout;
    /** @type {GPUBindGroupLayout} */
    spriteBindGroupLayout;
    /** @type {GPUBindGroupLayout} */
    paletteSpriteBindGroupLayout;
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
    /** @type {Array<{ buffer: GPUBuffer, capacity: number }>} */
    #spriteBufferPool = [];
    /** @type {Array<{ buffer: GPUBuffer, capacity: number }>} */
    #pointBufferPool = [];
    // Sprite bind groups cached by Texture instance — same views/sampler every frame
    /** @type {WeakMap<import('./texture.js').Texture, GPUBindGroup>} */
    #spriteBindGroupCache = new WeakMap();
    // Palette bind groups keyed by "<texId>,<srcId>,<dstId>"
    /** @type {Map<string, GPUBindGroup>} */
    #paletteSpriteBindGroupCache = new Map();

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

        // Group 2 (normal / overlay): diffuse texture, normal texture, sampler
        this.spriteBindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            ],
        });

        // Group 2 (palette): diffuse, normal, sampler + palette_src, palette_dst
        this.paletteSpriteBindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
            ],
        });

        this.frameBindGroup = device.createBindGroup({
            layout: frameBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
        });

        const SPRITE_VERTEX_BUFFERS = [{
            arrayStride: 8 * 4,
            attributes: [
                { shaderLocation: 0, offset: 0,     format: 'float32x2' },
                { shaderLocation: 1, offset: 2 * 4, format: 'float32x2' },
                { shaderLocation: 2, offset: 4 * 4, format: 'float32x4' },
            ],
        }];

        const SPRITE_BLEND = {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
        };

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
                buffers: SPRITE_VERTEX_BUFFERS,
            },
            fragment: {
                module: device.createShaderModule({ code: FRAGMENT_SHADER }),
                entryPoint: 'fs_main',
                targets: [{ format: 'rgba8unorm', blend: SPRITE_BLEND }],
            },
            primitive: { topology: 'triangle-list' },
        });

        const paletteLayout = device.createPipelineLayout({
            bindGroupLayouts: [
                frameBindGroupLayout,
                this.lightBindGroupLayout,
                this.paletteSpriteBindGroupLayout,
            ],
        });

        this.palettePipeline = device.createRenderPipeline({
            layout: paletteLayout,
            vertex: {
                module: device.createShaderModule({ code: VERTEX_SHADER }),
                entryPoint: 'vs_main',
                buffers: SPRITE_VERTEX_BUFFERS,
            },
            fragment: {
                module: device.createShaderModule({ code: PALETTE_FRAGMENT_SHADER }),
                entryPoint: 'fs_main',
                targets: [{ format: 'rgba8unorm', blend: SPRITE_BLEND }],
            },
            primitive: { topology: 'triangle-list' },
        });

        const overlayLayout = device.createPipelineLayout({
            bindGroupLayouts: [
                frameBindGroupLayout,
                this.lightBindGroupLayout,
                this.spriteBindGroupLayout,
            ],
        });

        this.overlayPipeline = device.createRenderPipeline({
            layout: overlayLayout,
            vertex: {
                module: device.createShaderModule({ code: VERTEX_SHADER }),
                entryPoint: 'vs_main',
                buffers: SPRITE_VERTEX_BUFFERS,
            },
            fragment: {
                module: device.createShaderModule({ code: OVERLAY_FRAGMENT_SHADER }),
                entryPoint: 'fs_main',
                targets: [{ format: 'rgba8unorm', blend: SPRITE_BLEND }],
            },
            primitive: { topology: 'triangle-list' },
        });

        // --- Point pipeline ---
        // Draws individual pixels using point-list topology.
        // Uses groups 0 (screen) and 1 (lights) only — no texture needed.

        const POINT_VERTEX_BUFFERS = [{
            arrayStride: 6 * 4,
            attributes: [
                { shaderLocation: 0, offset: 0,     format: 'float32x2' },
                { shaderLocation: 1, offset: 2 * 4, format: 'float32x4' },
            ],
        }];

        this.pointPipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({
                bindGroupLayouts: [frameBindGroupLayout, this.lightBindGroupLayout],
            }),
            vertex: {
                module: device.createShaderModule({ code: POINT_VERTEX_SHADER }),
                entryPoint: 'vs_main',
                buffers: POINT_VERTEX_BUFFERS,
            },
            fragment: {
                module: device.createShaderModule({ code: POINT_FRAGMENT_SHADER }),
                entryPoint: 'fs_main',
                targets: [{ format: 'rgba8unorm', blend: SPRITE_BLEND }],
            },
            primitive: { topology: 'point-list' },
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

    // Returns a per-layer sprite vertex buffer, creating or growing it as needed.
    #getSpriteBuffer(index, minCount) {
        const entry = this.#spriteBufferPool[index];
        if (!entry || entry.capacity < minCount) {
            entry?.buffer.destroy();
            const buffer = this.device.createBuffer({
                size: minCount * BYTES_PER_SPRITE,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            this.#spriteBufferPool[index] = { buffer, capacity: minCount };
            return buffer;
        }
        return entry.buffer;
    }

    // Returns a per-layer point vertex buffer, creating or growing it as needed.
    #getPointBuffer(index, minCount) {
        const entry = this.#pointBufferPool[index];
        if (!entry || entry.capacity < minCount) {
            entry?.buffer.destroy();
            const buffer = this.device.createBuffer({
                size: minCount * BYTES_PER_POINT,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            this.#pointBufferPool[index] = { buffer, capacity: minCount };
            return buffer;
        }
        return entry.buffer;
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

    // Returns a palette sprite bind group, creating and caching it on first use.
    // Keyed by the combined IDs of the diffuse texture, source palette, and dest palette.
    #getPaletteSpriteBindGroup(tex, palSrc, palDst) {
        const key = `${tex.id},${palSrc.id},${palDst.id}`;
        if (!this.#paletteSpriteBindGroupCache.has(key)) {
            const normalView = tex.normalView ?? this.flatNormalView;
            this.#paletteSpriteBindGroupCache.set(key, this.device.createBindGroup({
                layout: this.paletteSpriteBindGroupLayout,
                entries: [
                    { binding: 0, resource: tex.view },
                    { binding: 1, resource: normalView },
                    { binding: 2, resource: this.flatSampler },
                    { binding: 3, resource: palSrc.view },
                    { binding: 4, resource: palDst.view },
                ],
            }));
        }
        return this.#paletteSpriteBindGroupCache.get(key);
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
        // Each layer holds a unified item list preserving submission order.
        const layers = [];
        let current = { lights: [], items: [] };
        for (const cmd of commands) {
            if (cmd.type === 'layer') {
                if (current.items.length > 0) layers.push(current);
                current = { lights: cmd.lights, items: [] };
            } else if (cmd.type === 'draw') {
                current.items.push({ kind: 'sprite', sprite: cmd.sprite });
            } else if (cmd.type === 'point') {
                current.items.push({ kind: 'point', x: cmd.x, y: cmd.y, r: cmd.r, g: cmd.g, b: cmd.b, a: cmd.a });
            }
        }
        if (current.items.length > 0) layers.push(current);

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

            // Count sprites and points so we can size the per-layer vertex buffers.
            let spriteCount = 0;
            let pointCount  = 0;
            for (const item of layer.items) {
                if (item.kind === 'sprite') spriteCount++;
                else if (item.kind === 'point') pointCount++;
            }

            // Get per-layer vertex buffers (each layer has its own so writeBuffer calls
            // from different layers don't clobber each other before GPU execution).
            const spriteBuffer = spriteCount > 0 ? this.#getSpriteBuffer(li, spriteCount) : null;
            const pointBuffer  = pointCount  > 0 ? this.#getPointBuffer(li, pointCount)   : null;

            // Build and upload sprite vertex data.
            if (spriteCount > 0) {
                const allVerts = new Float32Array(spriteCount * FLOATS_PER_SPRITE);
                let si = 0;
                for (const item of layer.items) {
                    if (item.kind !== 'sprite') continue;
                    const sprite = item.sprite;
                    const { x, y, width, height, texture: tex, frameIndex, vertexColors,
                            flipX, flipY, rotation, pivotX, pivotY } = sprite;
                    const px = Math.floor(x);
                    const py = Math.floor(y);

                    let { u0, v0, u1, v1 } = tex.getUVs(frameIndex);
                    if (flipX) { const tmp = u0; u0 = u1; u1 = tmp; }
                    if (flipY) { const tmp = v0; v0 = v1; v1 = tmp; }

                    // Compute corner positions, rotating around the pivot if needed.
                    // Vertex positions are rounded to the nearest pixel so that the
                    // nearest-neighbor sampler lands on whole texels (retro pixel grid).
                    let tlX, tlY, trX, trY, blX, blY, brX, brY;
                    if (rotation) {
                        const rad = rotation * (Math.PI / 180);
                        const cosA = Math.cos(rad);
                        const sinA = Math.sin(rad);
                        const cx = px + pivotX;
                        const cy = py + pivotY;
                        [tlX, tlY] = _rotatePixel(cx, cy, px,         py,          cosA, sinA);
                        [trX, trY] = _rotatePixel(cx, cy, px + width,  py,          cosA, sinA);
                        [blX, blY] = _rotatePixel(cx, cy, px,          py + height, cosA, sinA);
                        [brX, brY] = _rotatePixel(cx, cy, px + width,  py + height, cosA, sinA);
                    } else {
                        tlX = px;         tlY = py;
                        trX = px + width; trY = py;
                        blX = px;         blY = py + height;
                        brX = px + width; brY = py + height;
                    }

                    const [tl, tr, bl, br] = vertexColors.map(c => [
                        c.r / 255, c.g / 255, c.b / 255, c.a / 255,
                    ]);
                    const base = si * FLOATS_PER_SPRITE;
                    allVerts.set([
                        tlX, tlY, u0, v0, ...tl,
                        trX, trY, u1, v0, ...tr,
                        blX, blY, u0, v1, ...bl,
                        trX, trY, u1, v0, ...tr,
                        brX, brY, u1, v1, ...br,
                        blX, blY, u0, v1, ...bl,
                    ], base);
                    si++;
                }
                device.queue.writeBuffer(spriteBuffer, 0, allVerts);
            }

            // Build and upload point vertex data.
            if (pointCount > 0) {
                const allPointVerts = new Float32Array(pointCount * FLOATS_PER_POINT);
                let pi = 0;
                for (const item of layer.items) {
                    if (item.kind !== 'point') continue;
                    allPointVerts.set([item.x, item.y, item.r, item.g, item.b, item.a], pi * FLOATS_PER_POINT);
                    pi++;
                }
                device.queue.writeBuffer(pointBuffer, 0, allPointVerts);
            }

            // Draw sprites first (in submission order), then all points in one draw call.
            let activePipeline = null;
            let spriteCursor   = 0;

            for (const item of layer.items) {
                if (item.kind !== 'sprite') continue;
                const sprite = item.sprite;
                const hasPalette = sprite.paletteSrc && sprite.paletteDst;
                const needed = sprite.overlay ? this.overlayPipeline
                             : hasPalette     ? this.palettePipeline
                             : this.pipeline;

                if (needed !== activePipeline) {
                    pass.setPipeline(needed);
                    pass.setBindGroup(0, this.frameBindGroup);
                    pass.setBindGroup(1, lightBuffer.bindGroup);
                    activePipeline = needed;
                }

                const spriteBindGroup = hasPalette
                    ? this.#getPaletteSpriteBindGroup(sprite.texture, sprite.paletteSrc, sprite.paletteDst)
                    : this.#getSpriteBindGroup(sprite.texture);

                pass.setBindGroup(2, spriteBindGroup);
                pass.setVertexBuffer(0, spriteBuffer, spriteCursor * BYTES_PER_SPRITE, BYTES_PER_SPRITE);
                pass.draw(6);
                spriteCursor++;
            }

            // All points in one draw call — one pipeline switch, one setVertexBuffer, done.
            if (pointCount > 0) {
                pass.setPipeline(this.pointPipeline);
                pass.setBindGroup(0, this.frameBindGroup);
                pass.setBindGroup(1, lightBuffer.bindGroup);
                pass.setVertexBuffer(0, pointBuffer, 0, pointCount * BYTES_PER_POINT);
                pass.draw(pointCount);
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
