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
     * Records a sprite draw for this frame.
     * No GPU work happens here.
     * @param {import('./sprite.js').Sprite} sprite
     */
    draw(sprite) {
        this.commands.push({ type: 'draw', sprite });
    }
}
