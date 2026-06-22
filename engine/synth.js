const MIDI_A4 = 69;
const FREQ_A4 = 440;

function midiToHz(note) {
    return FREQ_A4 * Math.pow(2, (note - MIDI_A4) / 12);
}

export class OscSynth {
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
    #seq = 0; // monotonic counter for oldest-steal ordering
    #disposed = false;
    #disposeToken = {};

    /**
     * @param {AudioContext} ctx
     * @param {object} channel        — Channel instance (needs .inputNode)
     * @param {object} definition     — parsed instrument JSON
     * @param {{ voices?: number }} [options]
     *
     * Requires 'synth-processor' to be registered before construction.
     * Call AudioManager.loadSynthWorklet() once before creating any OscSynth.
     */
    constructor(ctx, channel, definition, options = {}) {
        this.#ctx = ctx;
        this.#def = definition;

        const poolSize = options.voices ?? definition.voices ?? 4;
        for (let i = 0; i < poolSize; i++) {
            this.#voices.push({
                id:            i,
                state:         'free',   // 'free' | 'playing' | 'releasing'
                note:          -1,
                velocity:      0,
                noteStartTime: 0,
                noteSeq:       0,
            });
        }

        this.#workletNode = new AudioWorkletNode(ctx, 'synth-processor', {
            numberOfInputs:    0,
            numberOfOutputs:   1,
            outputChannelCount: [2],
        });

        const fDef = definition.filter ?? {};
        this.#filterNode = ctx.createBiquadFilter();
        this.#filterNode.type            = fDef.type      ?? 'allpass';
        this.#filterNode.frequency.value = fDef.frequency ?? 20000;
        this.#filterNode.Q.value         = fDef.Q         ?? 1;
        this.#workletNode.connect(this.#filterNode);
        this.#filterNode.connect(channel.inputNode);

        // Tell the worklet how many voice slots to allocate
        this.#post({ type: 'init', voiceCount: poolSize });

        // When the worklet finishes a release tail, mark the voice free here
        this.#workletNode.port.onmessage = e => {
            if (e.data.type === 'voiceDone') {
                const v = this.#voices[e.data.voiceId];
                if (v && v.state === 'releasing') {
                    v.state = 'free';
                    v.note  = -1;
                }
            }
        };

        OscSynth.#registry.register(this, { workletNode: this.#workletNode, filterNode: this.#filterNode }, this.#disposeToken);
    }

    // ── public API ────────────────────────────────────────────────────────────

    get name()        { return this.#def.name ?? 'Unnamed'; }
    get voiceCount()  { return this.#voices.length; }
    get disposed()    { return this.#disposed; }

    /** Read-only snapshot of the voice pool — for debugging and tests. */
    get voiceStates() {
        return this.#voices.map(v => ({ state: v.state, note: v.note, startTime: v.noteStartTime }));
    }

    /**
     * Trigger a note.
     * @param {number} midiNote  0–127
     * @param {number} [velocity]  0–1
     * @param {number|null} [when]  AudioContext time; null = immediate
     */
    noteOn(midiNote, velocity = 0.8, when = null) {
        const t = when ?? this.#ctx.currentTime;

        // Release any voice already playing this exact note
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
            oscDefs:   def.oscillators ?? [],
            envDef:    def.envelope    ?? {},
            lfoDefs:   def.lfos        ?? [],
            arpDef:    def.arpeggio    ?? null,
            pan:       def.pan         ?? 0,
            transpose: def.transpose   ?? 0,
        });
    }

    /**
     * Release a held note.
     * @param {number} midiNote
     * @param {number|null} [noteStartedAt]  AudioContext time the note was triggered.
     *   When provided, skips release if the current voice for this note started
     *   after this timestamp (stale noteOff from a prior voice that was already stolen).
     */
    noteOff(midiNote, noteStartedAt = null, when = null) {
        const voice = this.#voices.find(v => v.note === midiNote && v.state === 'playing');
        if (!voice) return;
        if (noteStartedAt != null && voice.noteStartTime > noteStartedAt + 0.020) return;
        this.#releaseVoice(voice, when);
    }

    /**
     * Update the instrument's filter parameters live.
     * @param {{ type?: string, frequency?: number, Q?: number }} params
     */
    setFilter({ type, frequency, Q } = {}) {
        const now = this.#ctx.currentTime;
        if (type      != null) this.#filterNode.type = type;
        if (frequency != null) this.#filterNode.frequency.setValueAtTime(frequency, now);
        if (Q         != null) this.#filterNode.Q.setValueAtTime(Q, now);
    }

    /**
     * Permanently disconnect this instrument. Call when removing a track or
     * switching instruments — stops worklet processing and frees the audio graph node.
     */
    dispose() {
        if (this.#disposed) return;
        this.#disposed = true;
        this.allNotesOff();
        this.#post({ type: 'dispose' });
        this.#workletNode.disconnect();
        this.#filterNode.disconnect();
        OscSynth.#registry.unregister(this.#disposeToken);
    }

    /** Release all currently playing voices. */
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
        // 1. Free slot
        const free = this.#voices.find(v => v.state === 'free');
        if (free) return free;

        // 2. Already-releasing slot
        const releasing = this.#voices.find(v => v.state === 'releasing');
        if (releasing) { this.#killVoice(releasing); return releasing; }

        // 3. Steal per policy
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

    // Fallback for suspended contexts (e.g. tests) where the worklet never runs
    // and voiceDone messages never arrive.
    #scheduleReleaseFallback(voice) {
        const release = this.#def.envelope?.release ?? 0.05;
        const seq = voice.noteSeq;
        setTimeout(() => {
            if (voice.state === 'releasing' && voice.noteSeq === seq) {
                voice.state = 'free';
                voice.note  = -1;
            }
        }, (release + 0.12) * 1000);
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    #post(msg) {
        this.#workletNode.port.postMessage(msg);
    }
}
