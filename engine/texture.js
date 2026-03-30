export class Texture {
    /** @type {GPUTexture} */
    gpuTexture;
    /** @type {GPUTextureView} */
    view;
    /** @type {GPUSampler} */
    sampler;
    /** @type {Array<{u0:number, v0:number, u1:number, v1:number}>} */
    uvTable;

    /**
     * @param {GPUDevice} device
     * @param {ImageBitmap} bitmap
     * @param {{ cols?: number, rows?: number }} options
     */
    constructor(device, bitmap, options = {}) {
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

        this.uvTable = this._buildUVTable(bitmap.width, bitmap.height, cols, rows);
    }

    /**
     * @param {number} frameIndex
     * @returns {{ u0: number, v0: number, u1: number, v1: number }}
     */
    getUVs(frameIndex) {
        return this.uvTable[frameIndex] ?? this.uvTable[0];
    }

    /**
     * @param {number} texWidth
     * @param {number} texHeight
     * @param {number} cols
     * @param {number} rows
     */
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
     * @param {GPUDevice} device
     * @param {HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap} source
     * @param {{ cols?: number, rows?: number }} options
     * @returns {Promise<Texture>}
     */
    static async create(device, source, options = {}) {
        const bitmap = source instanceof ImageBitmap
            ? source
            : await createImageBitmap(source);
        return new Texture(device, bitmap, options);
    }
}
