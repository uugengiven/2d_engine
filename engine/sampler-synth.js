import { fetchWithProgress } from './net.js';

export class SamplerSynth {
    // Backstop only — see Texture's registry comment for why dispose() is still
    // the real API and this must not be relied on for timing.
    static #registry = new FinalizationRegistry(filterNode => filterNode.disconnect());

    /** @type {AudioContext} */      #ctx;
    /** @type {BiquadFilterNode} */  #filterNode;
    #def;
    #zones = [];   // { loNote, hiNote, loVel, hiVel, rootNote, buffer, loopStart, loopEnd, envelope }
    #voices = [];
    #seq = 0;
    #disposed = false;
    #disposeToken = {};

    /**
     * Use SamplerSynth.load() to construct — buffers must be pre-decoded.
     * @param {AudioContext} ctx
     * @param {object} channel
     * @param {object} def         — parsed instrument JSON
     * @param {object[]} zones     — pre-decoded zone list (see load())
     * @param {{ voices?: number }} [options]
     */
    constructor(ctx, channel, def, zones, options = {}) {
        this.#ctx   = ctx;
        this.#def   = def;
        this.#zones = zones;

        const poolSize = options.voices ?? def.voices ?? 8;
        for (let i = 0; i < poolSize; i++) {
            this.#voices.push({
                id:            i,
                state:         'free',  // 'free' | 'playing' | 'releasing'
                note:          -1,
                velocity:      0,
                noteStartTime: 0,
                noteSeq:       0,
                source:        null,    // AudioBufferSourceNode
                gainNode:      null,    // GainNode (per-voice envelope)
                envelope:      {},
            });
        }

        const fDef = def.filter ?? {};
        this.#filterNode = ctx.createBiquadFilter();
        this.#filterNode.type            = fDef.type      ?? 'allpass';
        this.#filterNode.frequency.value = fDef.frequency ?? 20000;
        this.#filterNode.Q.value         = fDef.Q         ?? 1;
        this.#filterNode.connect(channel.inputNode);

        SamplerSynth.#registry.register(this, this.#filterNode, this.#disposeToken);
    }

    /**
     * Fetch and decode all sample files for a def. Stores loop points in seconds.
     * Call this once at load time; pass the result to the constructor directly for
     * cases where you need multiple SamplerSynth instances sharing the same buffers
     * (e.g. tracker tracks).
     * @param {AudioContext} ctx
     * @param {object} def      — parsed instrument JSON
     * @param {string} baseUrl  — URL the JSON was loaded from; sample paths are resolved relative to it
     * @param {(p: {loaded:number, total:number|null}) => void} [onProgress]
     *   Aggregated across every zone's sample file. total is null unless every
     *   zone's server reported a Content-Length.
     * @returns {Promise<object[]>} decoded zone list
     */
    static async decodeZones(ctx, def, baseUrl = '', onProgress) {
        // Resolve baseUrl to absolute so that new URL(sample, base) works even when
        // both are relative paths (new URL requires an absolute base).
        const absBase = baseUrl ? new URL(baseUrl, location.href).href : location.href;
        const zoneDefs = def.zones ?? [];

        // Per-zone progress snapshots, re-summed into one onProgress call per update
        // so the caller doesn't have to aggregate parallel downloads itself.
        const perZone = onProgress ? zoneDefs.map(() => ({ loaded: 0, total: null })) : null;
        const reportAggregate = () => {
            const loaded = perZone.reduce((sum, p) => sum + p.loaded, 0);
            const total  = perZone.every(p => p.total != null)
                ? perZone.reduce((sum, p) => sum + p.total, 0)
                : null;
            onProgress({ loaded, total });
        };

        return Promise.all(
            zoneDefs.map(async (z, i) => {
                const url = new URL(z.sample.replace(/#/g, '%23'), absBase).href;
                const ab  = await fetchWithProgress(url, onProgress && (p => {
                    perZone[i] = p;
                    reportAggregate();
                }));
                const buffer = await ctx.decodeAudioData(ab);
                return {
                    loNote:    z.loNote    ?? 0,
                    hiNote:    z.hiNote    ?? 127,
                    loVel:     z.loVel     ?? 0,
                    hiVel:     z.hiVel     ?? 127,
                    rootNote:  z.rootNote  ?? 60,
                    // loopStart / loopEnd are stored in samples in the JSON (matches BRR/SF2 convention)
                    // and converted to seconds using the buffer's own sample rate
                    loopStart: z.loopStart != null ? z.loopStart / buffer.sampleRate : null,
                    loopEnd:   z.loopEnd   != null ? z.loopEnd   / buffer.sampleRate : null,
                    envelope:  z.envelope  ?? null,
                    buffer,
                };
            })
        );
    }

    /**
     * Fetch, decode, and return a ready-to-play SamplerSynth.
     * @param {AudioContext} ctx
     * @param {object} channel
     * @param {object} def           — parsed instrument JSON
     * @param {string} baseUrl       — URL the JSON was loaded from; sample paths are resolved relative to it
     * @param {{ voices?: number, onProgress?: (p: {loaded:number, total:number|null}) => void }} [options]
     * @returns {Promise<SamplerSynth>}
     */
    static async load(ctx, channel, def, baseUrl = '', options = {}) {
        const zones = await SamplerSynth.decodeZones(ctx, def, baseUrl, options.onProgress);
        return new SamplerSynth(ctx, channel, def, zones, options);
    }

    // ── public API ─────────────────────────────────────────────────────────────

    get name()       { return this.#def.name ?? 'Unnamed'; }
    get voiceCount() { return this.#voices.length; }

    get voiceStates() {
        return this.#voices.map(v => ({ state: v.state, note: v.note, startTime: v.noteStartTime }));
    }

    get disposed() { return this.#disposed; }

    /**
     * @param {number} midiNote  0–127
     * @param {number} [velocity]  0–1
     * @param {number|null} [when]  AudioContext time; null = immediate
     */
    noteOn(midiNote, velocity = 0.8, when = null) {
        const t = when ?? this.#ctx.currentTime;

        const prev = this.#voices.find(v => v.note === midiNote && v.state === 'playing');
        if (prev) this.#releaseVoice(prev, t);

        const voice = this.#acquireVoice();
        if (!voice) return;

        const zone = this.#findZone(midiNote, velocity);
        if (!zone) return;

        const env     = zone.envelope ?? this.#def.envelope ?? {};
        const attack  = env.attack  ?? 0.001;
        const decay   = env.decay   ?? 0.1;
        const sustain = env.sustain ?? 0.8;

        const gainNode = this.#ctx.createGain();
        gainNode.gain.setValueAtTime(0, t);
        gainNode.gain.linearRampToValueAtTime(velocity, t + attack);
        gainNode.gain.linearRampToValueAtTime(velocity * sustain, t + attack + decay);
        gainNode.connect(this.#filterNode);

        const source = this.#ctx.createBufferSource();
        source.buffer           = zone.buffer;
        source.playbackRate.value = Math.pow(2, (midiNote - zone.rootNote) / 12);

        if (zone.loopStart != null && zone.loopEnd != null) {
            source.loop      = true;
            source.loopStart = zone.loopStart;
            source.loopEnd   = zone.loopEnd;
        }

        source.connect(gainNode);

        // Capture seq so stale onended from a stolen/re-used voice doesn't free the wrong state
        const seq = ++this.#seq;
        source.onended = () => {
            if (voice.noteSeq === seq) {
                gainNode.disconnect();
                voice.state    = 'free';
                voice.note     = -1;
                voice.source   = null;
                voice.gainNode = null;
            }
        };

        source.start(t);

        voice.state         = 'playing';
        voice.note          = midiNote;
        voice.velocity      = velocity;
        voice.noteStartTime = t;
        voice.noteSeq       = seq;
        voice.source        = source;
        voice.gainNode      = gainNode;
        voice.envelope      = env;
    }

    /**
     * @param {number} midiNote
     * @param {number|null} [noteStartedAt]  stale-noteOff guard (AudioContext time)
     * @param {number|null} [when]           AudioContext time; null = immediate
     */
    noteOff(midiNote, noteStartedAt = null, when = null) {
        const voice = this.#voices.find(v => v.note === midiNote && v.state === 'playing');
        if (!voice) return;
        if (noteStartedAt != null && voice.noteStartTime > noteStartedAt + 0.020) return;
        this.#releaseVoice(voice, when);
    }

    allNotesOff() {
        const now = this.#ctx.currentTime;
        for (const v of this.#voices) {
            if (v.state === 'playing') this.#releaseVoice(v, now);
        }
    }

    dispose() {
        if (this.#disposed) return;
        this.#disposed = true;
        this.allNotesOff();
        this.#filterNode.disconnect();
        SamplerSynth.#registry.unregister(this.#disposeToken);
    }

    /** @param {{ type?: string, frequency?: number, Q?: number }} params */
    setFilter({ type, frequency, Q } = {}) {
        const f   = this.#filterNode;
        const now = this.#ctx.currentTime;
        if (type      != null) f.type = type;
        if (frequency != null) f.frequency.setValueAtTime(frequency, now);
        if (Q         != null) f.Q.setValueAtTime(Q, now);
    }

    // ── voice pool ─────────────────────────────────────────────────────────────

    #acquireVoice() {
        const free = this.#voices.find(v => v.state === 'free');
        if (free) return free;

        const releasing = this.#voices.find(v => v.state === 'releasing');
        if (releasing) { this.#killVoice(releasing); return releasing; }

        const policy = this.#def.stealPolicy ?? 'oldest';
        if (policy === 'none') return null;

        const victim = this.#voices.reduce((a, b) => a.noteSeq < b.noteSeq ? a : b);
        this.#killVoice(victim);
        return victim;
    }

    #killVoice(voice) {
        const source     = voice.source;
        const gainNode   = voice.gainNode;
        const wasPlaying = voice.state === 'playing';

        // Free the voice slot immediately so it can be reused, but let the
        // audio nodes do a short fade rather than a hard cut to avoid clicks.
        voice.state    = 'free';
        voice.note     = -1;
        voice.source   = null;
        voice.gainNode = null;

        if (gainNode) {
            const gain    = gainNode.gain;
            const t       = this.#ctx.currentTime;
            const declick = 0.005;
            // For a playing voice, gain.value may not reflect the audio engine's
            // current value if the attack block hasn't been rendered yet — compute
            // it analytically instead to avoid a discontinuity at the cut point.
            const currentGain = wasPlaying ? this.#envGainAt(voice, t) : gain.value;
            gain.cancelScheduledValues(t);
            gain.setValueAtTime(currentGain, t);
            gain.linearRampToValueAtTime(0, t + declick);
            try { source?.stop(t + declick + 0.002); } catch {}
            setTimeout(() => gainNode.disconnect(), (declick + 0.02) * 1000);
        } else {
            try { source?.stop(); } catch {}
        }
    }

    // Analytically replicates the noteOn gain automation so we can snapshot the
    // expected gain at any time t without relying on gain.value (which lags by
    // one render block and is inaccurate during the attack phase).
    #envGainAt(voice, t) {
        const elapsed = t - voice.noteStartTime;
        const env     = voice.envelope ?? {};
        const attack  = env.attack  ?? 0.001;
        const decay   = env.decay   ?? 0.1;
        const sustain = env.sustain ?? 0.8;
        const vel     = voice.velocity ?? 0.8;

        if (elapsed <= 0)             return 0;
        if (elapsed < attack)         return (elapsed / attack) * vel;
        if (elapsed < attack + decay) return vel * (1 - (1 - sustain) * (elapsed - attack) / decay);
        return vel * sustain;
    }

    #releaseVoice(voice, when) {
        const t       = when ?? this.#ctx.currentTime;
        const release = voice.envelope?.release ?? 0.3;

        voice.state = 'releasing';

        if (voice.gainNode) {
            const gain = voice.gainNode.gain;
            // Cancel any pending attack/decay ramps scheduled after t — without this they
            // would override the release ramp and leave the gain stuck at sustain level.
            if (typeof gain.cancelAndHoldAtTime === 'function') {
                gain.cancelAndHoldAtTime(t);
            } else {
                gain.cancelScheduledValues(t);
                gain.setValueAtTime(this.#envGainAt(voice, t), t);
            }
            gain.linearRampToValueAtTime(0, t + release);
        }

        // Stop the source just after the ramp reaches zero
        try { voice.source?.stop(t + release + 0.05); } catch {}
    }

    // ── zone lookup ────────────────────────────────────────────────────────────

    #findZone(note, velocity) {
        if (this.#zones.length === 0) return null;

        const velMidi = velocity * 127;

        // Prefer exact note + velocity range match
        const match = this.#zones.find(z =>
            note    >= z.loNote && note    <= z.hiNote &&
            velMidi >= z.loVel  && velMidi <= z.hiVel
        );
        if (match) return match;

        // Fall back to nearest root note (ignores velocity layers)
        return this.#zones.reduce((best, z) =>
            Math.abs(z.rootNote - note) < Math.abs(best.rootNote - note) ? z : best
        );
    }
}
