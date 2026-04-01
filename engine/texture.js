export class Texture {
    /** @type {GPUTexture} */
    gpuTexture;
    /** @type {GPUTextureView} */
    view;
    /** @type {GPUSampler} */
    sampler;
    /** @type {GPUTextureView | null} Normal map view, or null if none was provided */
    normalView;
    /** @type {Array<{u0:number, v0:number, u1:number, v1:number}>} */
    uvTable;

    /**
     * @param {GPUDevice} device
     * @param {ImageBitmap} bitmap
     * @param {ImageBitmap | null} normalBitmap
     * @param {{ cols?: number, rows?: number }} options
     */
    constructor(device, bitmap, normalBitmap, options = {}) {
        const cols = options.cols ?? 1;
        const rows = options.rows ?? 1;

        this.gpuTexture = device.createTexture({
            size: [bitmap.width, bitmap.height],
            format: 'rgba8unorm',
            usage:
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_DST |
                GPUTextureUsage.RENDER_ATTACHMENT,
        });

        device.queue.copyExternalImageToTexture(
            { source: bitmap },
            { texture: this.gpuTexture },
            [bitmap.width, bitmap.height],
        );

        this.view = this.gpuTexture.createView();

        this.sampler = device.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
        });

        if (normalBitmap) {
            const normalTex = device.createTexture({
                size: [normalBitmap.width, normalBitmap.height],
                format: 'rgba8unorm',
                usage:
                    GPUTextureUsage.TEXTURE_BINDING |
                    GPUTextureUsage.COPY_DST |
                    GPUTextureUsage.RENDER_ATTACHMENT,
            });
            device.queue.copyExternalImageToTexture(
                { source: normalBitmap },
                { texture: normalTex },
                [normalBitmap.width, normalBitmap.height],
            );
            this.normalView = normalTex.createView();
        } else {
            this.normalView = null;
        }

        this.uvTable = this._buildUVTable(bitmap.width, bitmap.height, cols, rows);
    }

    /**
     * @param {number} frameIndex
     * @returns {{ u0: number, v0: number, u1: number, v1: number }}
     */
    getUVs(frameIndex) {
        return this.uvTable[frameIndex] ?? this.uvTable[0];
    }

    _buildUVTable(texWidth, texHeight, cols, rows) {
        const panelW = texWidth / cols;
        const panelH = texHeight / rows;
        // Half-texel inset keeps UVs off cell boundaries, preventing the
        // sampler from bleeding into adjacent cells due to floating point error.
        const insetU = 0.5 / texWidth;
        const insetV = 0.5 / texHeight;
        const table = [];

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                table.push({
                    u0: (col * panelW) / texWidth + insetU,
                    v0: (row * panelH) / texHeight + insetV,
                    u1: ((col + 1) * panelW) / texWidth - insetU,
                    v1: ((row + 1) * panelH) / texHeight - insetV,
                });
            }
        }

        return table;
    }

    /**
     * Creates a Texture from any image source the browser can decode.
     * The normal map is fully optional — omitting it or not passing options.normalMap
     * means the engine's shared flat-normal fallback is used automatically.
     *
     * @param {GPUDevice} device
     * @param {HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap} source
     * @param {{ cols?: number, rows?: number, normalMap?: HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap, normalStyle?: 'opengl' | 'directx' }} [options]
     * @returns {Promise<Texture>}
     */
    static async create(device, source, options = {}) {
        const bitmap = source instanceof ImageBitmap
            ? source
            : await createImageBitmap(source);

        let normalBitmap = null;
        if (options.normalMap) {
            normalBitmap = options.normalMap instanceof ImageBitmap
                ? options.normalMap
                : await createImageBitmap(options.normalMap);
            if (options.normalStyle === 'directx') {
                normalBitmap = await Texture.#flipNormalG(normalBitmap);
            }
        }

        return new Texture(device, bitmap, normalBitmap, options);
    }

    // Flips the G channel of a normal map bitmap to convert DirectX → OpenGL convention.
    static async #flipNormalG(bitmap) {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
            data[i + 1] = 255 - data[i + 1];
        }
        ctx.putImageData(imageData, 0, 0);
        return createImageBitmap(canvas);
    }
}
