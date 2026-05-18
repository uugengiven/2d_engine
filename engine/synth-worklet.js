/**
 * SynthProcessor — AudioWorkletProcessor for sample-accurate OscSynth playback.
 *
 * Runs on the audio rendering thread. The main thread sends timestamped events
 * (noteOn / noteOff) with AudioContext-time `when` values; this processor fires
 * them at exactly the right sample regardless of main-thread scheduling jitter.
 *
 * Message protocol  (main → worklet):
 *   { type:'init',        voiceCount }
 *   { type:'noteOn',      voiceId, note, vel, when, oscDefs, envDef, lfoDefs, pan, transpose }
 *   { type:'noteOff',     voiceId, when }
 *   { type:'killVoice',   voiceId }
 *   { type:'allNotesOff', when }
 *
 * Message protocol  (worklet → main):
 *   { type:'voiceDone', voiceId }   — release tail has finished
 */

// ── free functions (no closure overhead in the hot path) ─────────────────────

function gainAtElapsed(elapsed, env, velocity) {
    const attack  = env.attack  ?? 0.001;
    const decay   = env.decay   ?? 0.1;
    const sustain = env.sustain ?? 0.7;
    const decay2  = env.decay2  ?? 0;

    if (elapsed <= 0) return 0;
    if (elapsed < attack) return (elapsed / attack) * velocity;

    const sustainLevel = sustain * velocity;
    if (elapsed < attack + decay) {
        const p = (elapsed - attack) / decay;
        return velocity + p * (sustainLevel - velocity);
    }
    if (decay2 > 0) {
        return sustainLevel * Math.exp(-(elapsed - attack - decay) / decay2);
    }
    return sustainLevel;
}

// ── processor ────────────────────────────────────────────────────────────────

class SynthProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._voices = [];
        this.port.onmessage = e => this._handleMessage(e.data);
    }

    // ── message handling ────────────────────────────────────────────────────

    _handleMessage(msg) {
        switch (msg.type) {
            case 'init':        this._init(msg);         break;
            case 'noteOn':      this._noteOn(msg);        break;
            case 'noteOff':     this._noteOff(msg);       break;
            case 'killVoice':   this._killVoice(msg);     break;
            case 'allNotesOff': this._allNotesOff(msg);   break;
            case 'dispose':     this._disposed = true;    break;
        }
    }

    _init({ voiceCount }) {
        this._voices = Array.from({ length: voiceCount }, (_, id) => ({
            id,
            active:          false,
            startFrame:      0,
            releaseFrame:    -1,
            releaseEndFrame: -1,
            gainAtRelease:   0,
            velocity:        0,
            envelope:        {},
            pan:             0,
            oscs:            [],
            lfos:            [],
        }));
    }

    _noteOn({ voiceId, note, vel, when, oscDefs, envDef, lfoDefs, pan, transpose }) {
        const v = this._voices[voiceId];
        if (!v) return;

        const sr         = sampleRate;
        const startFrame = Math.max(currentFrame, Math.round(when * sr));
        const baseHz     = 440 * Math.pow(2, (note - 69 + (transpose ?? 0)) / 12);

        v.active          = true;
        v.startFrame      = startFrame;
        v.releaseFrame    = -1;
        v.releaseEndFrame = -1;
        v.gainAtRelease   = 0;
        v.velocity        = vel;
        v.envelope        = envDef ?? {};
        v.pan             = pan ?? 0;

        v.oscs = (oscDefs ?? []).map(od => ({
            waveform:  od.waveform  ?? 'sine',
            dutyCycle: od.dutyCycle ?? 0.5,
            noiseType: od.noiseType ?? 'lfsr',
            freq:      baseHz * Math.pow(2, ((od.semitones ?? 0) + (od.detune ?? 0) / 100) / 12),
            level:     od.level ?? 1.0,
            phase:     0,
            lfsrShift: 1,
        }));

        v.lfos = (lfoDefs ?? []).map(ld => ({
            target:     ld.target    ?? 'pitch',
            waveform:   ld.waveform  ?? 'sine',
            rate:       ld.rate      ?? 5,
            depth:      ld.depth     ?? 0.1,
            startFrame: startFrame + Math.round((ld.delay ?? 0) * sampleRate),
            phase:      0,
        }));
    }

    _noteOff({ voiceId, when }) {
        const v = this._voices[voiceId];
        if (!v || !v.active || v.releaseFrame >= 0) return;

        const sr      = sampleRate;
        const rf      = Math.max(currentFrame, Math.round(when * sr));
        const elapsed = (rf - v.startFrame) / sr;

        v.gainAtRelease   = gainAtElapsed(elapsed, v.envelope, v.velocity);
        v.releaseFrame    = rf;
        v.releaseEndFrame = rf + Math.round((v.envelope.release ?? 0.05) * sr);
    }

    _killVoice({ voiceId }) {
        const v = this._voices[voiceId];
        if (v) v.active = false;
    }

    _allNotesOff({ when }) {
        const sr = sampleRate;
        const rf = Math.max(currentFrame, Math.round((when ?? currentTime) * sr));
        for (const v of this._voices) {
            if (!v.active || v.releaseFrame >= 0) continue;
            const elapsed         = (rf - v.startFrame) / sr;
            v.gainAtRelease       = gainAtElapsed(elapsed, v.envelope, v.velocity);
            v.releaseFrame        = rf;
            v.releaseEndFrame     = rf + Math.round((v.envelope.release ?? 0.05) * sr);
        }
    }

    // ── render ──────────────────────────────────────────────────────────────

    process(_inputs, outputs) {
        if (this._disposed) return false; // signal GC to the audio engine
        const out = outputs[0];
        if (!out || out.length < 1) return true;

        const L  = out[0];
        const R  = out.length > 1 ? out[1] : out[0];
        const sr = sampleRate;
        const cf = currentFrame;
        const len = L.length;

        for (let i = 0; i < len; i++) {
            const frame = cf + i;
            let sL = 0, sR = 0;

            for (let vi = 0; vi < this._voices.length; vi++) {
                const v = this._voices[vi];
                if (!v.active || frame < v.startFrame) continue;

                // ── release-complete check ──
                if (v.releaseEndFrame >= 0 && frame >= v.releaseEndFrame) {
                    v.active = false;
                    this.port.postMessage({ type: 'voiceDone', voiceId: v.id });
                    continue;
                }

                // ── envelope ──
                let envGain;
                if (v.releaseFrame >= 0 && frame >= v.releaseFrame) {
                    const relElapsed = (frame - v.releaseFrame) / sr;
                    const relDur     = v.envelope.release ?? 0.05;
                    envGain = v.gainAtRelease * Math.max(0, 1 - relElapsed / relDur);
                } else {
                    envGain = gainAtElapsed((frame - v.startFrame) / sr, v.envelope, v.velocity);
                }

                // ── LFOs ──
                let pitchSemitones = 0;
                let ampMod = 1;
                for (let li = 0; li < v.lfos.length; li++) {
                    const lfo = v.lfos[li];
                    if (frame < lfo.startFrame) continue;
                    lfo.phase = (lfo.phase + lfo.rate / sr) % 1;
                    const postDelay = (frame - lfo.startFrame) / sr;
                    const fadeGain  = Math.min(1, postDelay / 0.05); // 50 ms fade-in
                    const lfoVal    = Math.sin(2 * Math.PI * lfo.phase) * lfo.depth * fadeGain;
                    if (lfo.target === 'pitch')  pitchSemitones += lfoVal;
                    else if (lfo.target === 'volume') ampMod += lfoVal;
                }

                // ── oscillators ──
                const freqMult = pitchSemitones !== 0
                    ? Math.pow(2, pitchSemitones / 12)
                    : 1;

                let oscMix = 0;
                for (let oi = 0; oi < v.oscs.length; oi++) {
                    const osc = v.oscs[oi];
                    let s;

                    if (osc.waveform === 'noise') {
                        if (osc.noiseType === 'white') {
                            s = Math.random() * 2 - 1;
                        } else {
                            // 15-bit LFSR — NES long mode (taps: bits 1 and 0)
                            const fb = ((osc.lfsrShift ^ (osc.lfsrShift >> 1)) & 1);
                            osc.lfsrShift = ((osc.lfsrShift >> 1) | (fb << 14)) & 0x7FFF;
                            s = osc.lfsrShift & 1 ? 1 : -1;
                        }
                        // noise has no frequency concept — skip phase advance
                    } else {
                        osc.phase = (osc.phase + (osc.freq * freqMult) / sr) % 1;
                        const p = osc.phase;
                        switch (osc.waveform) {
                            case 'square':   s = p < osc.dutyCycle ? 1 : -1;          break;
                            case 'triangle': s = p < 0.5 ? 4*p - 1 : 3 - 4*p;        break;
                            case 'sawtooth': s = 2*p - 1;                             break;
                            case 'sine':     s = Math.sin(2 * Math.PI * p);           break;
                            default:         s = 0;
                        }
                    }

                    oscMix += s * osc.level;
                }

                // ── pan + accumulate ──
                const amp   = oscMix * envGain * ampMod;
                const angle = ((v.pan + 1) * 0.5) * (Math.PI * 0.5);
                sL += amp * Math.cos(angle);
                sR += amp * Math.sin(angle);
            }

            L[i] = sL;
            R[i] = sR;
        }

        return true; // keep processor alive
    }
}

registerProcessor('synth-processor', SynthProcessor);
