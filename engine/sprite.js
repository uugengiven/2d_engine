/** @typedef {{ r: number, g: number, b: number, a: number }} VertexColor */

const WHITE = () => ({ r: 255, g: 255, b: 255, a: 255 });

export class Sprite {
    /** @type {import('./texture.js').Texture} */
    texture;
    /** @type {number} */ x;
    /** @type {number} */ y;
    /** @type {number} */ width;
    /** @type {number} */ height;
    /** @type {number} */ frameIndex;

    /**
     * Per-corner vertex colors in 0–255 range.
     * Order: [topLeft, topRight, bottomLeft, bottomRight]
     * @type {[VertexColor, VertexColor, VertexColor, VertexColor]}
     */
    vertexColors;

    /**
     * @param {import('./texture.js').Texture} texture
     * @param {{ x: number, y: number, width: number, height: number, frameIndex?: number }} options
     */
    constructor(texture, options) {
        this.texture = texture;
        this.x = options.x;
        this.y = options.y;
        this.width = options.width;
        this.height = options.height;
        this.frameIndex = options.frameIndex ?? 0;
        this.vertexColors = [WHITE(), WHITE(), WHITE(), WHITE()];
    }
}
