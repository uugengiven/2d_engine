# Loading Screens & Level Switching — Engine Tutorial

This tutorial builds a loading screen with a real progress bar, then reuses the
same loading code to swap a "level" out for a different one at runtime —
unloading the old level's texture, music, and instrument along the way.

It assumes you've already been through the [Megan Man tutorial](../meganman/tutorial.md)
or are otherwise comfortable with `Engine`, `Texture`, `Sprite`, and `Input`. We'll
also lean on `AudioManager`, covered in [AUDIO.md](../../AUDIO.md).

See [README.md](README.md) for the four audio files this tutorial needs you to
provide, named exactly as listed there.

## Step 1: Why This Needs Its Own Step

<!-- none — just framing -->

The engine deliberately doesn't have a "loading state." `Texture.create()` takes
an already-decoded image and uploads it to the GPU; `AudioManager.load()` fetches
and decodes a sound. Both are just `Promise`s. There's no built-in concept of "the
game is loading" because that's a UI decision, not a rendering one — every game
wants something different here (a progress bar, a spinner, a fake tip-of-the-day
screen, nothing at all for a tiny game), and baking one choice into the engine
would mean fighting it later for everyone who wanted something else.

So this tutorial is about patterns you write yourself, on top of plain `Promise`s
and a couple of `<div>`s. Nothing here is engine-specific — you could lift the
loading-screen code into a completely different project unchanged.

---

## Step 2: The Stage and the Overlay

Start with the same canvas shell as the Megan Man tutorial, but wrap the canvas
in a positioned container so we have somewhere to put a loading overlay on top
of it:

```html
<div class="stage">
    <canvas id="engine"></canvas>
    <div class="loading" id="loading">
        <div class="loading-label" id="loading-label">Loading…</div>
        <div class="loading-bar"><div class="loading-fill" id="loading-fill"></div></div>
    </div>
</div>
```

```css
.stage {
    position: relative;
    width: 720px;
    height: 540px;
}
canvas {
    border: 2px solid #555;
    width: 100%;
    height: 100%;
}
.loading {
    position: absolute;
    inset: 2px;
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    background: rgba(0, 0, 0, 0.8);
}
.loading-bar  { width: 60%; height: 12px; background: #333; border: 1px solid #555; }
.loading-fill { height: 100%; width: 0%; background: #6c9; }
```

The overlay starts `display: none` and sits directly on top of the canvas via
`position: absolute`. This is the whole loading screen — a `<div>` is genuinely
all you need. There's no requirement to draw a progress bar *inside* the WebGPU
canvas with sprites; the DOM is right there, already knows how to lay out a box
and animate its width, and doesn't need the engine to have finished initializing
before it can show something.

---

## Step 3: Driving the Bar From JavaScript

Three small functions are all the loading screen needs: show it with a label,
update it as bytes arrive, hide it when done.

```js
const loadingEl = document.getElementById('loading');
const labelEl    = document.getElementById('loading-label');
const fillEl     = document.getElementById('loading-fill');
let labelPrefix  = '';

function showLoading(label) {
    labelPrefix = label;
    labelEl.textContent = label;
    fillEl.style.width = '0%';
    loadingEl.style.display = 'flex';
}

function hideLoading() {
    loadingEl.style.display = 'none';
}

function setProgress({ loaded, total }) {
    if (total != null) {
        const pct = Math.min(100, Math.round((loaded / total) * 100));
        fillEl.style.width = pct + '%';
        labelEl.textContent = `${labelPrefix} (${pct}%)`;
    } else {
        fillEl.style.width = '100%';
        labelEl.textContent = `${labelPrefix} (${(loaded / 1024).toFixed(0)} KB)`;
    }
}
```

`setProgress` takes the shape `{ loaded, total }` — bytes downloaded, and bytes
expected. That shape is the actual point of this tutorial: once something can
hand you those two numbers as it works, the bar itself is trivial. The `total ==
null` branch matters more than it looks — it covers a server that doesn't send a
`Content-Length` header, in which case there's no way to know the percentage, so
we show a growing byte count instead of a progress bar that's stuck at a
made-up value.

---

## Step 4: Images Need Their Own Progress Tracking

This is the one place the engine's design choice has a real consequence.
`Texture.create(device, source)` expects `source` to already be a decoded image
— it never touches the network, so it can't report download progress even if it
wanted to. Getting byte-level progress for an image means doing the fetch
yourself:

```js
async function loadImageWithProgress(url, onProgress) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Image load failed (${response.status}): ${url}`);

    if (!onProgress || !response.body) {
        return createImageBitmap(await response.blob());
    }

    const total = Number(response.headers.get('content-length')) || null;
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress({ loaded, total, url });
    }

    return createImageBitmap(new Blob(chunks));
}
```

`response.body` is a `ReadableStream` of raw bytes. Reading it chunk by chunk
instead of calling `response.arrayBuffer()` directly is what makes progress
reporting possible — each chunk that arrives is a chance to report how far along
we are. Once every chunk has arrived, the chunks are reassembled into a `Blob`
and handed to `createImageBitmap()`, which decodes it into something
`Texture.create()` already knows how to accept directly — no `<img>` element
involved at all. (This is also just a more direct way to load an image than the
`new Image(); img.onload = ...` pattern you've seen elsewhere in these
tutorials, if you don't need progress reporting — `createImageBitmap(blob)` skips
the DOM entirely.)

If a request fails partway through, `reader.read()` rejects and the whole
function throws, same as a failed `fetch()` would — there's no special handling
needed for that here.

---

## Step 5: Audio Already Reports Progress

Unlike images, the engine *does* own the fetch for audio — `AudioManager.load()`,
`loadInstrument()`, and `loadSF2()` all do their own `fetch` internally, since
decoding audio has no equivalent of "the dev already has an element with the data
in it." Because of that, they can offer progress reporting directly:

```js
const bgm = await audio.load('sounds/bgm-level1.mp3', {
    channel: 'music',
    loop: true,
    onProgress: ({ loaded, total }) => setProgress({ loaded, total }),
});
```

Same `{ loaded, total }` shape as the image loader above — that's not a
coincidence, it's the same idea applied to both. Internally it streams the
response the same way `loadImageWithProgress` does above, just bundled into the
engine since the fetch already lives there.

---

## Step 6: One Loader for Any Mix of Assets

A real loading screen rarely loads just one thing — it loads a batch, and wants
one progress bar covering the whole batch, not a separate bar per file. That
means aggregating progress across several downloads happening in parallel.

```js
async function loadManifest(device, audio, assetMap, onProgress) {
    const entries = Object.entries(assetMap);
    const state   = entries.map(() => ({ loaded: 0, total: null }));

    const report = () => {
        if (!onProgress) return;
        const loaded = state.reduce((sum, s) => sum + s.loaded, 0);
        const total  = state.every(s => s.total != null)
            ? state.reduce((sum, s) => sum + s.total, 0)
            : null;
        onProgress({ loaded, total });
    };

    const results = {};
    await Promise.all(entries.map(async ([key, desc], i) => {
        const track = p => { state[i] = p; report(); };

        if (desc.type === 'image') {
            const bitmap = await loadImageWithProgress(desc.url, track);
            results[key] = await Texture.create(device, bitmap, desc.options);
        } else if (desc.type === 'sound') {
            results[key] = await audio.load(desc.url, { ...(desc.options ?? {}), onProgress: track });
        } else if (desc.type === 'sf2') {
            results[key] = await audio.loadSF2(desc.url, { onProgress: track });
        }
    }));

    return results;
}
```

Each entry in `assetMap` gets its own slot in `state`. As any one download
reports progress, `report()` re-sums every slot and calls `onProgress` with the
combined total — the caller never has to know how many files were involved or
how big any one of them was. `total` for the whole batch is only a real number
if *every* file's server sent a `Content-Length`; if even one didn't, the
combined total falls back to `null` and the bar shows a byte count instead,
exactly like Step 3 does for a single file. Understating the total would be
worse than not having one — a bar that visibly stalls at 80% looks broken in a
way an honest "growing number" doesn't.

`loadManifest` doesn't know or care whether it's being called once at boot or
again every time the player changes levels — it's the same function either way.
That reuse is the whole reason to write it as a generic manifest loader instead
of one-off loading code per screen.

---

## Step 7: Describing What Each Level Needs

With a generic loader in place, a level becomes data: a plain object naming its
assets, plus whatever non-asset info the game needs about it (here, just the
size to draw the player sprite at).

```js
const SHARED = {
    jumpSfx: { type: 'sound', url: 'sounds/jump.wav' },
};

const LEVELS = {
    1: {
        label: 'Level 1',
        spriteSize: { width: 16, height: 16 },
        assets: {
            player: { type: 'image', url: 'sprites/red_ball.png' },
            bgm:    { type: 'sound', url: 'sounds/bgm-level1.mp3', options: { loop: true, channel: 'music' } },
        },
    },
    2: {
        label: 'Level 2',
        spriteSize: { width: 107, height: 117 }, // native is 214x235 — displayed at half size
        assets: {
            player:    { type: 'image', url: 'sprites/rogue.png' },
            bgm:       { type: 'sound', url: 'sounds/bgm-level2.mp3', options: { loop: true, channel: 'music' } },
            soundfont: { type: 'sf2',   url: 'sounds/generalmidi.sf2' },
        },
    },
};
```

`SHARED` is the split that matters most here: it's loaded once at boot and never
touched again, because nothing about it is level-specific — every level wants the
same jump sound. `LEVELS[n].assets` is the opposite: loaded fresh, and disposed,
every time that level becomes active. Deciding which bucket an asset belongs in
is really asking "does every level need this, or just this one?" — get that
split right and the dispose logic in Step 10 falls out almost for free.

---

## Step 8: Booting the Game

At startup, combine `SHARED` with the first level's assets into a single
manifest so the player sees exactly one loading screen, not two back to back:

```js
async function main() {
    const canvas = document.getElementById('engine');
    const engine = await Engine.init(canvas, 240, 180);
    const input  = new Input(canvas, 240, 180);
    const audio  = new AudioManager();
    audio.createChannel('music', { volume: 0.7 });

    function makeSprite(texture, size) {
        return new Sprite(texture, {
            x: (240 - size.width) / 2,
            y: (180 - size.height) / 2,
            width:  size.width,
            height: size.height,
        });
    }

    function buildLevelState(num, loaded) {
        const instrument = loaded.soundfont
            ? audio.buildSF2Instrument(loaded.soundfont, 0, { channel: 'music' })
            : null;
        loaded.bgm.play();
        return {
            num,
            texture: loaded.player,
            sprite:  makeSprite(loaded.player, LEVELS[num].spriteSize),
            bgm:     loaded.bgm,
            instrument,
        };
    }

    showLoading('Loading…');
    const boot = await loadManifest(engine.device, audio, { ...SHARED, ...LEVELS[1].assets }, setProgress);
    const shared = { jumpSfx: boot.jumpSfx };
    let current = buildLevelState(1, boot);
    hideLoading();

    // ... render loop goes here, added in the next step
}

main().catch(console.error);
```

`buildLevelState` is the bridge between "a bag of loaded assets" and "the state
the render loop actually needs." Building the SF2 instrument with
`buildSF2Instrument` happens here rather than inside `loadManifest` — decoding an
already-fetched SF2 file into zones is synchronous (the bytes are already in
memory, per [AUDIO.md](../../AUDIO.md#sf2-parser)), so it doesn't need a progress
step of its own and doesn't belong in a function whose whole job is tracking
async progress.

If music doesn't start the moment the page loads, click anywhere on the page
first — browsers require a user gesture before audio is allowed to play, which
`Sound.play()` already handles by resuming the `AudioContext` on the next click
or keypress.

---

## Step 9: Switching Levels

Pressing Space loads the *other* level's manifest under its own loading screen,
builds its state, and only then swaps `current` over:

```js
let switching = false;

async function switchLevel() {
    if (switching) return;
    switching = true;
    try {
        shared.jumpSfx.play(); // already loaded — plays instantly, no loading screen needed for this part
        const nextNum = current.num === 1 ? 2 : 1;

        showLoading(`Loading ${LEVELS[nextNum].label}…`);
        const loaded = await loadManifest(engine.device, audio, LEVELS[nextNum].assets, setProgress);
        const next = buildLevelState(nextNum, loaded);
        hideLoading();

        current.bgm.dispose();
        current.texture.dispose();
        current.instrument?.dispose();

        current = next;
    } finally {
        switching = false;
    }
}
```

The `switching` guard exists because `switchLevel` is async and the render loop
keeps running while it's awaited — without it, mashing Space mid-load would kick
off a second `loadManifest` call before the first one finished, racing two
levels' worth of loads against each other.

Note the order: the new level finishes loading *completely* — including
`hideLoading()` — before anything belonging to the old level gets disposed. If
the new level's fetch failed partway through, `current` would still be pointing
at a perfectly valid, still-playing old level. Disposing the old assets first
and loading the new ones second would mean a failed load leaves the player
staring at a disposed texture.

---

## Step 10: Disposing the Old Level

The three lines doing the actual cleanup:

```js
current.bgm.dispose();
current.texture.dispose();
current.instrument?.dispose();
```

`bgm.dispose()` stops the old track and disconnects it — without this, the old
level's music would keep playing under the new level's music forever, since
nothing else ever tells a `Sound` to stop. `texture.dispose()` frees the GPU
memory the old player sprite's image was using. `instrument?.dispose()` only
runs when there was one — Level 1 has no `soundfont` entry, so `loaded.soundfont`
is `undefined` and `buildLevelState` never builds an instrument for it in the
first place.

`shared.jumpSfx` never appears in this list, and that's the point of having
split `SHARED` out in Step 7 — the dispose code only ever touches what's
*actually* level-specific. If you added a third level that also wanted the jump
sound, you wouldn't change this function at all.

This is also a good moment to point at the difference between this and garbage
collection: nothing here is relying on the old `Texture` or `Sound` objects
eventually getting garbage collected once `current` is reassigned. They are
explicitly told to release their resources, immediately, in the same tick the
switch happens. The engine *does* have a GC-based backstop for exactly this
case — see the "Disposing" notes under [Textures](../../README.md#disposing)
and under [Audio](../../README.md#disposing-1) in the README — but that
backstop runs on no particular schedule and exists to catch mistakes, not to be
your actual unload strategy. If you forget to call `dispose()` here, the GPU
memory and audio nodes will eventually get cleaned up *some time* after nothing
references them anymore — possibly much later, possibly under memory pressure,
never on a schedule you can plan a game around.

---

## Step 11: Wiring Up the Render Loop

The last piece — drawing the current level's sprite, and using `F` to prove the
SF2 instrument actually loaded:

```js
input.preventDefault('Space');
input.preventDefault('KeyF');

let spaceWasHeld = false;
let fWasHeld     = false;

function loop() {
    input.update();

    const spaceHeld = input.key('Space');
    if (spaceHeld && !spaceWasHeld) switchLevel();
    spaceWasHeld = spaceHeld;

    const fHeld = input.key('KeyF');
    if (fHeld && !fWasHeld) {
        // Capture the instrument now, not `current.instrument` inside the
        // timeout — if the player switches levels before this fires, that
        // would release a note on whatever instrument is current *then*.
        const instrument = current.instrument;
        instrument?.noteOn(60, 0.8);
        setTimeout(() => instrument?.noteOff(60), 500);
    }
    fWasHeld = fHeld;

    engine.backbuffer.clear(20, 20, 30);
    engine.backbuffer.draw(current.sprite);
    engine.buffer_flip();

    requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
```

`instrument?.noteOn(60, 0.8)` only does anything on Level 2 — on Level 1,
`current.instrument` is `null` and the optional chain just skips the call.
The `setTimeout` releasing the note after 500ms matters more than it looks:
`noteOn` just starts the note playing — nothing stops it on its own. A
synthesized `OscSynth`/`FmSynth` note will eventually finish its envelope's
release phase on its own *only if you call `noteOff`*, and a sampled SF2 zone
with loop points set will literally loop forever without one. A real game
would call `noteOff` when the key is released (the same `held` pattern used for
jumping in the Megan Man tutorial); tapping a key for a *fixed* duration like
this is closer to triggering a sound effect than playing a held note, so a timer
is the more honest fit here.

Press Space a few times and watch the loading screen, the sprite, and the music
all swap together; press F only while on Level 2 to hear a middle-C note played
through whatever the first preset in your `.sf2` file turns out to be.

---

## Where to Go From Here

A few directions worth exploring on your own, now that the core pattern is in
place:

- **Indeterminate progress.** If you're loading from a source that never sends
  `Content-Length` (some CDNs strip it), the byte-count fallback from Step 3 is
  honest but not very satisfying. A looping/marquee bar driven by
  `requestAnimationFrame` instead of real progress is a reasonable fallback —
  just make sure it's visually distinct from the real progress bar so players
  don't mistake one for the other.
- **Preloading ahead of time.** Nothing requires you to wait until the player
  presses Space to start `loadManifest` for the next level — if you can predict
  where the player is headed (the next room through a door, the next song in a
  playlist), kicking off the load early and just awaiting an already-finished
  (or nearly finished) promise when the moment arrives removes the loading
  screen entirely for that transition.
- **Cross-fading instead of a hard cut.** `hideLoading()` here is instant. A
  game with a more atmospheric feel might fade the overlay's opacity out over a
  few hundred milliseconds, or even fade the old level's `bgm` volume down while
  fading the new one up, calling `dispose()` only once the old track is fully
  silent.
- **A canvas-drawn bar instead of a `<div>`.** Nothing about `loadManifest` or
  `setProgress`'s `{ loaded, total }` shape is DOM-specific — if you'd rather
  draw the bar as a sprite or with `backbuffer.drawPoint()`, only `setProgress`
  needs to change, since it's the only place that touches the DOM at all.
