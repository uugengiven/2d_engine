export class BackBuffer {
    /** @type {Array<object>} */
    commands = [];

    _lastR = 0;
    _lastG = 0;
    _lastB = 0;

    /**
     * Clears the command list and records the background color for this frame.
     * No GPU work happens here.
     * @param {number} [r]  Red   0–255 (default: last color used, or 0)
     * @param {number} [g]  Green 0–255 (default: last color used, or 0)
     * @param {number} [b]  Blue  0–255 (default: last color used, or 0)
     */
    clear(r, g, b) {
        if (r !== undefined) this._lastR = r;
        if (g !== undefined) this._lastG = g;
        if (b !== undefined) this._lastB = b;

        this.commands = [];
        this.commands.push({
            type: 'clear',
            r: this._lastR / 255,
            g: this._lastG / 255,
            b: this._lastB / 255,
            a: 1.0,
        });
    }

    /**
     * Starts a new layer. All draw() calls after this belong to this layer
     * until the next layer() call or buffer_flip(). Draws before the first
     * layer() call are placed in an implicit unlit layer.
     * @param {Array<object>} lights  Array of Light objects from Light.ambient/point/directional
     */
    layer(lights = []) {
        this.commands.push({ type: 'layer', lights });
    }

    /**
     * Records a sprite draw for this frame.
     * No GPU work happens here.
     * @param {import('./sprite.js').Sprite} sprite
     */
    draw(sprite) {
        this.commands.push({ type: 'draw', sprite });
    }

    /**
     * Records a single pixel draw for this frame.
     * The pixel is affected by the current layer's lighting using a flat normal.
     * No GPU work happens here.
     * @param {number} x  Logical x position
     * @param {number} y  Logical y position
     * @param {number} r  Red   0–255
     * @param {number} g  Green 0–255
     * @param {number} b  Blue  0–255
     * @param {number} a  Alpha 0–255 (default 255)
     */
    drawPoint(x, y, r, g, b, a = 255) {
        this.commands.push({ type: 'point', x, y, r: r / 255, g: g / 255, b: b / 255, a: a / 255 });
    }
}
