This tutorial builds a loading screen with a progress bar, then uses the same
machinery to swap assets between two "levels" — demonstrating dispose() for
unloading textures, sounds, and instruments.

Images are already included (`./sprites/`), reused from `examples/`.

## Audio files needed

Drop these into `./sounds/` with these exact names:

| File | What it's for | Notes |
|---|---|---|
| `bgm-level1.mp3` | Loops while Level 1 is active | Any short loop-friendly music track |
| `bgm-level2.mp3` | Loops while Level 2 is active | Should sound distinct from level 1's track so the swap is obvious |
| `jump.mp3` | Shared one-shot SFX, played on every level switch | Short — under a second is fine |
| `generalmidi.sf2` | A General MIDI soundfont, used only while Level 2 is active | Any GM-compatible .sf2 works — the tutorial only plays preset 0 (Acoustic Grand Piano in the standard GM bank order) |

None of these need to be large or polished — the tutorial cares about the loading/disposal mechanics, not the content.
