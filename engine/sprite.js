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

    /** Flip sprite horizontally (mirrors left/right). @type {boolean} */
    flipX = false;
    /** Flip sprite vertically (mirrors top/bottom). @type {boolean} */
    flipY = false;

    /**
     * Source palette strip (1×N Texture or palette handle from Texture.createPalette).
     * When both paletteSrc and paletteDst are set, the palette-swap pipeline is used.
     * @type {{ id: number, view: GPUTextureView } | null}
     */
    paletteSrc = null;

    /**
     * Destination palette strip — colors that replace the matching source entries.
     * @type {{ id: number, view: GPUTextureView } | null}
     */
    paletteDst = null;

    /**
     * When true, the overlay pipeline is used: vertex color fills the sprite's RGB
     * and the texture alpha provides the shape mask. No lighting is applied.
     * Set all four vertexColors to the desired overlay color before drawing.
     * @type {boolean}
     */
    overlay = false;

    /**
     * Rotation in degrees, clockwise. Sprite is rotated around (pivotX, pivotY).
     * @type {number}
     */
    rotation = 0;

    /**
     * Rotation pivot X in pixels, measured from the sprite's top-left corner.
     * Defaults to horizontal center. Set to 0 for top-left rotation.
     * @type {number}
     */
    pivotX;

    /**
     * Rotation pivot Y in pixels, measured from the sprite's top-left corner.
     * Defaults to vertical center. Set to 0 for top-left rotation.
     * @type {number}
     */
    pivotY;

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
        this.pivotX = options.width / 2;
        this.pivotY = options.height / 2;
    }
}
