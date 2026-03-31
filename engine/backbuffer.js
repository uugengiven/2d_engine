export class BackBuffer {
    /** @type {Array<object>} */
    commands = [];

    /**
     * Clears the command list and records the background color for this frame.
     * No GPU work happens here.
     * @param {number} r  Red   0–255 (default 0)
     * @param {number} g  Green 0–255 (default 0)
     * @param {number} b  Blue  0–255 (default 0)
     */
    clear(r = 0, g = 0, b = 0) {
        this.commands = [];
        this.commands.push({
            type: 'clear',
            r: r / 255,
            g: g / 255,
            b: b / 255,
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
}
