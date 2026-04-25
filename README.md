# 2D WebGPU Engine

A lightweight 2D sprite engine built on WebGPU with per-layer lighting, normal maps, palette swapping, and a channel-based audio system.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Textures](#textures)
- [Sprites](#sprites)
- [Drawing & Layers](#drawing--layers)
- [Lighting](#lighting)
- [Audio](#audio)

---

## Getting Started

```js
import { Engine } from './engine/engine.js';

const canvas = document.querySelector('canvas');
const engine = await Engine.init(canvas, 320, 180);

function loop() {
    engine.backbuffer.clear(30, 30, 30);
    // draw things...
    engine.buffer_flip();
    requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
```

`Engine.init(canvas, width, height)` takes a logical resolution — the internal render target is always `width × height` pixels, upscaled to fit the canvas element via the nearest-neighbor scaler. The canvas CSS size drives the output resolution, not the logical size.

---

## Textures

```js
import { Texture } from './engine/texture.js';

// Single image
const tex = await Texture.create(engine.device, imgElement);

// Spritesheet (4 columns, 2 rows = 8 frames)
const sheet = await Texture.create(engine.device, imgElement, { cols: 4, rows: 2 });

// With a normal map
const tex = await Texture.create(engine.device, imgElement, {
    normalMap: normalImgElement,
});

// DirectX-convention normal map (G channel flipped automatically)
const tex = await Texture.create(engine.device, imgElement, {
    normalMap: normalImgElement,
    normalStyle: 'directx',
});
```

The normal map is fully optional. Sprites without one use a flat normal `(0, 0, 1)` — they receive lighting at full face intensity regardless of light direction.

### Palette Swapping

```js
// Extract the unique colors from a sprite image
const colors = Texture.extractPalette(imgElement);

// Build a source palette (original colors) and a destination palette (replacements)
const palSrc = Texture.createPalette(engine.device, colors);
const palDst = Texture.createPalette(engine.device, [
    { r: 255, g: 0, b: 0 },   // replace color[0] with red
    { r: 0, g: 0, b: 255 },   // replace color[1] with blue
    // ...
]);

sprite.paletteSrc = palSrc;
sprite.paletteDst = palDst;
```

Palette swapping happens entirely on the GPU. Assign `paletteSrc` and `paletteDst` to any sprite to activate it; clear both to `null` to revert.

---

## Sprites

```js
import { Sprite } from './engine/sprite.js';

const sprite = new Sprite(tex, { x: 100, y: 50, width: 32, height: 32 });
```

### Properties

| Property | Type | Description |
|---|---|---|
| `x`, `y` | `number` | Position in logical pixels |
| `width`, `height` | `number` | Draw size in logical pixels |
| `frameIndex` | `number` | Frame to display from a spritesheet (0-based, row-major) |
| `flipX` | `boolean` | Mirror horizontally |
| `flipY` | `boolean` | Mirror vertically |
| `rotation` | `number` | Clockwise rotation in degrees |
| `pivotX`, `pivotY` | `number` | Rotation pivot in pixels from top-left (defaults to center) |
| `vertexColors` | `[tl, tr, bl, br]` | Per-corner tint colors `{ r, g, b, a }` in 0–255 |
| `overlay` | `boolean` | When true, vertex color fills RGB and texture alpha masks shape; no lighting applied |
| `paletteSrc` | palette | Source palette for color swapping (see Palette Swapping) |
| `paletteDst` | palette | Destination palette for color swapping |

### Vertex Colors

```js
// Tint the whole sprite red at half-alpha
sprite.vertexColors = [
    { r: 255, g: 0, b: 0, a: 128 },
    { r: 255, g: 0, b: 0, a: 128 },
    { r: 255, g: 0, b: 0, a: 128 },
    { r: 255, g: 0, b: 0, a: 128 },
];

// Gradient — bright top, dark bottom
sprite.vertexColors = [
    { r: 255, g: 255, b: 255, a: 255 }, // top-left
    { r: 255, g: 255, b: 255, a: 255 }, // top-right
    { r: 80,  g: 80,  b: 80,  a: 255 }, // bottom-left
    { r: 80,  g: 80,  b: 80,  a: 255 }, // bottom-right
];
```

---

## Drawing & Layers

All draw calls are recorded into a `BackBuffer` each frame, then submitted to the GPU in one batch when `buffer_flip()` is called.

```js
engine.backbuffer.clear(0, 0, 0);       // background color (r, g, b 0–255)

engine.backbuffer.layer([...lights]);   // start a new lit layer (see Lighting)
engine.backbuffer.draw(sprite);

engine.backbuffer.layer([...lights]);   // second layer composited on top
engine.backbuffer.draw(uiSprite);

engine.buffer_flip();                   // submit everything to GPU, present frame
```

Layers composite in order, each alpha-blending on top of the previous. Sprites drawn before the first `layer()` call land in an implicit unlit layer.

---

## Lighting

```js
import { Light } from './engine/light.js';
```

Pass an array of lights to `backbuffer.layer()`. Each layer has its own independent light set. Sprites without a normal map receive lighting as if they face the camera directly.

### Ambient

```js
// Base fill light — prevents unlit areas from going pure black
Light.ambient({ r: 60, g: 60, b: 80 }, 1.0)
```

### Point

```js
// Torch at position (200, 150), warm orange, radius 120px
Light.point(
    { x: 200, y: 150 },   // position
    { r: 255, g: 160, b: 60 }, // color
    1.5,                   // intensity
    120,                   // radius in logical pixels
    2.0,                   // falloff (1=linear, 2=quadratic)
    50,                    // height above surface — larger = more top-down
    0,                     // steps: 0=smooth, 4=four discrete bands
)
```

### Directional

```js
// Light coming from the top
Light.directional(
    { x: 0, y: 1 },        // direction vector (normalized)
    { r: 255, g: 255, b: 220 },
    1.0,                   // intensity
    0,                     // steps: 0=smooth, >0=cel-shaded bands
)
```

### Example layer setup

```js
engine.backbuffer.layer([
    Light.ambient({ r: 20, g: 20, b: 40 }, 1.0),
    Light.point({ x: player.x, y: player.y }, { r: 255, g: 200, b: 100 }, 2.0, 150),
]);
```

---

## Audio

The audio system is built on the Web Audio API with a channel-based architecture. Channels work like the SNES/Genesis audio routing model — each channel is a stereo processing path that a group of sounds shares. If no channels are defined, a clean default channel is used automatically.

```js
import { AudioManager } from './engine/audio.js';

const audio = new AudioManager();
```

### Zero-Config Usage

```js
const jump = await audio.load('jump.mp3');
jump.play();
```

### Defining Channels

Define channels before loading sounds. Sounds without a channel assigned use the default (full volume, no effects).

```js
audio.createChannel('music',   { volume: 0.8, reverb: 0.35 });
audio.createChannel('sfx',     { volume: 1.0 });
audio.createChannel('menu',    { volume: 1.0 });  // clean, no reverb
audio.createChannel('voice',   { volume: 1.0 });  // fully clean
```

### Channel Options

| Option | Type | Description |
|---|---|---|
| `volume` | `number` | 0–1 channel volume |
| `reverb` | `number` or object | Wet amount 0–1, or `{ wet, duration, decay }` |
| `filter` | `{ cutoff, resonance }` | Low-pass filter — good for muffling SFX through walls |

```js
// Simple reverb — just pass the wet amount
audio.createChannel('music', { reverb: 0.35 });

// Full reverb control
audio.createChannel('cave', {
    reverb: { wet: 0.6, duration: 3.0, decay: 1.5 }
});

// Low-pass filter — sounds behind a door
audio.createChannel('muffled', {
    filter: { cutoff: 800, resonance: 1.0 }
});
```

Reverb is generated synthetically from a decaying noise impulse response — no external IR file needed.

### Loading Sounds

```js
const bgm  = await audio.load('theme.mp3',  { channel: 'music', loop: true });
const jump = await audio.load('jump.mp3',   { channel: 'sfx' });
const coin = await audio.load('coin.wav',   { channel: 'sfx' });
```

Decode happens at load time so `play()` is always immediate.

### Playing Sounds

```js
jump.play();

// Override volume, pan, or pitch for this play call
jump.play({ volume: 0.7, pan: -0.5, pitch: 1.1 });

// Permanent defaults on the sound object
jump.volume = 0.8;
jump.pan    = 0.3;
jump.pitch  = 1.0;
```

| Per-play option | Type | Description |
|---|---|---|
| `volume` | `number` | 0–1, overrides `sound.volume` for this call |
| `pan` | `number` | -1 (left) to 1 (right), 0 = center |
| `pitch` | `number` | Playback rate multiplier — 2.0 = one octave up |

### Playback Control

```js
bgm.play();
bgm.pause();
bgm.resume();
bgm.stop();     // stops and resets to the beginning
```

### State

```js
bgm.playing     // boolean
bgm.currentTime // seconds into playback
bgm.duration    // total duration in seconds
```

### Events

```js
bgm.on('loop', () => {
    console.log('track looped');
});

sfx.on('end', () => {
    // non-looping sound reached its natural end
});

sfx.on('stop', () => {
    // fired on both natural end and explicit stop()
});

// Unsubscribe
sfx.off('end', handler);
```

`'loop'` fires within ~15ms of each loop point. It's accurate enough for UI reactions but not for beat-locked sequencing.

### Modifying a Channel After Creation

`createChannel()` returns the channel, and `getChannel(name)` retrieves it by name at any time:

```js
// Hold the reference at creation
const music = audio.createChannel('music', { volume: 0.8, reverb: 0.35 });
music.volume = 0.5;
music.setReverbWet(0.6);

// Or look it up later
audio.getChannel('music').volume = 0.5;
audio.getChannel('sfx')?.setFilterCutoff(1200);
```

| Channel method | Description |
|---|---|
| `channel.volume` | Get/set channel volume (0–1) |
| `channel.setReverbWet(0–1)` | Adjust reverb wet/dry mix at runtime |
| `channel.setFilterCutoff(hz)` | Adjust low-pass filter cutoff at runtime |

### Master Volume & Latency

```js
audio.volume = 0.8;            // master volume, applied after all channels
audio.baseLatency;             // hardware output latency in seconds (read-only)
```

### Autoplay Policy

Browsers require a user gesture before audio can play. Calling `audio.resume()` explicitly on a click or keydown event eliminates any first-play delay. If not called explicitly, `play()` will resume the audio context automatically on the first call — the delay is typically imperceptible after the first interaction.

```js
document.addEventListener('keydown', () => audio.resume(), { once: true });
```
