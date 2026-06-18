# Basic Info — How the Engine Thinks

<!-- Your intro — the ModeX/SNES heritage, and the idea that this whole doc is about
     the *why* behind the engine's shape, not just the steps to build a game. -->

This engine allows you to treat your graphical space as a piece of graph paper in two dimensions. This allows for an older style of working in graphics and games that are similar to how old arcade, PC, and console games were made in the 8/16 bit eras. The basic concepts of the engine do their best to be as unobtrisive and non-opinionated as possible, other than the following decisions:

* Pixel art is the focus
* Minimal setup required
* Individual parts can be used separately
* It should feel like making games in the 90s, but better

Underneath, there is a 3D engine that takes care of things like polygons, shaders, and floating point math. For the most part, you will not have to think about any of the 3D work happening in the engine. Where that translation leaks through in a way that's worth understanding, this doc calls it out.

---

## Step 1: Canvas and Engine Init

A `<canvas>` element is the only thing the engine needs from your HTML. Everything else — game loop, input, audio — is opt-in.

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Basic Info Demo</title>
    <style>
        body { margin: 0; background: #111; display: flex; justify-content: center; align-items: center; height: 100vh; }
        canvas { border: 2px solid #444; }
    </style>
</head>
<body>
    <canvas id="engine" style="width: 960px; height: 720px;"></canvas>

    <script type="module">
        import { Engine } from './engine/engine.js';

        async function main() {
            const canvas = document.getElementById('engine');
            const engine = await Engine.init(canvas, 320, 240);

            engine.backbuffer.clear(20, 18, 30);
            engine.buffer_flip();
        }

        main().catch(console.error);
    </script>
</body>
</html>
```

`Engine.init(canvas, width, height)` takes a **logical** resolution — here `320×240`, the old DOS ModeX size. Everything you draw is positioned in those 320×240 integer pixels; the canvas is free to be displayed at any CSS size, and the engine upscales with nearest-neighbor sampling to keep hard pixel edges.

`backbuffer.clear(r, g, b)` records the frame's background color, and `buffer_flip()` submits everything queued so far to the GPU and presents it. Nothing actually touches the GPU until `buffer_flip()` runs — `clear()` and `draw()` just record what *should* happen this frame.

<!-- Your notes on why a record-then-flush model rather than immediate drawing -->

### Scaling modes

```js
const engine = await Engine.init(canvas, 320, 240, {
    scaleMode:    'square',  // default — letterbox/pillarbox, preserves square pixels
    integerScale: true,      // snap to whole-number scale factors (2x, 3x, ...)
});
```

Three ways the logical buffer can land on the canvas:

| Mode Descriptions | `scaleMode` | `integerScale` | Result |
|---|---|---|---|
| Fill | `'stretch'` | — | Stretches to the full canvas, ignoring aspect ratio. This can end up with non-square pixels, but the canvas will be filled 100%. |
| Square | `'square'` | `false` (default) | Preserves pixel aspect ratio, letterboxed, fractional scale allowed. Will always fill to either the top/bottom edges or left/right edges. |
| Integer | `'square'` | `true` | Same as square, but scale is always a whole number (2×, 3×…) — no uneven pixels. Will pick the largest integer value that doesn't go beyond the bounds of the canvas. |

<!-- Your notes on why integer scaling matters for pixel art specifically, and when
     you'd reach for stretch vs square -->

---

## Step 2: Loading a Texture, Drawing a Sprite

Two objects do all the work: `Texture` and `Sprite`.

```js
import { Texture } from './engine/texture.js';
import { Sprite }  from './engine/sprite.js';

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload  = () => resolve(img);
        img.onerror = reject;
        img.src = url;
    });
}

const img     = await loadImage('images/monogram-bitmap.png');
const texture = await Texture.create(engine.device, img);

const sprite = new Sprite(texture, {
    x: (320 - 96) / 2, y: (240 - 96) / 2, width: 96, height: 96,
});

engine.backbuffer.clear(20, 18, 30);
engine.backbuffer.draw(sprite);
engine.buffer_flip();
```

<!-- Your notes on the Texture/Sprite split — why pixel data and placement are
     separate objects rather than one combined "image" object -->

A `Texture` owns the actual GPU resource — the decoded pixels, uploaded once. A `Sprite` is a small, cheap, plain object describing *where* and *how* to draw a piece of that texture: position, size, frame, color, rotation. You're meant to create many `Sprite`s from one `Texture`, not the other way around — see Step 4.

`images/monogram-bitmap.png` is a 96×96 bitmap font: 16 columns × 8 rows, each cell 6×12 pixels. Loaded with no `cols`/`rows` options, the whole 96×96 image is treated as a single frame — that's the simplest possible texture, useful here just to prove the load → create → draw path works before we touch the grid.

See `examples/font-image.html` for this running.

### Textures don't have to come from files

`loadImage` above is plain userland code — the engine has no opinion on how you get pixels into memory, only that `Texture.create` receives something the browser can decode. A canvas you've drawn into works exactly the same way, no `Image` round-trip needed:

```js
const circleCanvas = new OffscreenCanvas(64, 64);
const ctx = circleCanvas.getContext('2d');
ctx.fillStyle = '#4fd1ff';
ctx.beginPath();
ctx.arc(32, 32, 28, 0, Math.PI * 2);
ctx.fill();

const circleTexture = await Texture.create(engine.device, circleCanvas);
const circleSprite  = new Sprite(circleTexture, { x: 200, y: 60, width: 64, height: 64 });
```

`circleCanvas` is never appended to the page — it's a pixel scratchpad, not UI. `Texture.create` accepts `HTMLCanvasElement`/`OffscreenCanvas`/`ImageBitmap` directly alongside `HTMLImageElement`, so the canvas goes straight in. An `OffscreenCanvas` starts fully transparent, and anywhere you don't paint stays that way — the alpha carries straight through into the texture, same as the transparent background around the font glyphs.

Here is an example of this plus a few other more involved examples of canvas to texture: `examples/canvas-image.html`.

---

## Step 3: Recoloring with the Overlay Pipeline

The font bitmap is black glyphs on a transparent background. Drawn normally against a dark clear color, it's nearly invisible — there's no light hitting black pixels. That's what `overlay` is for:

```js
sprite.overlay = true;
sprite.vertexColors = [
    { r: 255, g: 210, b: 60, a: 255 },
    { r: 255, g: 210, b: 60, a: 255 },
    { r: 255, g: 210, b: 60, a: 255 },
    { r: 255, g: 210, b: 60, a: 255 },
];
```

<!-- Your notes on why overlay is a separate pipeline rather than a flag on the normal
     one — the fragment shader swap, and "texture alpha as a mask" as a concept -->

With `overlay` on, the texture stops being a picture and becomes a *stencil*: its alpha channel decides shape, and `vertexColors` decides color. No lighting is applied — overlay sprites are flat color, which is exactly what you want for text, UI, and any other case where the source art is just black-and-transparent and the real color is supposed to come from your code.

---

## Step 4: Many Sprites, One Texture

A natural-looking next step is to take one `Sprite`, move it, and draw it again — stamping the same texture across a row in a single frame:

```js
sprite.x = 20;
engine.backbuffer.draw(sprite);
sprite.x = 80;
engine.backbuffer.draw(sprite); // does NOT draw a second stamp at x=80
```

**This doesn't do what it looks like it does.** `backbuffer.draw()` records a *reference* to the sprite object, not a snapshot of its current `x`/`y`/`frameIndex`. Those fields are only read once, when `buffer_flip()` actually builds the frame — by which point `sprite.x` is just whatever it was last set to. The result is every recorded draw rendering at the *same* final position, not five different ones.

The reason behind this is one of the connectors to the 3D/GPU aspect that underpins the engine. It is faster to batch putting a bunch of squares on the screen than asking the video card to do them one at a time, especially if it has to wait for something as slow as javascript to hand it the next sprite over and over. Instead, `draw()` builds up a list of sprites to draw then flip sends them all over at once so your actual drawing to the screen is as fast as possible.

<!-- Your notes on why the engine works this way — the ModeX-style "build the whole
     frame, then flip it" model, and why that pushes toward cheap-Sprite-per-instance -->

The fix is the same shape as Step 2: make a `Sprite` per instance you want on screen, all pointing at the same `Texture`:

```js
const colors = [[255,80,80], [255,170,60], [255,230,80], [120,220,120], [110,170,255]];
const stamps = colors.map(([r, g, b], i) => {
    const s = new Sprite(texture, { x: 20 + i * 60, y: 150, width: 48, height: 48 });
    s.overlay = true;
    s.vertexColors = [{ r, g, b, a: 255 }, { r, g, b, a: 255 }, { r, g, b, a: 255 }, { r, g, b, a: 255 }];
    return s;
});

engine.backbuffer.clear(20, 18, 30);
for (const s of stamps) engine.backbuffer.draw(s);
engine.buffer_flip();
```

Five small `Sprite` objects, one `Texture`, one `clear`/`flip` — see the bottom row of `examples/font-image.html`.

---

## Step 5: Mapping the Texture as a Grid

To draw individual letters instead of the whole sheet, load the same image with `cols`/`rows` so the texture knows how to slice itself into frames:

```js
const texture = await Texture.create(engine.device, img, { cols: 16, rows: 8 });
```

Frames are numbered row-major, left to right then top to bottom — frame `0` is the top-left cell, frame `1` is next to it, frame `16` starts the second row. `monogram-bitmap.png` happens to lay its glyphs out in ASCII order starting at space, so:

- space → frame `0`
- `'A'` → frame `33`
- `'a'` → frame `65`

<!-- Your notes on row-major frame indexing and why it matches how spritesheets are
     conventionally laid out -->

Because the sheet starts at the space character (ASCII code 32) in cell 0, any printable ASCII character's frame is just `charCode - 32` — that's the whole "letter map," not a big lookup table:

```js
// images/monogram-font.js
export const FONT_COLS   = 16;
export const FONT_ROWS   = 8;
export const CELL_WIDTH  = 6;
export const CELL_HEIGHT = 12;

export function charToFrame(ch) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) return 0;
    return code - 32;
}
```

---

## Step 6: Drawing Text with Sprites

Text is just Step 4 again — one `Sprite` per character, all sharing the font `Texture` — with `frameIndex` chosen by `charToFrame` instead of a fixed value:

```js
import { FONT_COLS, FONT_ROWS, CELL_WIDTH, CELL_HEIGHT, charToFrame } from './images/monogram-font.js';

function makeText(texture, text, x, y, cellW, cellH, color) {
    return [...text].map((ch, i) => {
        const sprite = new Sprite(texture, {
            x: x + i * cellW, y, width: cellW, height: cellH,
            frameIndex: charToFrame(ch),
        });
        sprite.overlay = true;
        sprite.vertexColors = [color, color, color, color];
        return sprite;
    });
}

const SCALE = 3;
const cellW = CELL_WIDTH  * SCALE;
const cellH = CELL_HEIGHT * SCALE;
const text  = 'Hello World';
const white = { r: 255, g: 255, b: 255, a: 255 };

const glyphs = makeText(texture, text, (320 - text.length * cellW) / 2, (240 - cellH) / 2, cellW, cellH, white);

engine.backbuffer.clear(20, 18, 30);
for (const g of glyphs) engine.backbuffer.draw(g);
engine.buffer_flip();
```

`makeText` is called once, outside the render loop. `glyphs` is just an array of `Sprite` objects sitting in memory — drawing them again next frame means looping over that same array and calling `backbuffer.draw()` on each, not calling `makeText` again. Rebuilding the array every frame would allocate eleven new `Sprite` objects sixty times a second for text that never changes. Only call `makeText` again when the string itself changes — a score updating, dialogue advancing, that kind of thing.

<!-- Your notes on text rendering being userland, not an engine feature — ties back to
     the README's "doesn't force a paradigm" goal -->

There's no `Text` class in the engine. Drawing "Hello World" is just eleven ordinary `Sprite`s built from one font `Texture` and a one-line index formula — the same primitives as Step 4, doing a different job. See `examples/font-text.html`.

What is important is this isn't the only way to create text and display it. The engine draws sprites on the screen. How you decide to create that list of sprites to draw is up to you. You could create a text object that includes an internal array of sprites. When that array is requested, the text object's x/y screen coordinates are added to all of the individual sprite's internal coordinates that are based on starting at 0,0, so within the game you are creating, you place the text and the object takes care of placing all of its child sprites based on its x/y coordinates.

One important caveat is to try to avoid creating new sprites every frame if those sprites can be created once and reused. For something like enemies or projectiles, sprites are expected to be created here and there within frames. But for something like level tiles or score text, initial sprite creation when these objects are needed and then keeping those sprites alive until that object isn't needed anymore is going to be much faster in JavaScript.

---

## Step 7: Game Loops and Frame Timing

<!-- Your notes — the engine has no opinion on this at all, by design (see the README:
     "without forcing developers to use a specific paradigm... including whether to even
     have a game loop"). Your take on why that's the right call here. -->

Every demo so far has ended with one `clear`/draw/`flip`. A real game needs that to happen continuously, and the browser's tool for that is `requestAnimationFrame`:

```js
function loop(timestamp) {
    // ...update and draw...
    requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
```

`timestamp` is a high-resolution clock value in milliseconds, handed to you fresh on every call — enough to measure how much real time passed between frames without reaching for `Date.now()` or `performance.now()` yourself.

### Measuring delta time

```js
let lastTime = null;

function loop(timestamp) {
    const rawDt = lastTime === null ? 0 : (timestamp - lastTime) / 1000;
    const dt = Math.min(rawDt, 0.1); // clamp — see below
    lastTime = timestamp;

    // ...
    requestAnimationFrame(loop);
}
```

`dt` is seconds since the last frame. The clamp matters: most browsers throttle `requestAnimationFrame` to near-zero or stop it entirely while a tab is hidden. The next frame after the user switches back, `timestamp - lastTime` might be ten real seconds — anything moving at `speed * dt` would teleport across the whole screen in a single frame. Capping `dt` turns a stall into a brief stutter instead of a jump.

### Where requestAnimationFrame doesn't behave like a fixed clock

<!-- Your notes — anything you've personally run into here -->

- **It runs at the display's refresh rate, not a fixed rate.** A 60Hz monitor calls your loop ~60 times a second; a 144Hz monitor calls it ~144 times a second. Code that assumes a frame is always 1/60th of a second runs 2.4× faster in real time on the faster screen.
- **Background tabs get throttled or paused.** Fine for visuals — nobody's watching — but it's exactly where the `dt` clamp above earns its keep.
- **A slow frame anywhere** (garbage collection, a big synchronous function, the OS getting busy) shows up as one large `dt`, not as the game gracefully slowing down. The same clamp helps here too.

### Pixels per second vs. pixels per frame

Two ways to express "this thing moves":

**Pixels per second** — multiply a speed by `dt`:

```js
sprite.x += SPEED * dt; // SPEED is in pixels/second
```

Frame-rate independent — the sprite covers the same real-world distance per second at 60Hz, 144Hz, or mid-stutter. The trade-off: the *exact* amount moved each individual frame varies slightly, since `dt` itself varies frame to frame. At low speeds that can look like an object holding a pixel for two frames and then jumping two at once — the sub-pixel remainder is real and tracked, it just isn't visible until it crosses a whole-pixel boundary (the engine rounds positions down with `Math.floor` before drawing).

**Pixels per frame** — advance by a flat amount every call, no `dt` involved:

```js
sprite.x += SPEED_PER_FRAME; // a flat number, no multiplication by dt
```

This is how NES/SNES-era games worked — no `dt`, game logic ran once per video frame, full stop. Simpler arithmetic, perfectly even motion. The cost is the one above: it's implicitly tied to whatever rate `requestAnimationFrame` actually fires at, which is the display's refresh rate, not a number you control.

If you want frame-based math — the simplicity, the determinism — without tying speed to whatever monitor it happens to run on, decouple the simulation step from the render rate with a fixed-timestep accumulator:

```js
const STEP = 1 / 60; // simulate at a fixed 60Hz no matter the real refresh rate
let accumulator = 0;

function loop(timestamp) {
    const dt = lastTime === null ? 0 : Math.min((timestamp - lastTime) / 1000, 0.1);
    lastTime = timestamp;
    accumulator += dt;

    while (accumulator >= STEP) {
        updateOneFrameWorth(); // update where sprites are, do one "frame" of the game
        accumulator -= STEP;
    }

    draw(); // render every actual display frame, however often that is - this doesn't update sprite locations, only draws
    requestAnimationFrame(loop);
}
```

On a 144Hz display this still runs `updateOneFrameWorth()` roughly 60 times a second, just spread across more, smaller render calls — the same simulation speed a 60Hz display gets, while both render at their own native rate.

<!-- Your notes — when you'd actually reach for the accumulator vs just using dt-scaled
     pixels/second; tradeoffs around input responsiveness/lag with the accumulator pattern -->

`examples/animation-loop.html` puts three shapes side by side built three different ways: a circle whose position is recomputed fresh from elapsed time every frame (orbiting via `sin`/`cos`), a square bouncing at a constant pixels/second velocity that flips sign at the walls (hard-clamped to the boundary so it never overshoots), and a diamond accelerating up to a capped top speed — past each boundary, its driving force flips sign and decelerates it smoothly back around, with no position clamp and no `dt` anywhere in its math.

---

## Step 8: Sprite Manipulation — Rotation, Scaling, Flip, Palette Swap, Tint

Five ways to change how a `Sprite` shows up on screen, none of which touch the underlying `Texture`. All five are visible at once in `examples/sprite-manipulation.html`, built entirely from canvas-drawn shapes (no image files needed for any of it).

### Rotation

```js
sprite.rotation = 45; // degrees, clockwise
```

`rotation` turns the sprite around `pivotX`/`pivotY`, which default to the sprite's own center. Internally, rotation keeps the corners of the sprite locked to the pixel grid, which allows rotation to look closer to pixel art rotation. To have the best control of how rotation looks, it is often better to draw art at specific points and use those frames instead of rotating a sprite, but it is better to have rotation that isn't perfect than not.

To rotate around a corner instead of the center:

```js
sprite.pivotX = 0;
sprite.pivotY = 0;
```

### Scaling

There's no separate "scale" property — `width` and `height` are already independent of the texture's native pixel size:

```js
sprite.width  = 128;
sprite.height = 128;
```

Scaling is done purely with nearest-neighbor sampling, which means it will be a very pixel art/block scaling up and down. This can cause some weirdness when sliding between sizes, but it is the same weirdness you would remember from the 16 bit game era.

### Flip

```js
sprite.flipX = true; // mirror horizontally
sprite.flipY = true; // mirror vertically
```

Flipping swaps which edge of the texture's UV rectangle is read first — no extra geometry, no resampling. It's how one sheet drawn facing right becomes a character that can also face left, as seen back in the Mega Man tutorial.

### Palette Swap

Recolor a sprite by replacing specific colors, not by replacing the whole texture:

```js
const colors  = Texture.extractPalette(sourceImageOrCanvas); // unique opaque colors used
const palSrc  = Texture.createPalette(engine.device, colors);
const palDst  = Texture.createPalette(engine.device, [
    { r: 255, g: 0, b: 0 }, // replaces colors[0]
    { r: 0,   g: 0, b: 255 }, // replaces colors[1]
    // ...
]);

sprite.paletteSrc = palSrc;
sprite.paletteDst = palDst;
```

This is an old technique from the days of having a color palette for any given screen instead of drawing individual colors on each pixel. While you can do way more these days by drawing any color you want anywhere, palette swapping live is still useful if you want to be able to swap character colors without having to make all new art (think Street Fighter 2 character colors or Mario/Luigi) or even have effect animations in one color that can change to other colors as needed by palette swapping, or even palette animation.

Build the destination palettes once and just reassign `paletteDst` to switch between them — no need to call `createPalette` again unless the actual colors change. Every color does not have to be represented, nor do you have to extract the palette using the engine. If you have a complex character with 16 colors, but their outfit only uses 4 colors and you want to have outfit color changes, you only have to supply those 4 original outfit colors, and then the new palette for those colors, not the full 16 colors of the original art.

### Vertex Color Tint (without `overlay`)

Step 3 covered `overlay`, which *replaces* a sprite's color outright (texture alpha becomes a shape mask, vertex color becomes the fill). Without `overlay`, `vertexColors` instead *multiplies* onto whatever the texture already shows:

```js
sprite.vertexColors = [
    { r: 255, g: 120, b: 120, a: 255 },
    { r: 255, g: 120, b: 120, a: 255 },
    { r: 255, g: 120, b: 120, a: 255 },
    { r: 255, g: 120, b: 120, a: 255 },
];
```

This works even with no `Light` defined anywhere — the implicit unlit layer still runs `tex_color * vertexColor` before drawing, it just skips the lighting math entirely when there are zero lights. A white sprite tinted this way shows the tint color exactly; a non-white sprite gets that color filtered through its own. The same property also controls alpha, which is the usual way to fade a sprite in or out.

| | `overlay = true` | normal sprite, `vertexColors` set |
|---|---|---|
| Texture RGB | ignored | kept, multiplied by tint |
| Texture alpha | used as shape mask | used as-is |
| Lighting | never applied | applied if the layer has lights |

---

<!-- Your closing section — the bigger picture: 2D sprites/quads under the hood are
     textured triangles, alpha blending, and a fragment shader; the engine's job is to
     keep that invisible so the mental model stays "stamps on a 2D grid." -->
