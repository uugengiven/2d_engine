# Megan Man — Game Engine Tutorial

This is a mostly step by step tutorial, walking through building a small platform in the vein of Megaman. Mostly this will be used to explain concepts of the engine and how to use it to build out your own games.

## Step 1: Setting Up the Canvas

<!-- Your intro text here — explain what we're building and what this first step covers -->

The graphics portion of the engine run on a website and renders the game to a `<canvas>` element. We can build out our html in any way we like, so long as it includes a canvas element that we can address with something like `document.getElementById`.

Create an `index.html` file with the following structure. We have a border on our canvas to make it visible to you.

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Megan Man</title>
    <style>
        body {
            margin: 0;
            background: #111;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
        }
        canvas {
            border: 2px solid #555;
        }
    </style>
</head>
<body>
    <canvas id="engine" style="width: 720px; height: 540px;"></canvas>
</body>
</html>
```

<!-- Explain the 240×180 internal resolution and why we display it at 3× (720×540) -->

The canvas is displayed at 720×540 but the engine works internally at 240×180 — a 4:3 resolution that has fewer pixels but will expand and give a nice pixel art look. The `Engine.init` call takes the canvas element followed by the internal width and height. This lets us work with our game at our 240x180 no matter what size the game shows up on someone's screen. We currently are telling the canvas to be 720x540 but we could also tell it to be 100% width and height on the screen and it will continue to display with appropriately sized square pixels.

Add the following `<script>` block just before `</body>`:

```html
    <script type="module">
        import { Engine } from '../../engine/engine.js';

        async function main() {
            const canvas = document.getElementById('engine');
            const engine = await Engine.init(canvas, 240, 180);

            engine.backbuffer.clear(30, 20, 40);
            engine.buffer_flip();
        }

        main().catch(console.error);
    </script>
```

<!-- Explain backbuffer.clear (r, g, b) and buffer_flip -->

`clear` takes three values — red, green, and blue — each between 0 and 255. `buffer_flip` pushes everything we drew to the screen. Even when we just want a solid background, we still go through this clear → flip cycle.

**Try it:** change the three numbers in `engine.backbuffer.clear(30, 20, 40)` to any RGB color you like, save the file, and refresh the page. You should see the canvas fill with your chosen color.

<!-- Your closing thoughts for step 1 / lead-in to step 2 -->

---

## Step 2: Loading the Character Sprite

<!-- Your intro — introduce the character sprite sheet and what we're about to do -->
2D games are often built with the idea of sprites. A sprite is like a stamp or sticker that you can put onto the screen. New sprites will get drawn on top of old sprites, so in a game, often you will draw the background first, then the level that the player interacts with, then the player and any enemies, and then finally any score or other UI elements at the end. Each frame of the game is built this way, and like with any 2D animation, if frames are played quickly, in order, they give the appearance of motion. The building blocks of this animation are the texture and sprite.

Add `Texture` and `Sprite` to the import line alongside `Engine`, and add a small `loadImage` helper above `main`. The helper is just a thin promise wrapper around the browser's built-in `Image` — nothing engine-specific.

```js
import { Engine }  from '../../engine/engine.js';
import { Texture } from '../../engine/texture.js';
import { Sprite }  from '../../engine/sprite.js';

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload  = () => resolve(img);
        img.onerror = reject;
        img.src = url;
    });
}
```

<!-- Explain what Texture and Sprite are for -->

A texture is a single picture that represents one or more stickers that a sprite may have. A background may just be a single image. A character might have multiple pictures in the texture: one for the character jumping, one for each frame of animation of the character walking, maybe one for the character giving a big thumbs up. A texture may even be a picture that has each letter of a font in a grid.

The sprite then uses a texture and decides what part of that image is drawn and where on the screen it is drawn each frame. If a texture has 8 images of a character running, a sprite will have a single texture and 8 frames and can choose where on the screen to draw any individual frame. We're going to load up a texture and a sprite so we can being drawing our character on the screen and seeing how textures, sprites, and frames work together.

---

## Step 3: Showing the Sprite on Screen

<!-- Your intro — explain we're creating a sprite and placing it on screen -->

Inside `main()`, load the image, create a `Texture` from it, then create a `Sprite` and draw it once. The character sprite sheet is a grid with 8 columns and 4 rows, each cell being 34×35 pixels — passing `cols: 8, rows: 4` to `Texture.create` lets the engine split the rows into individually addressable frames.

```js
async function main() {
    const canvas = document.getElementById('engine');
    const engine = await Engine.init(canvas, 240, 180);

    const img     = await loadImage('sprites/chibi-robot.png');
    const texture = await Texture.create(engine.device, img, { cols: 8, rows: 4 });

    const player = new Sprite(texture, {
        x:     103,   // (240 - 34) / 2  — centered horizontally
        y:      72,   // (180 - 35) / 2  — centered vertically
        width:  34,
        height: 35,
    });

    engine.backbuffer.clear(30, 20, 40);
    engine.backbuffer.draw(player);
    engine.buffer_flip();
}

main().catch(console.error);
```

<!-- Explain what frame 0 looks like, and invite the reader to try other frames -->

`frameIndex` defaults to `0` — the first frame of the run cycle. Try setting it to other values between 0 and 26 directly on the sprite before the draw call to explore the rest of the sheet:

```js
player.frameIndex = 6; // idle pose
```

---

## Step 4: Looping Through the Frames

<!-- Your intro — explain requestAnimationFrame and the game loop concept -->

Replace the one-shot draw with a loop. `requestAnimationFrame` asks the browser to call your function before the next paint — usually 60 times per second. We advance `frameIndex` by one every call, wrapping back to `0` after frame `5` with the modulo operator.

```js
    function loop() {
        player.frameIndex = (player.frameIndex + 1) % 6;

        engine.backbuffer.clear(30, 20, 40);
        engine.backbuffer.draw(player);
        engine.buffer_flip();

        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
```

<!-- Note that this will be extremely fast — the animation will blur by -->

At 60fps every frame is on screen for only 16ms, so the run cycle will be a near-invisible blur. That's fine — it just proves the loop works. Next step slows it down.

---

## Step 5: Pacing the Animation

<!-- Your intro — explain animation timing vs render timing -->

`requestAnimationFrame` passes the current time in milliseconds into your callback. Comparing that against the last time we changed frames lets us advance the animation on our own schedule while still rendering at full frame rate.

200ms per frame gives us 5fps for the animation — a good match for classic 8-bit character movement.

```js
    const FRAME_MS = 200;
    let lastFrameTime = 0;

    function loop(timestamp) {
        if (timestamp - lastFrameTime >= FRAME_MS) {
            player.frameIndex = (player.frameIndex + 1) % 6;
            lastFrameTime = timestamp;
        }

        engine.backbuffer.clear(30, 20, 40);
        engine.backbuffer.draw(player);
        engine.buffer_flip();

        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
```

<!-- Explain what the reader should be seeing now, and lead into the next step -->

The key insight: the render loop runs every frame at whatever rate the browser offers, but `frameIndex` only increments when 200ms have passed. The two clocks are independent — the engine always gets a fresh frame, and the animation always moves at the right pace regardless of the display's refresh rate.

<!-- Your closing thoughts / lead-in to step 6 -->

---

## Step 6: Moving Left and Right

<!-- Your intro — introduce keyboard input and why we need delta time -->

Add `Input` to the import block at the top:

```js
import { Input } from '../../engine/input.js';
```

Create the input handler right after the engine, inside `main()`:

```js
const input = new Input(canvas, 240, 180);
```

Because Input can handle mouse inputs as well, it needs to know what the internal size of your canvas is. Input can be used independantly from the 2d engine or other aspects, so it needs to have its own width and height setting so it can translate mouse clicks to internal clicks.

Then update the loop. We need to know how much time passed since the last frame (`dt`) so that movement speed stays consistent regardless of framerate — a character moving at 80 pixels/second should cover the same distance at 60fps or 144fps.

```js
const SPEED = 80;
let lastTime     = 0;
let lastFrameTime = 0;

function loop(timestamp) {
    const dt = lastTime === 0 ? 0 : (timestamp - lastTime) / 1000;
    lastTime = timestamp;

    input.update();

    if (input.key('KeyA')) player.x -= SPEED * dt;
    if (input.key('KeyD')) player.x += SPEED * dt;

    if (timestamp - lastFrameTime >= FRAME_MS) {
        player.frameIndex = (player.frameIndex + 1) % 6;
        lastFrameTime = timestamp;
    }

    engine.backbuffer.clear(30, 20, 40);
    engine.backbuffer.draw(player);
    engine.buffer_flip();

    requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
```

<!-- Explain input.update(), input.key(), and that the character can walk off screen -->

`input.update()` snapshots the keyboard state once per frame. `input.key('KeyA')` returns `true` as long as A is held. The character will happily walk off the edges of the screen for now — we'll add bounds later.

---

## Step 7: Facing Direction

<!-- Your intro — flipping the sprite and introducing the concept of facing -->

Add a `facing` variable to track which direction the character is looking — `1` for right, `-1` for left. Update it alongside movement, then set `player.flipX` so the sprite mirrors automatically.

Replace the movement lines with:

```js
let facing = 1;
```

```js
if (input.key('KeyA')) { player.x -= SPEED * dt; facing = -1; }
if (input.key('KeyD')) { player.x += SPEED * dt; facing =  1; }
player.flipX = facing === -1;
```

<!-- Explain flipX and how the sprite sheet faces right by default -->

The sprite sheet has the character facing right, so `flipX = false` is the natural state. Flipping only when `facing` is `-1` means the sprite always faces the direction the player last pressed.

---

## Step 8: Character States

<!-- Your intro — explain what states are and why we want them -->

Replace the hardcoded run-cycle with a proper state table. Each state names the frames that belong to it and the delay between them. Define this above `main()`:

```js
const STATES = {
    idle:  { frames: [6],           frameMs: 200 },
    run:   { frames: [0,1,2,3,4,5], frameMs: 120 },
    jump:  { frames: [7,8],         frameMs: 150 },
    fall:  { frames: [9],           frameMs: 200 },
    shoot: { frames: [10],          frameMs: 200 },
};
const STATE_NAMES = Object.keys(STATES);
```

Inside `main()`, after creating `input`, add the state tracking variables and suppress the browser's default spacebar scroll behavior:

```js
input.preventDefault('Space');

let stateName    = 'run';
let frameInState = 0;
let spaceWasHeld = false;
```

Then replace the old animation block inside `loop` with this:

```js
// Cycle through states with Space
const spaceHeld = input.key('Space');
if (spaceHeld && !spaceWasHeld) {
    const idx = STATE_NAMES.indexOf(stateName);
    stateName    = STATE_NAMES[(idx + 1) % STATE_NAMES.length];
    frameInState = 0;
    lastFrameTime = timestamp;
}
spaceWasHeld = spaceHeld;

// Advance the animation for the current state
const state = STATES[stateName];
if (timestamp - lastFrameTime >= state.frameMs) {
    frameInState = (frameInState + 1) % state.frames.length;
    lastFrameTime = timestamp;
}
player.frameIndex = state.frames[frameInState];
```

<!-- Explain the just-pressed pattern and what the player should be seeing -->

`spaceWasHeld` is how we detect a *fresh* press: the state only cycles when Space is down *this* frame and was up *last* frame. This "current vs previous" pattern is a standard game technique for "just pressed" detection when the input system only exposes a held state.

Press Space to cycle through idle, run, jump, fall, and shoot while A/D still moves the character. Notice each state plays at its own speed.

---

## Step 9: Movement-Driven States

<!-- Your intro — connecting what the player is doing to the character's animation state -->

Now wire the state to actual input instead of the spacebar. Replace the space-bar cycling block with:

```js
const moving   = input.key('KeyA') || input.key('KeyD');
const newState = moving ? 'run' : 'idle';
if (newState !== stateName) {
    stateName    = newState;
    frameInState = 0;
    lastFrameTime = timestamp;
}
```

You can also remove the `input.preventDefault('Space')` call and the `spaceWasHeld` variable since they're no longer needed.

<!-- Explain the state reset on change and lead into jumping -->

Resetting `frameInState` and `lastFrameTime` when the state changes means each new animation always starts from its first frame rather than snapping to wherever the previous one left off. Hold A or D to see the character run, release to see it switch to idle.

<!-- Your closing thoughts / lead-in to the jump steps -->

---

## Step 10: Ground, Gravity, and Clamping

<!-- Your intro — explain we're building up to jumping and need a floor first -->

Define the ground position and starting Y above `main()`:

```js
const GROUND_Y = 150;
```

Update the player's starting position so it begins on the ground:

```js
const player = new Sprite(texture, {
    x:     103,
    y:     GROUND_Y - 35,   // feet at ground level
    width:  34,
    height: 35,
});
```

Add two physics variables inside `main()`:

```js
let vy       = 0;
let onGround = true;
```

Then add gravity and clamping inside the loop, right before the state selection. Apply gravity, move the player vertically, then check if they've hit the floor:

```js
const GRAVITY = 500;

vy += GRAVITY * dt;
player.y += vy * dt;

if (player.y + player.height >= GROUND_Y) {
    player.y = GROUND_Y - player.height;
    vy       = 0;
    onGround = true;
}
```

Finally, draw the ground line using individual pixel draws. Add this between the `clear` and `draw` calls:

```js
for (let x = 0; x < 240; x++) {
    engine.backbuffer.drawPoint(x, GROUND_Y, 80, 160, 80);
}
```

<!-- Explain drawPoint, and that the character will now fall to the ground and stay there if you move them off edge -->

`drawPoint(x, y, r, g, b)` draws a single pixel at the given position. We'll replace this placeholder with real tiles later — for now it just shows us where the floor is.

---

## Step 11: How Jumps Work

<!-- Your main prose section — explain the three dimensions of platformer jumping -->

Different games make very different choices about how jumping feels. It helps to think about three independent knobs:

**Impulse vs thrust**

The simplest jump gives the character an upward velocity all at once — one push, and then gravity takes over. Mega Man works roughly this way. A thrust jump instead keeps adding upward force for as long as the player holds the button, up to some maximum duration. This lets the player "fly" a little rather than just arc. Many modern platformers combine both: a big initial impulse *plus* a short thrust window, so tapping gives a short hop and holding gives a full jump.

**Air control**

Full air control means the character moves left and right in the air exactly as they would on the ground. Reduced air control makes the character feel heavier — you commit more to a jump direction before you leave the ground. Zero air control (like Simon Belmont in the original Castlevania) means once you're airborne, you fly in a fixed arc with no lateral input at all.

**Gravity multiplier**

Applying different gravity depending on whether the character is rising or falling creates jumps that feel intentional rather than floaty. Higher gravity on the way down means the character falls faster than they rose, giving a snappier, more responsive arc. Lowering gravity while the player is still holding the jump button is also how variable-height jumps work — releasing early means the character immediately falls faster, resulting in a shorter hop.

```
tap Space:    short hop  →  full-gravity fall
hold Space:   high arc   →  reduced-gravity rise, then full-gravity fall
```

<!-- Add any additional notes on Sonic, Mario, Mega Man style here -->

---

## Step 12: Basic Jump

<!-- Your intro — wiring up the jump key -->

Add `input.preventDefault('Space')` back inside `main()` to stop the browser scrolling on spacebar. Also add the two variables needed to detect a fresh press and track upward thrust:

```js
input.preventDefault('Space');

let spaceWasHeld = false;
```

Now add the jump initiation block at the top of the loop, before gravity. We use the same "current vs previous" pattern from Step 8 to detect the moment Space is first pressed:

```js
const spaceHeld = input.key('Space');
if (onGround && spaceHeld && !spaceWasHeld) {
    vy       = -220;
    onGround = false;
}
spaceWasHeld = spaceHeld;
```

Update the state selection to include jumping and falling. Replace the two-way `moving ? 'run' : 'idle'` check with:

```js
let newState;
if (!onGround) {
    newState = vy < 0 ? 'jump' : 'fall';
} else {
    newState = moving ? 'run' : 'idle';
}
```

<!-- Describe what the reader should see — character jumps straight up, falls back down, states change correctly -->

The character now jumps, plays the jump animation on the way up, switches to the fall animation at the peak, and lands back in run or idle. Air control is the same as ground control at this point — the character is easy to steer mid-air. We'll tune that next.

---

## Step 13: Jump Feel Variables

<!-- Your intro — converting magic numbers into tunable constants -->

Replace the hardcoded `-220` and `GRAVITY = 500` with a full set of named constants at the top of the script, above `main()`. These are the knobs that define how the jump feels — move them up top so they're easy to find and change.

```js
const GRAVITY          = 500;   // downward acceleration (px/s²)
const JUMP_IMPULSE     = 220;   // initial upward velocity on jump press (px/s)
const THRUST_DURATION  = 0.12;  // seconds extra upward push lasts while Space held
const THRUST_POWER     = 80;    // upward acceleration during thrust window (px/s²)
const AIR_CONTROL      = 0.8;   // fraction of normal horizontal speed while airborne
const JUMP_GRAVITY_MUL = 0.75;  // gravity scale while rising with Space held
const FALL_GRAVITY_MUL = 1.4;   // gravity scale while falling or after releasing Space
```

Update the jump block to use `JUMP_IMPULSE` and start the thrust timer:

```js
if (onGround && spaceHeld && !spaceWasHeld) {
    vy        = -JUMP_IMPULSE;
    jumpTimer =  0;
    onGround  = false;
}
spaceWasHeld = spaceHeld;
```

Add `let jumpTimer = 0;` to the variables inside `main()`.

Add the thrust and gravity multiplier logic right after the jump block, replacing the plain `vy += GRAVITY * dt` line:

```js
// Thrust: extra upward push while Space held within the window
if (!onGround && spaceHeld && jumpTimer < THRUST_DURATION) {
    vy        -= THRUST_POWER * dt;
    jumpTimer += dt;
}

// Gravity: lower while rising with Space held, higher while falling
const gravMul = (vy < 0 && spaceHeld) ? JUMP_GRAVITY_MUL : FALL_GRAVITY_MUL;
vy += GRAVITY * gravMul * dt;
```

Apply air control to horizontal movement by swapping the fixed `SPEED` for a frame-local value:

```js
const hSpeed = SPEED * (onGround ? 1.0 : AIR_CONTROL);
if (input.key('KeyA')) { player.x -= hSpeed * dt; facing = -1; }
if (input.key('KeyD')) { player.x += hSpeed * dt; facing =  1; }
```

Reset `jumpTimer` when the player lands, inside the ground clamp block:

```js
if (player.y + player.height >= GROUND_Y) {
    player.y  = GROUND_Y - player.height;
    vy        = 0;
    onGround  = true;
    jumpTimer = 0;
}
```

<!-- Describe each variable and what changing it does — impulse = jump height, thrust = floatiness at peak, air control = how committed you are mid-jump, gravity muls = snappiness of the arc -->

Tap Space for a short hop, hold it for a full arc. Try adjusting the constants:

- **`JUMP_IMPULSE`** — larger means higher jumps
- **`THRUST_DURATION`** / **`THRUST_POWER`** — longer or stronger thrust makes holding Space feel more impactful
- **`AIR_CONTROL`** — lower values make the character feel heavier in the air
- **`JUMP_GRAVITY_MUL`** — lower means the character floats longer at the top of the arc
- **`FALL_GRAVITY_MUL`** — higher means a faster, snappier descent

<!-- Your closing thoughts / lead-in to the next step -->

---

## Step 14: Looping vs One-Shot Animations

<!-- Your intro — explain the problem: the jump animation loops when it should hold -->

Right now every state loops its frames indefinitely. That works for run and idle, but the jump animation has two frames with different jobs: frame 7 is the launch windup that should play once, and frame 8 is the in-air hold that should stay on screen until the character starts to fall and our fall frame is used. Looping back to frame 7 mid-air looks wrong.

The fix is a `loop` property on each state. States where `loop` is missing or `true` cycle as before; setting it to `false` makes the animation play through and hold on the last frame instead of wrapping.

Update the `STATES` table — only `jump` needs the new property:

```js
const STATES = {
    idle:  { frames: [6],           frameMs: 200 },
    run:   { frames: [0,1,2,3,4,5], frameMs: 120 },
    jump:  { frames: [7,8],         frameMs: 120, loop: false },
    fall:  { frames: [9],           frameMs: 200 },
    shoot: { frames: [10],          frameMs: 200 },
};
```

Then update the one line in the loop that advances the frame index:

```js
// Before
frameInState = (frameInState + 1) % state.frames.length;

// After
frameInState = state.loop === false
    ? Math.min(frameInState + 1, state.frames.length - 1)
    : (frameInState + 1) % state.frames.length;
```

<!-- Explain what each path does — % wraps (loop), Math.min clamps (hold last) -->

The `%` path wraps back to zero — that's the loop. The `Math.min` path increments until it hits the last index and then stays there — that's the hold. Since `frameInState` resets to `0` every time the state changes, the jump animation always replays the windup frame on each new jump even though it only plays once.

<!-- Your closing thoughts / lead-in to the next step -->

---

## Step 15: Sprites vs Game Objects

<!-- Your intro — the conceptual section, mostly prose -->

Everything we've drawn so far has been a `Sprite` — a texture, a position, a frame index, some flip/color/rotation state. That's all a `Sprite` knows about. It has no idea it represents a player, no concept of health or velocity, and no opinion about whether something is allowed to stand on it.

A **game object** is a different idea entirely, and the engine doesn't define it for you. A game object is whatever your game needs it to be — a player, an enemy, a moving platform, a floor tile, a trigger zone that starts a cutscene. It's a plain piece of your own code that *usually* owns a sprite (so it has something to draw) but also carries everything else that has nothing to do with rendering: position, health, current state, AI behavior, timers, whatever the design calls for.

There's no single correct shape for this. Some games bundle a character's sound effects directly onto the player object — `player.sounds.jump.play()`. Others keep audio completely separate, firing events that a dedicated sound manager listens for. Both are valid; the engine has no stake in the decision because `Sprite` and `Texture` only care about pixels, not gameplay.

We're about to build our first real game object: a floor block. Its sprite is simple — one tile, one frame — but the object wrapping it will carry `type`, `solid`, and its own `x`/`y`/`width`/`height`, which is exactly the kind of gameplay data a `Sprite` was never meant to hold.

<!-- Your notes on object composition patterns, ECS, etc. if you want to mention alternatives -->

---

## Step 16: Defining a Floor Block

<!-- Your intro — building the FloorBlock class -->

The tileset described in [README.md](README.md) uses 16×16 tiles. For now we only need one: `ground_a_tc`, frame index `58`, the flat middle-surface tile. Add these constants above `main()`:

```js
const TILE_SIZE   = 16;
const FLOOR_FRAME = 58; // ground_a_tc — the only tile we use for now
```

Then define the `FloorBlock` class itself, also above `main()`. It owns a `Sprite` for drawing, but its other properties — `type`, `solid`, and the position/size pair — exist purely for gameplay code to read later, independent of how the sprite renders:

```js
class FloorBlock {
    constructor(texture, { type, x, y, solid = true }) {
        this.type   = type;
        this.x      = x;
        this.y      = y;
        this.width  = TILE_SIZE;
        this.height = TILE_SIZE;
        this.solid  = solid;

        this.texture = texture;
        this.sprite  = new Sprite(texture, {
            x, y,
            width:  TILE_SIZE,
            height: TILE_SIZE,
            frameIndex: FLOOR_FRAME,
        });
    }

    draw(backbuffer) {
        backbuffer.draw(this.sprite);
    }
}
```

<!-- Explain why texture is shared but sprite is per-instance, and why x/y/width/height live on the block itself rather than only on the sprite -->

The `Texture` is loaded once and shared by every block — it's just pixel data sitting on the GPU. The `Sprite` is cheap to create and is what actually gets drawn, so each block gets its own. Mirroring `x`/`y`/`width`/`height` directly onto the block (rather than only reading them off `block.sprite`) keeps collision and gameplay code from needing to know anything about how a block is drawn — useful later if a block's visual size and its collision size ever need to differ.

---

## Step 17: Placing Floor Tiles

<!-- Your intro — loading the tileset and laying out a test row -->

Load the tileset image the same way we loaded the character sheet. The tileset is a multi-row sheet of 16×16 tiles that has `cols: 9, rows: 10` in the image.

```js
const tilesetImg     = await loadImage('sprites/tileset.png');
const tilesetTexture = await Texture.create(engine.device, tilesetImg, { cols: 9, rows: 10 });
```

Build a short row of blocks sitting at the same height as the placeholder ground line, so you can see them line up:

```js
const floorBlocks = [];
for (let i = 0; i < 6; i++) {
    floorBlocks.push(new FloorBlock(tilesetTexture, {
        type: 'ground_a',
        x: 72 + i * TILE_SIZE,
        y: GROUND_Y,
    }));
}
```

Draw them each frame, right alongside the ground-line points:

```js
for (const block of floorBlocks) block.draw(engine.backbuffer);
```

<!-- Explain that the tiles are purely visual right now and still rely on GROUND_Y for collision, with real collision against blocks coming next -->

The point-line ground is still doing all the collision work — these tiles are purely decorative for now. You should see six floor tiles sitting exactly on top of that line. The next step replaces the flat `GROUND_Y` check with real collision against this array of blocks.

<!-- Your closing thoughts / lead-in to the next step -->

---

## Step 18: Two Ways to Check Collision

<!-- Your intro — mostly conceptual, comparing the two approaches before we build either -->

Physics happens on game objects, not sprites — the same distinction from Step 15, just applied to collision specifically. A `Sprite` doesn't know what shape it is for physics purposes; our `player` and `FloorBlock` objects already carry `x`/`y`/`width`/`height` precisely so something else — our physics code — can reason about where things are in the world, independent of how they're drawn.

There are two common ways to ask "is this thing touching something solid?"

**Rectangle (AABB) overlap**

Treat both objects as axis-aligned boxes and check whether they overlap at all:

```js
function rectsOverlap(a, b) {
    return a.x < b.x + b.width  &&
           a.x + a.width  > b.x &&
           a.y < b.y + b.height &&
           a.y + a.height > b.y;
}
```

One check tells you *that* two boxes are touching, but not *how* — not which side the contact happened on, or how far to push one box back out so they stop overlapping. Recovering that from the overlap alone means comparing how deep the penetration is on each axis and guessing which one mattered, which gets unreliable fast, especially at high speed.

**Ray / point probing**

Instead of comparing two whole rectangles, pick one specific point on your object and ask "is there anything solid exactly here?" Because you chose the point and the direction, you already know what a hit means — a point checked just below the player's feet can only ever mean "the floor is here."

A single ray straight down from the player's center is the simplest version, but it has an obvious blind spot: once the player is more than half off the edge of a platform, the center point is no longer over solid ground at all, and the character falls as if the platform wasn't there — even though most of the sprite is still standing on it.

```
   player sprite, mostly still on the ledge:
   ┌─────────┐
   │ ▓▓▓▓▓▓▓ │
   └────┬────┘
   ▓▓▓▓▓│        ← center ray finds nothing here — false fall
```

Casting two rays instead — one near each edge — fixes that. As long as either edge is still above solid ground, the character is supported. And because each ray independently reports a hit, you immediately know which side it came from, which a rectangle overlap never tells you for free.

<!-- Your thoughts on when you'd reach for rectangles vs rays — e.g. rectangles for hitboxes/triggers, rays for ground/wall checks -->

We'll use rectangle overlap later for things like attack hitboxes, but for ground collision specifically, we're going to build the two-ray approach.

---

## Step 19: Foot Rays

<!-- Your intro — building the two helper functions the floor collision will use -->

Add these two functions inside `main()`, right after `floorBlocks` is created — they read that array, so they need to be in scope where it exists.

`isSolidAt` is the point version of the rectangle check from Step 18 — instead of comparing two rectangles, it checks whether a single point falls inside any solid block:

```js
function isSolidAt(x, y) {
    for (const block of floorBlocks) {
        if (block.solid &&
            x >= block.x && x < block.x + block.width &&
            y >= block.y && y < block.y + block.height) {
            return true;
        }
    }
    return false;
}
```

`checkFoot` is the actual ray. Given an x position and the player's current feet row, it returns one of three answers: the player has sunk into the floor and needs to be pushed up, the player is already resting exactly on a solid surface, or there's nothing below at all:

```js
function checkFoot(x, feetY) {
    if (isSolidAt(x, feetY)) {
        // Already inside the floor — climb back out one pixel at a time
        let y = feetY;
        while (isSolidAt(x, y)) y--;
        return y;
    }
    if (isSolidAt(x, feetY + 1)) {
        return feetY; // resting exactly on the surface, no adjustment needed
    }
    return null; // nothing below — falling
}
```

<!-- Explain the three return paths, and why the climb-out loop matters for fast falls -->

The climb-out loop matters whenever the player moves down more than one pixel in a single frame — fast enough, and they'd land a few pixels inside the floor instead of exactly on top of it. Stepping the ray upward one pixel at a time until it's clear finds exactly how far to push them back out.

---

## Step 20: Replacing the Flat Ground with Real Collision

<!-- Your intro — wiring the foot rays into the player's vertical movement -->

Remove the placeholder ground-line drawing — it implies the floor spans the entire screen, which hasn't been true since `floorBlocks` became only 6 tiles wide:

```js
// Remove this block
for (let x = 0; x < 240; x++) {
    engine.backbuffer.drawPoint(x, GROUND_Y, 80, 160, 80);
}
```

Then replace the flat `GROUND_Y` clamp with two rays, one near each edge of the player. If either ray reports the floor, the player is grounded; if either ray reports penetration, push the player up by whichever ray needs the larger correction:

```js
// Vertical movement
player.y += vy * dt;

// Ground collision via two foot rays near the player's left/right edges
const feetY     = Math.floor(player.y + player.height);
const leftFoot  = checkFoot(player.x + 5, feetY);
const rightFoot = checkFoot(player.x + player.width - 6, feetY);

if (leftFoot !== null || rightFoot !== null) {
    const resolvedFeetY = Math.min(leftFoot ?? feetY, rightFoot ?? feetY);
    player.y  = resolvedFeetY - player.height;
    vy        = 0;
    onGround  = true;
    jumpTimer = 0;
} else {
    onGround = false;
}
```

<!-- Explain the Math.min combination and what the reader should see now: falling off the edges of the 6-tile row -->

`leftFoot ?? feetY` swaps a `null` (nothing below) for the unmodified `feetY`, so a falling ray can never win the `Math.min` comparison and force an incorrect snap — only an actual penetration (a smaller value) or an exact rest (the same value) can. `GROUND_Y` is still used to position the floor tiles and the player's starting spot, but it's no longer read every frame — the blocks themselves are now the only source of truth for where solid ground is. Walk left or right off the row of tiles and the character now falls right off the edge.

<!-- Your closing thoughts / lead-in to the next step -->

---

## Step 21: A Raised Step — and a Gap in Our Collision

<!-- Your intro — adding one more block to poke at what our collision can't do yet -->

Add two extra blocks right after the loop that builds the main row — starting one tile past the end, and one tile higher. Two tiles wide rather than one matters here: the player sprite is 34 pixels wide and the two foot rays from Step 19 sit about 23 pixels apart, so a single 16-pixel-wide tile is narrower than the gap between the rays. Walking across a step that narrow, there's a moment where one ray has already cleared its far edge while the other ray — still over the main floor below — is now checking at the wrong (already-elevated) height and finds nothing either, and the character falls right through what looks like solid ground. A two-tile-wide step (32px) is comfortably wider than the ray spacing, so that gap never opens up:

```js
// A two-tile raised step at the end of the row
for (let i = 0; i < 2; i++) {
    floorBlocks.push(new FloorBlock(tilesetTexture, {
        type: 'ground_a',
        x: 72 + (6 + i) * TILE_SIZE,
        y: GROUND_Y - TILE_SIZE,
    }));
}
```

<!-- Invite the reader to try a few things and observe what happens -->

Try a few things with this in place:

1. Run to the end of the row and jump up onto the raised tile. It should work exactly like landing on any other tile — our foot rays don't care how tall a step is, only whether there's something solid below.
2. Stand on top of it, then walk off either edge. You'll drop straight back down to the main floor's height (or off the end of the world, if you walk off the far side).
3. Now, without jumping, just run straight at it from the main floor. Watch closely as the character reaches the edge.

<!-- Describe what the reader should actually see in step 3 — the character clips up into the bottom of the raised tile for a moment, then falls, because nothing is stopping horizontal movement -->

That third case looks wrong, and it's worth sitting with *why*. Our collision so far only ever asks one question: "is there something solid below my feet?" It never asks "is there something solid immediately to my left or right?" So nothing stops the character from moving sideways into the raised block at all — for an instant you'll see the sprite overlap the bottom corner of the tile before gravity catches up and pulls the character down past it, since there was never any floor at that height to begin with once they cross under the step.

<!-- Lead into the next step — side/wall collision is coming next -->

This is the same kind of gap a single center ray had back in Step 18, just on the other axis: our current setup has no concept of a wall. The next bit of collision work adds exactly that — a check for solid ground immediately beside the player, so walking directly into the side of a block stops the character instead of letting them slide through it.
