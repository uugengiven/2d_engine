# Megan Man — Game Engine Tutorial

## Step 1: Setting Up the Canvas

<!-- Your intro text here — explain what we're building and what this first step covers -->

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

The canvas is displayed at 720×540 but the engine works internally at 240×180 — a classic 4:3 resolution that gives every pixel a nice chunky look. The `Engine.init` call takes the canvas element followed by the internal width and height. This lets us work with our game at our 240x180 no matter what size the game shows up on someone's screen. We currently are telling the canvas to be 720x540 but we could also tell it to be 100% width and height on the screen and it will continue to display with appropriately sized square pixels.

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

---

## Step 3: Showing the Sprite on Screen

<!-- Your intro — explain we're creating a sprite and placing it on screen -->

Inside `main()`, load the image, create a `Texture` from it, then create a `Sprite` and draw it once. The character sprite sheet is a single horizontal row of 27 frames, each 34×35 pixels — passing `cols: 27` to `Texture.create` lets the engine split that row into individually addressable frames.

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
