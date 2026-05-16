# Audio System

The engine audio stack has three layers that compose cleanly:

| Layer | Class | Purpose |
|---|---|---|
| Infrastructure | `AudioManager` | Context, channels, loading |
| Synthesis | `OscSynth` | Synthesized instruments (NES/SNES style) |
| Sequencing | `Sequencer` | Pattern-based music scheduling |

Sample playback (`Sound`) is also available for pre-recorded audio files.

---

## Quick Start

```js
import { AudioManager } from './engine/audio.js';
import { Sequencer }    from './engine/sequencer.js';

const audio = new AudioManager();

// Call once from a user gesture (click, keydown) to unlock audio
await audio.resume();

// Load a synthesized instrument
const lead = await audio.loadInstrument('instruments/nes-pulse-25.json');

// Trigger notes directly
lead.noteOn(60, 0.8);   // middle C, velocity 0.8
lead.noteOff(60);
```

---

## AudioManager

```js
const audio = new AudioManager();
```

### Channels

Channels are named audio buses with per-channel volume, filter, and reverb. Create them before loading sounds.

```js
audio.createChannel('music', { volume: 0.8, reverb: 0.3 });
audio.createChannel('sfx',   { volume: 1.0 });
audio.createChannel('voice', { volume: 1.0 }); // clean, no effects
```

**Channel options:**

| Option | Type | Description |
|---|---|---|
| `volume` | `number` 0–1 | Channel level |
| `filter` | `{ cutoff: hz, resonance: Q }` | Lowpass biquad filter |
| `reverb` | `number` or `{ wet, duration, decay }` | Convolution reverb. Number = wet mix. |

Channels route into a shared master compressor → master gain → output.

**Runtime control:**

```js
const ch = audio.getChannel('music');
ch.volume = 0.5;
ch.setFilterCutoff(2000);   // hz
ch.setReverbWet(0.4);       // 0–1
```

### Sample playback

```js
const bgm  = await audio.load('sounds/theme.mp3', { channel: 'music', loop: true });
const jump = await audio.load('sounds/jump.wav',  { channel: 'sfx' });

bgm.play();
jump.play({ pitch: 1.2 });   // play at 1.2× speed (roughly a major third up)
bgm.pause();
bgm.resume();
bgm.stop();

// Events
jump.on('end',  s => console.log('finished'));
jump.on('stop', s => console.log('stopped for any reason'));
bgm.on('loop',  s => console.log('looped (±15ms)'));
```

**Sound options at load or play time:**

| Option | Description |
|---|---|
| `volume` | 0–1 |
| `pan` | -1 (left) to 1 (right) |
| `pitch` | Playback rate multiplier. 2.0 = one octave up. |
| `loop` | Boolean |

### Master volume

```js
audio.volume = 0.7;          // get/set master gain
audio.baseLatency;           // hardware latency in seconds (useful for AV sync)
audio.context;               // raw AudioContext (for advanced use / Sequencer)
```

---

## OscSynth

Synthesized instruments built from Web Audio oscillators. Each instrument definition is a JSON file.

```js
const lead  = await audio.loadInstrument('instruments/nes-pulse-25.json', { channel: 'sfx' });
const bass  = await audio.loadInstrument('instruments/nes-triangle.json', { channel: 'music' });

// Override voice count at load time (JSON value is the designer's recommendation)
const poly  = await audio.loadInstrument('instruments/fat-triangle.json', { channel: 'music', voices: 6 });
```

### API

```js
lead.noteOn(60, 0.8);           // midiNote, velocity (0–1)
lead.noteOn(60, 0.8, when);     // with AudioContext timestamp for precise scheduling
lead.noteOff(60);               // trigger release envelope
lead.allNotesOff();             // release all playing voices (call on stop/pause)

lead.name;                      // instrument name from JSON
lead.voiceCount;                // number of voices in the pool
```

**MIDI note numbers:** Middle C = 60. `note = 12 * (octave + 1) + semitone`. A4 = 69 = 440 Hz.

### Voice stealing

Each instrument has its own voice pool — voices are never shared between instruments, so a chord swell on strings can never steal the bass note.

| `stealPolicy` | Behaviour |
|---|---|
| `"oldest"` | Steal the voice that has been playing longest |
| `"current"` | Steal own current voice (natural mono behaviour) |
| `"none"` | Drop the new note if all voices are busy |

---

## Instrument JSON Format

```json
{
  "type": "osc",
  "name": "NES Pulse 25%",
  "version": "1.0",

  "voices": 3,
  "stealPolicy": "oldest",
  "portamento": 0,
  "pitchBendRange": 2,
  "volume": 1.0,

  "oscillators": [
    {
      "waveform": "square",
      "dutyCycle": 0.25,
      "detune": 0,
      "semitones": 0,
      "level": 1.0
    }
  ],

  "envelope": {
    "attack":  0.002,
    "decay":   0.06,
    "sustain": 0.80,
    "decay2":  0.0,
    "release": 0.03
  },

  "lfos": []
}
```

### Oscillator fields

| Field | Values | Description |
|---|---|---|
| `waveform` | `"square"`, `"triangle"`, `"sawtooth"`, `"sine"`, `"noise"` | Wave shape |
| `dutyCycle` | 0.125, 0.25, 0.5, 0.75 | Pulse width for `"square"` only |
| `noiseType` | `"lfsr"`, `"white"` | Noise character. `"lfsr"` = NES-authentic. |
| `detune` | cents | Fine pitch offset (±100 = one semitone). Use small values (±5–20) for a fat/chorus effect. |
| `semitones` | integer | Coarse pitch offset. 7 = perfect fifth, 12 = octave. Use to embed harmony into a single instrument. |
| `level` | 0–1 | This oscillator's mix contribution. When stacking multiple oscillators, scale levels so they sum to roughly 1.0. |

### Envelope fields

All times in seconds.

| Field | Description |
|---|---|
| `attack` | Time from note-on to peak |
| `decay` | Time from peak down to sustain level |
| `sustain` | Level (0–1) while key is held |
| `decay2` | Time constant for slow sustain fade. `0` = true flat sustain. |
| `release` | Time from note-off to silence |

### LFO fields

```json
"lfos": [
  {
    "target":   "pitch",
    "waveform": "sine",
    "rate":     5.5,
    "depth":    0.15,
    "delay":    0.15
  }
]
```

| Field | Description |
|---|---|
| `target` | `"pitch"` (semitones) or `"volume"` (0–1). FM instruments also support `"op0.level"` through `"op3.level"`. |
| `rate` | Oscillation frequency in Hz |
| `depth` | For pitch: semitones of deviation. For volume: amplitude. |
| `delay` | Seconds before the LFO fades in after note-on |

### Stacking oscillators for fat / chord sounds

Multiple oscillators in the array are summed. Use `detune` for warm chorus, `semitones` for built-in harmony:

```json
"oscillators": [
  { "waveform": "triangle", "detune":   0, "level": 0.60 },
  { "waveform": "triangle", "detune":  12, "level": 0.45 },
  { "waveform": "triangle", "detune": -12, "level": 0.45 }
]
```

```json
"oscillators": [
  { "waveform": "square", "semitones":  0, "level": 1.0 },
  { "waveform": "square", "semitones":  7, "level": 0.7 },
  { "waveform": "square", "semitones": 12, "level": 0.5 }
]
```

All oscillators in a voice share one ADSR envelope.

---

## Sequencer

Pattern-based music scheduler using a look-ahead algorithm (100 ms horizon, 25 ms tick). Scheduling is sample-accurate via `AudioContext.currentTime` regardless of JavaScript timer drift.

```js
import { Sequencer } from './engine/sequencer.js';

const seq = new Sequencer(audio.context);
seq.bpm    = 160;
seq.loop   = true;   // default true

seq.setPattern(pattern);
seq.start();
seq.stop();    // resets to row 0, calls allNotesOff on all tracks
seq.pause();   // holds position, calls allNotesOff on all tracks
seq.resume();

seq.bpm        = 140;   // safe to change while running
seq.running;            // boolean
seq.currentRow;         // integer, for display
```

---

## Pattern Format

```js
{
  ticksPerBeat: 4,   // rhythmic subdivision (4 = sixteenth notes)
  length: 32,        // total rows in the pattern (loops when seq.loop is true)

  tracks: [
    {
      id: 'lead',
      instrument: oscSynthInstance,   // loaded OscSynth
      events: [
        { row: 0,  note: 72, velocity: 0.85, length: 2 },
        { row: 4,  note: 76, velocity: 0.80, length: 1 },
      ]
    },
    {
      id: 'bass',
      instrument: bassInstance,
      events: [ ... ]
    }
  ]
}
```

### Event fields

| Field | Description |
|---|---|
| `row` | Zero-based row index where the note triggers |
| `note` | MIDI note number (60 = middle C) |
| `velocity` | 0–1 |
| `length` | Duration in rows. A note at row 0 with length 4 releases at the start of row 4. |

### Timing

Row duration = `60 / bpm / ticksPerBeat` seconds.

At 160 BPM with `ticksPerBeat: 4`:
- Each row = 93.75 ms (sixteenth note)
- 16 rows = one bar
- 32 rows = two bars

### Pattern JSON file format (for saving/loading)

When serialising a pattern to disk, replace the `instrument` instance reference with a URL:

```json
{
  "ticksPerBeat": 4,
  "length": 32,
  "tracks": [
    {
      "id": "lead",
      "name": "Lead",
      "instrumentUrl": "instruments/nes-pulse-25.json",
      "events": [
        { "row": 0,  "note": 72, "velocity": 0.85, "length": 2 }
      ]
    }
  ]
}
```

---

## Included Instruments

| File | Description |
|---|---|
| `instruments/nes-pulse-25.json` | NES-style square wave, 25% duty cycle |
| `instruments/nes-pulse-50.json` | NES-style square wave, 50% duty cycle |
| `instruments/nes-triangle.json` | NES-style triangle bass |
| `instruments/nes-noise.json` | NES LFSR noise (percussion) |
| `instruments/fat-triangle.json` | Three-oscillator triangle, ±12 cent detuning |

---

## Test Pages

| Page | Purpose |
|---|---|
| `OscSynth.html` | Interactive keyboard + demo sequencer pattern + soundboard |
| `tracker.html` | Full pattern editor with per-cell note/velocity/length editing and JSON export |
