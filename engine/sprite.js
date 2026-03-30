export class Sprite {
    /** @type {import('./texture.js').Texture} */
    texture;
    /** @type {number} */ x;
    /** @type {number} */ y;
    /** @type {number} */ width;
    /** @type {number} */ height;
    /** @type {number} */ frameIndex;

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
    }
}
