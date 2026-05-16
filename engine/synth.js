const MIDI_A4 = 69;
const FREQ_A4 = 440;

function midiToHz(note) {
    return FREQ_A4 * Math.pow(2, (note - MIDI_A4) / 12);
}

function makeLFSRBuffer(ctx, longMode = true) {
    const sr = ctx.sampleRate;
    // NES 15-bit LFSR; period = 32767 (long) or 93 (short)
    const period = longMode ? 32767 : 93;
    const buf = ctx.createBuffer(1, period, sr);
    const data = buf.getChannelData(0);
    let shift = 1;
    for (let i = 0; i < period; i++) {
        const tap = longMode ? (shift >> 1) : (shift >> 6);
        const feedback = ((shift ^ tap) & 1);
        shift = ((shift >> 1) | (feedback << 14)) & 0x7FFF;
        data[i] = (shift & 1) ? 1 : -1;
    }
    return buf;
}

function makeWhiteBuffer(ctx) {
    const sr = ctx.sampleRate;
    const buf = ctx.createBuffer(1, sr, sr); // 1-second loop
    const data = buf.getChannelData(0);
    for (let i = 0; i < sr; i++) data[i] = Math.random() * 2 - 1;
    return buf;
}

function makePulseWave(ctx, dutyCycle, harmonics = 256) {
    const real = new Float32Array(harmonics);
    const imag = new Float32Array(harmonics);
    for (let n = 1; n < harmonics; n++) {
        imag[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * dutyCycle);
    }
    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

export class OscSynth {
    /** @type {AudioContext} */ #ctx;
    /** @type {import('./audio.js').Channel} */ #channel;
    #def;
    #voices = [];
    #waveCache = new Map();
    #noiseBuffer = null;
    #seq = 0; // monotonic counter — used for oldest-steal ordering, independent of audio clock

    /**
     * @param {AudioContext} ctx
     * @param {object} channel  — a Channel instance (needs .inputNode)
     * @param {object} definition — parsed instrument JSON
     * @param {{ voices?: number }} [options]
     */
    constructor(ctx, channel, definition, options = {}) {
        this.#ctx = ctx;
        this.#channel = channel;
        this.#def = definition;

        const poolSize = options.voices ?? definition.voices ?? 4;
        for (let i = 0; i < poolSize; i++) {
            this.#voices.push({
                state: 'free',   // 'free' | 'playing' | 'releasing'
                note: -1,
                velocity: 0,
                noteStartTime: 0,
                noteSeq: 0,      // allocation order for oldest-steal
                gainNode: null,
                sources: [],     // OscillatorNode / BufferSourceNode
                nodes: [],       // all nodes for disconnect
            });
        }

        this.#prepareAssets();
    }

    get name() { return this.#def.name ?? 'Unnamed'; }
    get voiceCount() { return this.#voices.length; }

    /** Read-only snapshot of the voice pool — useful for debugging and tests. */
    get voiceStates() {
        return this.#voices.map(v => ({ state: v.state, note: v.note, startTime: v.noteStartTime }));
    }

    // ─── public API ──────────────────────────────────────────────────────────

    /**
     * Trigger a note.
     * @param {number} midiNote  0–127
     * @param {number} [velocity]  0–1
     * @param {number|null} [when]  AudioContext time; null = immediate
     */
    noteOn(midiNote, velocity = 0.8, when = null) {
        // Release existing voice on same note first
        const prev = this.#voices.find(v => v.note === midiNote && v.state === 'playing');
        if (prev) this.#releaseVoice(prev, when);

        const voice = this.#acquireVoice();
        if (!voice) return;

        this.#buildVoice(voice, midiNote, velocity, when ?? this.#ctx.currentTime);
    }

    /**
     * Release a held note.
     * @param {number} midiNote
     * @param {number|null} [noteStartedAt]  AudioContext time the note was triggered.
     *   When provided, the release is skipped if the current voice for this note was
     *   started *after* this timestamp — meaning the voice was already stolen and
     *   rebuilt for a newer note, so this noteOff is stale.
     */
    noteOff(midiNote, noteStartedAt = null) {
        const voice = this.#voices.find(v => v.note === midiNote && v.state === 'playing');
        if (!voice) return;
        if (noteStartedAt != null && voice.noteStartTime > noteStartedAt + 0.020) return;
        this.#releaseVoice(voice, null);
    }

    /** Release all currently playing voices immediately. */
    allNotesOff() {
        for (const voice of this.#voices) {
            if (voice.state === 'playing') this.#releaseVoice(voice, null);
        }
    }

    // ─── voice pool ──────────────────────────────────────────────────────────

    #acquireVoice() {
        const free = this.#voices.find(v => v.state === 'free');
        if (free) return free;

        const releasing = this.#voices.find(v => v.state === 'releasing');
        if (releasing) { this.#killVoice(releasing); return releasing; }

        const policy = this.#def.stealPolicy ?? 'oldest';
        if (policy === 'none') return null;

        // oldest: lowest noteStartTime
        const victim = this.#voices.reduce((a, b) => a.noteSeq < b.noteSeq ? a : b);
        this.#killVoice(victim);
        return victim;
    }

    #killVoice(voice) {
        for (const node of voice.nodes) {
            try { if (node.stop) node.stop(); } catch {}
            try { node.disconnect(); } catch {}
        }
        voice.state = 'free';
        voice.note = -1;
        voice.gainNode = null;
        voice.sources = [];
        voice.nodes = [];
    }

    // ─── voice construction ──────────────────────────────────────────────────

    #buildVoice(voice, midiNote, velocity, when) {
        const ctx = this.#ctx;
        const def = this.#def;
        const env = def.envelope ?? {};

        voice.state = 'playing';
        voice.note = midiNote;
        voice.velocity = velocity;
        voice.noteStartTime = when;
        voice.noteSeq = ++this.#seq;
        voice.nodes = [];
        voice.sources = [];

        // ── ADSR gain ──
        const attack  = env.attack  ?? 0.001;
        const decay   = env.decay   ?? 0.1;
        const sustain = env.sustain ?? 0.7;
        const decay2  = env.decay2  ?? 0;

        const adsrGain = ctx.createGain();
        adsrGain.gain.setValueAtTime(0, when);
        adsrGain.gain.linearRampToValueAtTime(velocity, when + attack);
        const decayEnd = when + attack + decay;
        adsrGain.gain.linearRampToValueAtTime(sustain * velocity, decayEnd);
        if (decay2 > 0) {
            // slow fade during sustain; decay2 is the time constant in seconds
            adsrGain.gain.setTargetAtTime(0, decayEnd, decay2);
        }

        voice.gainNode = adsrGain;
        voice.nodes.push(adsrGain);

        // ── optional panner ──
        const pan = def.pan ?? 0;
        let outputNode = adsrGain;
        if (pan !== 0) {
            const panner = ctx.createStereoPanner();
            panner.pan.value = pan;
            adsrGain.connect(panner);
            panner.connect(this.#channel.inputNode);
            voice.nodes.push(panner);
        } else {
            adsrGain.connect(this.#channel.inputNode);
        }

        // ── oscillators ──
        const baseHz = midiToHz(midiNote + (def.transpose ?? 0));
        const oscNodes = [];

        for (const oscDef of def.oscillators ?? []) {
            if (oscDef.waveform === 'noise') {
                const src = ctx.createBufferSource();
                src.buffer = this.#noiseBuffer;
                src.loop = true;

                const levelGain = ctx.createGain();
                levelGain.gain.value = oscDef.level ?? 1.0;

                src.connect(levelGain);
                levelGain.connect(adsrGain);
                src.start(when);

                voice.sources.push(src);
                voice.nodes.push(src, levelGain);
            } else {
                const osc = ctx.createOscillator();
                const oscHz = baseHz * Math.pow(2, (oscDef.semitones ?? 0) / 12);
                osc.frequency.value = oscHz;
                osc.detune.value = oscDef.detune ?? 0;

                if (oscDef.waveform === 'square' && oscDef.dutyCycle != null && oscDef.dutyCycle !== 0.5) {
                    osc.setPeriodicWave(this.#waveCache.get(`sq_${oscDef.dutyCycle}`));
                } else {
                    osc.type = oscDef.waveform ?? 'sine';
                }

                const levelGain = ctx.createGain();
                levelGain.gain.value = oscDef.level ?? 1.0;

                osc.connect(levelGain);
                levelGain.connect(adsrGain);
                osc.start(when);

                oscNodes.push(osc);
                voice.sources.push(osc);
                voice.nodes.push(osc, levelGain);
            }
        }

        // ── LFOs ──
        for (const lfo of def.lfos ?? []) {
            const lfoOsc = ctx.createOscillator();
            lfoOsc.type = lfo.waveform ?? 'sine';
            lfoOsc.frequency.value = lfo.rate ?? 5.0;

            const lfoGain = ctx.createGain();
            const delay = lfo.delay ?? 0;
            if (delay > 0) {
                lfoGain.gain.setValueAtTime(0, when);
                lfoGain.gain.linearRampToValueAtTime(1, when + delay);
            }

            if (lfo.target === 'pitch') {
                // depth in semitones → cents
                lfoGain.gain.value = (lfo.depth ?? 0.1) * 100;
                if (delay > 0) {
                    lfoGain.gain.setValueAtTime(0, when);
                    lfoGain.gain.linearRampToValueAtTime((lfo.depth ?? 0.1) * 100, when + delay);
                }
                lfoOsc.connect(lfoGain);
                for (const o of oscNodes) lfoGain.connect(o.detune);
            } else if (lfo.target === 'volume') {
                lfoGain.gain.value = (lfo.depth ?? 0.05);
                if (delay > 0) {
                    lfoGain.gain.setValueAtTime(0, when);
                    lfoGain.gain.linearRampToValueAtTime(lfo.depth ?? 0.05, when + delay);
                }
                lfoOsc.connect(lfoGain);
                lfoGain.connect(adsrGain.gain);
            }

            lfoOsc.start(when);
            voice.nodes.push(lfoOsc, lfoGain);
        }

        // ── auto-free after release ──
        // We schedule stop on sources in releaseVoice; onended frees the slot.
        // For noteOn without a corresponding noteOff (fire-and-forget), set up
        // a fallback using the first source's onended.
        if (voice.sources.length > 0) {
            let freed = false;
            const tryFree = () => {
                if (!freed && voice.state === 'releasing') {
                    freed = true;
                    voice.state = 'free';
                    voice.note = -1;
                }
            };
            voice.sources[0].onended = tryFree;
        }
    }

    // ─── release ─────────────────────────────────────────────────────────────

    #releaseVoice(voice, when) {
        if (!voice.gainNode) return;
        const ctx = this.#ctx;
        const env = this.#def.envelope ?? {};
        const release = env.release ?? 0.05;

        const now = when ?? ctx.currentTime;
        const currentGain = this.#gainAtTime(voice, now);

        voice.gainNode.gain.cancelScheduledValues(now);
        voice.gainNode.gain.setValueAtTime(currentGain, now);
        voice.gainNode.gain.linearRampToValueAtTime(0, now + release);

        for (const src of voice.sources) {
            try { src.stop(now + release + 0.02); } catch {}
        }

        voice.state = 'releasing';

        // Fallback cleanup in case onended doesn't fire (BufferSourceNode looping)
        setTimeout(() => {
            if (voice.state === 'releasing') this.#killVoice(voice);
        }, (release + 0.1) * 1000);
    }

    // Compute expected ADSR gain at AudioContext time t
    #gainAtTime(voice, t) {
        const env = this.#def.envelope ?? {};
        const attack  = env.attack  ?? 0.001;
        const decay   = env.decay   ?? 0.1;
        const sustain = env.sustain ?? 0.7;
        const decay2  = env.decay2  ?? 0;
        const { noteStartTime, velocity } = voice;

        const elapsed = t - noteStartTime;
        if (elapsed <= 0) return 0;

        const sustainLevel = sustain * velocity;

        if (elapsed < attack) {
            return (elapsed / attack) * velocity;
        }
        if (elapsed < attack + decay) {
            const p = (elapsed - attack) / decay;
            return velocity + p * (sustainLevel - velocity);
        }
        if (decay2 > 0) {
            const sustainElapsed = elapsed - attack - decay;
            return sustainLevel * Math.exp(-sustainElapsed / decay2);
        }
        return sustainLevel;
    }

    // ─── asset preparation ───────────────────────────────────────────────────

    #prepareAssets() {
        for (const oscDef of this.#def.oscillators ?? []) {
            if (oscDef.waveform === 'square') {
                const dc = oscDef.dutyCycle ?? 0.5;
                const key = `sq_${dc}`;
                if (!this.#waveCache.has(key)) {
                    this.#waveCache.set(key, makePulseWave(this.#ctx, dc));
                }
            }
            if (oscDef.waveform === 'noise' && !this.#noiseBuffer) {
                const type = oscDef.noiseType ?? 'lfsr';
                this.#noiseBuffer = type === 'lfsr'
                    ? makeLFSRBuffer(this.#ctx)
                    : makeWhiteBuffer(this.#ctx);
            }
        }
    }
}
