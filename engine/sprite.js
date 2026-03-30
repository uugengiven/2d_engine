export class Sprite {
    /** @type {import('./texture.js').Texture} */
    texture;
    /** @type {number} */ x;
    /** @type {number} */ y;
    /** @type {number} */ width;
    /** @type {number} */ height;
    /** @type {number} */ panelIndex;

    /**
     * @param {import('./texture.js').Texture} texture
     * @param {{ x: number, y: number, width: number, height: number, panelIndex?: number }} options
     */
    constructor(texture, options) {
        this.texture = texture;
        this.x = options.x;
        this.y = options.y;
        this.width = options.width;
        this.height = options.height;
        this.panelIndex = options.panelIndex ?? 0;
    }
}
