/**
 * FmSynthProcessor — AudioWorkletProcessor for sample-accurate FM synthesis.
 *
 * Up to 4 operators per voice. Routing is defined by an `algorithm` array of
 * [srcOp, dstOp] pairs where dstOp === -1 means carrier (goes to audio output).
 * Operators are processed in the order they appear in opDefs; put modulators
 * before the carriers they feed.
 *
 * Message protocol  (main → worklet):
 *   { type:'init',        voiceCount }
 *   { type:'noteOn',      voiceId, note, vel, when, opDefs, algorithm, lfoDefs, pan, transpose }
 *   { type:'noteOff',     voiceId, when }
 *   { type:'killVoice',   voiceId }
 *   { type:'allNotesOff', when }
 *
 * Message protocol  (worklet → main):
 *   { type:'voiceDone', voiceId }
 */

const TWO_PI    = 2 * Math.PI;
const _SIN_N    = 4096;
const _SIN_MASK = _SIN_N - 1;
const _RAD_TO_I = _SIN_N / TWO_PI;
const _SIN_TAB  = new Float32Array(_SIN_N);
for (let i = 0; i < _SIN_N; i++) _SIN_TAB[i] = Math.sin(TWO_PI * i / _SIN_N);

function opEnvGain(elapsed, env, velocity) {
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

function opEnvRelease(gainAtRelease, relElapsed, relDur) {
    return gainAtRelease * Math.max(0, 1 - relElapsed / relDur);
}

class FmSynthProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._voices = [];
        this.port.onmessage = e => this._handleMessage(e.data);
    }

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
            declickEndFrame: -1,
            lastAmpL:        0,
            lastAmpR:        0,
            ghostAmpL:       0,
            ghostAmpR:       0,
            velocity:        0,
            pan:             0,
            ops:             [],
            algorithm:       [],
            lfos:            [],
        }));
    }

    _noteOn({ voiceId, note, vel, when, opDefs, algorithm, lfoDefs, pan, transpose }) {
        const v = this._voices[voiceId];
        if (!v) return;

        const sr         = sampleRate;
        const startFrame = Math.max(currentFrame, Math.round(when * sr));
        const baseHz     = 440 * Math.pow(2, (note - 69 + (transpose ?? 0)) / 12);

        v.active          = true;
        v.startFrame      = startFrame;
        v.releaseFrame    = -1;
        v.releaseEndFrame = -1;
        v.velocity        = vel;
        v.pan             = pan ?? 0;
        v.algorithm       = algorithm ?? [];

        v.ops = (opDefs ?? []).map(od => {
            const env = od.envelope ?? {};
            const relDur = env.release ?? 0.05;
            return {
                // frequency
                ratio:    od.ratio    ?? 1.0,
                fixedHz:  od.fixedHz  ?? null,
                detune:   od.detune   ?? 0,
                freq:     od.fixedHz != null
                    ? od.fixedHz * Math.pow(2, (od.detune ?? 0) / 1200)
                    : baseHz * (od.ratio ?? 1.0) * Math.pow(2, (od.detune ?? 0) / 1200),
                // synthesis
                level:       od.level    ?? 1.0,
                feedback:    od.feedback ?? 0,
                // envelope
                envelope:    env,
                releaseDur:  relDur,
                // state
                phase:          0,
                fbBuf:          0,   // previous output for feedback
                gainAtRelease:  0,
                output:         0,   // computed this sample, read by downstream ops
            };
        });

        v.lfos = (lfoDefs ?? []).map(ld => ({
            target:     ld.target   ?? 'pitch',
            waveform:   ld.waveform ?? 'sine',
            rate:       ld.rate     ?? 5,
            depth:      ld.depth    ?? 0.1,
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

        // Snapshot each operator's gain at release
        for (const op of v.ops) {
            op.gainAtRelease = opEnvGain(elapsed, op.envelope, v.velocity);
        }
        v.releaseFrame = rf;

        // Release ends when the longest operator release tail finishes
        let maxRelDur = 0;
        for (const op of v.ops) maxRelDur = Math.max(maxRelDur, op.releaseDur);
        v.releaseEndFrame = rf + Math.round(maxRelDur * sr);
    }

    _killVoice({ voiceId }) {
        const v = this._voices[voiceId];
        if (!v?.active) return;
        if (v.declickEndFrame > currentFrame) {
            const pct = (v.declickEndFrame - currentFrame) / 64;
            v.ghostAmpL = v.lastAmpL + v.ghostAmpL * pct;
            v.ghostAmpR = v.lastAmpR + v.ghostAmpR * pct;
        } else {
            v.ghostAmpL = v.lastAmpL;
            v.ghostAmpR = v.lastAmpR;
        }
        v.declickEndFrame = currentFrame + 64;
    }

    _allNotesOff({ when }) {
        const sr = sampleRate;
        const rf = Math.max(currentFrame, Math.round((when ?? currentTime) * sr));
        for (const v of this._voices) {
            if (!v.active || v.releaseFrame >= 0) continue;
            const elapsed = (rf - v.startFrame) / sr;
            for (const op of v.ops) {
                op.gainAtRelease = opEnvGain(elapsed, op.envelope, v.velocity);
            }
            v.releaseFrame = rf;
            let maxRelDur = 0;
            for (const op of v.ops) maxRelDur = Math.max(maxRelDur, op.releaseDur);
            v.releaseEndFrame = rf + Math.round(maxRelDur * sr);
        }
    }

    process(_inputs, outputs) {
        if (this._disposed) return false;
        const out = outputs[0];
        if (!out || out.length < 1) return true;

        const L   = out[0];
        const R   = out.length > 1 ? out[1] : out[0];
        const sr  = sampleRate;
        const cf  = currentFrame;
        const len = L.length;

        for (let i = 0; i < len; i++) {
            const frame = cf + i;
            let sL = 0, sR = 0;

            for (let vi = 0; vi < this._voices.length; vi++) {
                const v = this._voices[vi];
                if (!v.active) continue;

                // ── ghost declick — additive, independent of new note ──
                if (v.declickEndFrame >= 0) {
                    if (frame < v.declickEndFrame) {
                        const mult = (v.declickEndFrame - frame) / 64;
                        sL += v.ghostAmpL * mult;
                        sR += v.ghostAmpR * mult;
                    } else {
                        v.declickEndFrame = -1;
                    }
                }

                if (frame < v.startFrame) continue;

                if (v.releaseEndFrame >= 0 && frame >= v.releaseEndFrame) {
                    v.active = false;
                    this.port.postMessage({ type: 'voiceDone', voiceId: v.id });
                    continue;
                }

                const elapsed     = (frame - v.startFrame) / sr;
                const inRelease   = v.releaseFrame >= 0 && frame >= v.releaseFrame;
                const relElapsed  = inRelease ? (frame - v.releaseFrame) / sr : 0;

                // ── LFOs ──
                let pitchSemitones = 0;
                let ampMod = 1;
                const opLevelMod = [1, 1, 1, 1];
                const opFreqMod  = [1, 1, 1, 1];
                const opFbMod    = [0, 0, 0, 0];

                for (let li = 0; li < v.lfos.length; li++) {
                    const lfo = v.lfos[li];
                    if (frame < lfo.startFrame) continue;
                    lfo.phase = (lfo.phase + lfo.rate / sr) % 1;
                    const postDelay = (frame - lfo.startFrame) / sr;
                    const fadeGain  = Math.min(1, postDelay / 0.05);
                    let lfoRaw;
                    switch (lfo.waveform) {
                        case 'square':   lfoRaw = lfo.phase < 0.5 ? 1 : -1; break;
                        case 'triangle': lfoRaw = lfo.phase < 0.5 ? 4*lfo.phase - 1 : 3 - 4*lfo.phase; break;
                        case 'sawtooth': lfoRaw = 2*lfo.phase - 1; break;
                        default:         lfoRaw = _SIN_TAB[(lfo.phase * _SIN_N | 0) & _SIN_MASK]; break;
                    }
                    const lfoVal = lfoRaw * lfo.depth * fadeGain;
                    if      (lfo.target === 'pitch')        pitchSemitones   += lfoVal;
                    else if (lfo.target === 'volume')       ampMod           += lfoVal;
                    else if (lfo.target === 'op0.level')    opLevelMod[0]    += lfoVal;
                    else if (lfo.target === 'op1.level')    opLevelMod[1]    += lfoVal;
                    else if (lfo.target === 'op2.level')    opLevelMod[2]    += lfoVal;
                    else if (lfo.target === 'op3.level')    opLevelMod[3]    += lfoVal;
                    else if (lfo.target === 'op0.ratio')    opFreqMod[0]     *= Math.pow(2, lfoVal / 12);
                    else if (lfo.target === 'op1.ratio')    opFreqMod[1]     *= Math.pow(2, lfoVal / 12);
                    else if (lfo.target === 'op2.ratio')    opFreqMod[2]     *= Math.pow(2, lfoVal / 12);
                    else if (lfo.target === 'op3.ratio')    opFreqMod[3]     *= Math.pow(2, lfoVal / 12);
                    else if (lfo.target === 'op0.feedback') opFbMod[0]       += lfoVal;
                    else if (lfo.target === 'op1.feedback') opFbMod[1]       += lfoVal;
                    else if (lfo.target === 'op2.feedback') opFbMod[2]       += lfoVal;
                    else if (lfo.target === 'op3.feedback') opFbMod[3]       += lfoVal;
                }

                const freqMult = pitchSemitones !== 0
                    ? Math.pow(2, pitchSemitones / 12)
                    : 1;

                // ── build per-op modulation input from algorithm ──
                // modInput[k] = sum of outputs of operators that feed into op k
                const modInput = [0, 0, 0, 0];
                for (let ai = 0; ai < v.algorithm.length; ai++) {
                    const [src, dst] = v.algorithm[ai];
                    if (dst >= 0 && dst < 4 && src >= 0 && src < v.ops.length) {
                        modInput[dst] += v.ops[src].output;
                    }
                }

                // ── compute each operator in definition order ──
                let carrierMix = 0;
                const ops = v.ops;

                for (let oi = 0; oi < ops.length; oi++) {
                    const op = ops[oi];

                    // Envelope gain for this operator
                    let opGain;
                    if (inRelease) {
                        opGain = opEnvRelease(op.gainAtRelease, relElapsed, op.releaseDur);
                    } else {
                        opGain = opEnvGain(elapsed, op.envelope, v.velocity);
                    }

                    const phaseMod = modInput[oi] * TWO_PI + op.fbBuf * Math.max(0, op.feedback + opFbMod[oi]) * TWO_PI;

                    const instFreq = op.freq * freqMult * opFreqMod[oi];
                    op.phase = (op.phase + instFreq / sr) % 1;
                    const raw = _SIN_TAB[((TWO_PI * op.phase + phaseMod) * _RAD_TO_I | 0) & _SIN_MASK];

                    op.fbBuf = raw;  // feedback uses pre-envelope sample
                    op.output = raw * opGain * op.level * opLevelMod[oi];

                    // Carrier if: has an explicit [oi,-1] route, OR has no connections at all.
                    // An op can be both modulator and carrier simultaneously.
                    let routesToOp  = false;
                    let routesToOut = false;
                    for (let ai = 0; ai < v.algorithm.length; ai++) {
                        const [s, d] = v.algorithm[ai];
                        if (s !== oi) continue;
                        if (d < 0) routesToOut = true;
                        else       routesToOp  = true;
                    }
                    if (routesToOut || !routesToOp) carrierMix += op.output;
                }

                // ── pan + accumulate ──
                const amp   = carrierMix * ampMod;
                const angle = ((v.pan + 1) * 0.5) * (Math.PI * 0.5);
                const thisL = amp * Math.cos(angle);
                const thisR = amp * Math.sin(angle);
                sL += thisL;
                sR += thisR;
                v.lastAmpL = thisL;
                v.lastAmpR = thisR;
            }

            L[i] = sL;
            R[i] = sR;
        }

        return true;
    }
}

registerProcessor('fm-synth-processor', FmSynthProcessor);
