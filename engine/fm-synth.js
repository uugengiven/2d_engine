export class FmSynth {
    // Backstop only — see Texture's registry comment for why dispose() is still
    // the real API and this must not be relied on for timing.
    static #registry = new FinalizationRegistry(({ workletNode, filterNode }) => {
        workletNode.disconnect();
        filterNode.disconnect();
    });

    /** @type {AudioContext} */      #ctx;
    /** @type {AudioWorkletNode} */  #workletNode;
    /** @type {BiquadFilterNode} */  #filterNode;
    #def;
    #voices = [];
    #seq = 0;
    #disposed = false;
    #disposeToken = {};

    /**
     * @param {AudioContext} ctx
     * @param {object} channel       — Channel instance (needs .inputNode)
     * @param {object} definition    — parsed FM instrument JSON
     * @param {{ voices?: number }} [options]
     *
     * Requires 'fm-synth-processor' to be registered before construction.
     * Call AudioManager.loadFmWorklet() once before creating any FmSynth.
     */
    constructor(ctx, channel, definition, options = {}) {
        this.#ctx = ctx;
        this.#def = definition;

        const poolSize = options.voices ?? definition.voices ?? 4;
        for (let i = 0; i < poolSize; i++) {
            this.#voices.push({
                id:            i,
                state:         'free',
                note:          -1,
                velocity:      0,
                noteStartTime: 0,
                noteSeq:       0,
            });
        }

        this.#workletNode = new AudioWorkletNode(ctx, 'fm-synth-processor', {
            numberOfInputs:     0,
            numberOfOutputs:    1,
            outputChannelCount: [2],
        });

        const fDef = definition.filter ?? {};
        this.#filterNode = ctx.createBiquadFilter();
        this.#filterNode.type            = fDef.type      ?? 'allpass';
        this.#filterNode.frequency.value = fDef.frequency ?? 20000;
        this.#filterNode.Q.value         = fDef.Q         ?? 1;

        this.#workletNode.connect(this.#filterNode);
        this.#filterNode.connect(channel.inputNode);

        this.#post({ type: 'init', voiceCount: poolSize });

        this.#workletNode.port.onmessage = e => {
            if (e.data.type === 'voiceDone') {
                const v = this.#voices[e.data.voiceId];
                if (v && v.state === 'releasing') {
                    v.state = 'free';
                    v.note  = -1;
                }
            }
        };

        FmSynth.#registry.register(this, { workletNode: this.#workletNode, filterNode: this.#filterNode }, this.#disposeToken);
    }

    // ── public API ────────────────────────────────────────────────────────────

    get name()       { return this.#def.name ?? 'Unnamed'; }
    get voiceCount() { return this.#voices.length; }
    get disposed()   { return this.#disposed; }

    get voiceStates() {
        return this.#voices.map(v => ({ state: v.state, note: v.note, startTime: v.noteStartTime }));
    }

    noteOn(midiNote, velocity = 0.8, when = null) {
        const t = when ?? this.#ctx.currentTime;

        const prev = this.#voices.find(v => v.note === midiNote && v.state === 'playing');
        if (prev) this.#releaseVoice(prev, t);

        const voice = this.#acquireVoice();
        if (!voice) return;

        voice.state         = 'playing';
        voice.note          = midiNote;
        voice.velocity      = velocity;
        voice.noteStartTime = t;
        voice.noteSeq       = ++this.#seq;

        const def = this.#def;
        this.#post({
            type:      'noteOn',
            voiceId:   voice.id,
            note:      midiNote,
            vel:       velocity,
            when:      t,
            opDefs:    def.operators  ?? [],
            algorithm: def.algorithm  ?? [],
            lfoDefs:   def.lfos       ?? [],
            pan:       def.pan        ?? 0,
            transpose: def.transpose  ?? 0,
        });
    }

    noteOff(midiNote, noteStartedAt = null, when = null) {
        const voice = this.#voices.find(v => v.note === midiNote && v.state === 'playing');
        if (!voice) return;
        if (noteStartedAt != null && voice.noteStartTime > noteStartedAt + 0.020) return;
        this.#releaseVoice(voice, when);
    }

    setFilter({ type, frequency, Q } = {}) {
        const f   = this.#filterNode;
        const now = this.#ctx.currentTime;
        if (type      != null) f.type = type;
        if (frequency != null) f.frequency.setValueAtTime(frequency, now);
        if (Q         != null) f.Q.setValueAtTime(Q, now);
    }

    dispose() {
        if (this.#disposed) return;
        this.#disposed = true;
        this.allNotesOff();
        this.#post({ type: 'dispose' });
        this.#workletNode.disconnect();
        this.#filterNode.disconnect();
        FmSynth.#registry.unregister(this.#disposeToken);
    }

    allNotesOff() {
        const now = this.#ctx.currentTime;
        for (const v of this.#voices) {
            if (v.state === 'playing') {
                v.state = 'releasing';
                this.#scheduleReleaseFallback(v);
            }
        }
        this.#post({ type: 'allNotesOff', when: now });
    }

    // ── voice pool ────────────────────────────────────────────────────────────

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
        this.#post({ type: 'killVoice', voiceId: voice.id });
        voice.state = 'free';
        voice.note  = -1;
    }

    #releaseVoice(voice, when) {
        const now = when ?? this.#ctx.currentTime;
        voice.state = 'releasing';
        this.#post({ type: 'noteOff', voiceId: voice.id, when: now });
        this.#scheduleReleaseFallback(voice);
    }

    #scheduleReleaseFallback(voice) {
        // Longest operator release tail
        let maxRelease = 0;
        for (const op of (this.#def.operators ?? [])) {
            maxRelease = Math.max(maxRelease, op.envelope?.release ?? 0.05);
        }
        const seq = voice.noteSeq;
        setTimeout(() => {
            if (voice.state === 'releasing' && voice.noteSeq === seq) {
                voice.state = 'free';
                voice.note  = -1;
            }
        }, (maxRelease + 0.12) * 1000);
    }

    #post(msg) {
        this.#workletNode.port.postMessage(msg);
    }
}
