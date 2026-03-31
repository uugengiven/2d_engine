/**
 * Factory for creating light objects to pass into backbuffer.layer().
 * All colors are { r, g, b } in 0–255, consistent with the rest of the engine.
 * Positions and radii are in logical pixels.
 */
export const Light = {
    /**
     * Uniform light applied equally to every fragment in the layer.
     * Use as a base brightness so unlit areas aren't pure black.
     * @param {{ r:number, g:number, b:number }} color
     * @param {number} intensity  Multiplier, can exceed 1.0 for overbright
     */
    ambient(color, intensity = 1.0) {
        return {
            type: 'ambient',
            color,
            intensity,
            position:  { x: 0, y: 0 },
            direction: { x: 0, y: 0 },
            radius: 0,
            falloff: 2.0,
        };
    },

    /**
     * Light that radiates from a point, fading over a radius.
     * @param {{ x:number, y:number }} position  Logical pixel position
     * @param {{ r:number, g:number, b:number }} color
     * @param {number} intensity
     * @param {number} radius   Logical pixels to full falloff
     * @param {number} falloff  1=linear, 2=quadratic (default), higher=sharper edge
     * @param {number} height   Z-height above the surface in logical pixels — controls
     *                          how oblique the lighting angle is at the edges of the
     *                          radius. Larger values = more top-down, less side shading.
     *                          Smaller values = more dramatic side shading. Default 50.
     * @param {number} steps    0 = smooth gradient (default). Any other value quantizes
     *                          the light into that many discrete bands, e.g. 4 = four steps.
     */
    point(position, color, intensity, radius, falloff = 2.0, height = 50, steps = 0) {
        return {
            type: 'point',
            color,
            intensity,
            position,
            direction: { x: 0, y: 0 },
            radius,
            falloff,
            height,
            steps,
        };
    },

    /**
     * Directional light from a constant angle across the whole layer.
     * Interacts with normal maps; falls back to ambient-like behavior
     * on sprites without normal maps (flat normal = facing camera).
     * @param {{ x:number, y:number }} direction  Normalized 2D vector, e.g. {x:0, y:1} = from above
     * @param {{ r:number, g:number, b:number }} color
     * @param {number} intensity
     * @param {number} steps    0 = smooth (default), >0 = number of discrete bands
     */
    directional(direction, color, intensity = 1.0, steps = 0) {
        return {
            type: 'directional',
            color,
            intensity,
            position:  { x: 0, y: 0 },
            direction,
            radius: 0,
            falloff: 2.0,
            steps,
        };
    },
};
