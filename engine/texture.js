export class Texture {
    static #nextId = 0;

    /** @type {number} Unique ID used for palette bind-group cache keying. */
    id;
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
        this.id = ++Texture.#nextId;
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

    /**
     * Extracts the unique opaque and semi-transparent colors from an image source.
     * Fully transparent pixels (a === 0) are skipped. Useful for building a palette
     * to pass to createPalette().
     *
     * @param {HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap} source
     * @returns {Array<{r:number, g:number, b:number, a:number}>}
     */
    static extractPalette(source) {
        const w = source.naturalWidth  ?? source.width;
        const h = source.naturalHeight ?? source.height;
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(source, 0, 0);
        const { data } = ctx.getImageData(0, 0, w, h);
        const seen = new Set();
        const colors = [];
        for (let i = 0; i < data.length; i += 4) {
            const a = data[i + 3];
            if (a === 0) continue;
            // Pack RGBA into a uint32 for fast deduplication
            const key = ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | a) >>> 0;
            if (!seen.has(key)) {
                seen.add(key);
                colors.push({ r: data[i], g: data[i + 1], b: data[i + 2], a });
            }
        }
        return colors;
    }

    /**
     * Creates a 1×N palette texture from an array of colors. The returned object has
     * the same shape as a Texture (id, view, gpuTexture) and can be assigned directly
     * to sprite.paletteSrc / sprite.paletteDst.
     *
     * @param {GPUDevice} device
     * @param {Array<{r:number, g:number, b:number, a?:number}>} colors
     * @returns {{ id: number, view: GPUTextureView, gpuTexture: GPUTexture }}
     */
    static createPalette(device, colors) {
        const width = colors.length;
        const data  = new Uint8Array(width * 4);
        for (let i = 0; i < colors.length; i++) {
            const c = colors[i];
            data[i * 4 + 0] = c.r;
            data[i * 4 + 1] = c.g;
            data[i * 4 + 2] = c.b;
            data[i * 4 + 3] = c.a ?? 255;
        }
        const gpuTexture = device.createTexture({
            size:   [width, 1],
            format: 'rgba8unorm',
            usage:  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
            { texture: gpuTexture },
            data,
            { bytesPerRow: width * 4 },
            [width, 1],
        );
        return { id: ++Texture.#nextId, view: gpuTexture.createView(), gpuTexture };
    }
}
