/**
 * SF2Parser — reads a SoundFont 2 file from an ArrayBuffer and extracts
 * presets as SamplerSynth-compatible { def, zones } objects.
 *
 * All decoded AudioBuffers live in memory; no file I/O is performed.
 * Intended for load-time use (level load, etc.) not per-frame calls.
 *
 * Usage:
 *   const parser  = new SF2Parser(arrayBuffer);
 *   const presets = parser.getPresets();
 *   // [{ index, name, bank, program, isPercussion }, ...]
 *
 *   const { def, zones } = parser.buildInstrument(audioCtx, presetIndex);
 *   const synth = new SamplerSynth(ctx, channel, def, zones, { voices: 8 });
 *
 *   // Or build several at once:
 *   const map = parser.buildInstruments(audioCtx, [0, 1, 4]);
 *   // Map<presetIndex, { def, zones }>
 */

// ── unit conversion ────────────────────────────────────────────────────────────

function tcToSec(tc) {
    // Timecents: 0 tc = 1 s, −12000 tc ≈ 1 ms (minimum envelope segment)
    return Math.pow(2, tc / 1200);
}

function cbToGain(cb) {
    // Centibels attenuation: 0 cb = 1.0 (no attenuation), 1000 cb ≈ silence
    return Math.pow(10, -Math.max(0, cb) / 200);
}

// ── string helpers ─────────────────────────────────────────────────────────────

function readStr(view, offset, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
        const c = view.getUint8(offset + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s.trim();
}

// ── SF2 generator defaults (SF2 spec Table 8.1) ────────────────────────────────

const IGEN_DEFAULTS = {
    2: 0, 3: 0,         // startloop/endloop fine offset
    34: -12000,         // attackVolEnv  → ~1ms
    36: -12000,         // decayVolEnv   → ~1ms
    37: 0,              // sustainVolEnv → full sustain (0 centibels attenuation)
    38: -12000,         // releaseVolEnv → ~1ms
    45: 0, 50: 0,       // startloop/endloop coarse offset
    51: 0,              // coarseTune (semitones)
    52: 0,              // fineTune (cents)
    54: 0,              // sampleModes (bit 0 = loop)
    56: 100,            // scaleTuning (cents/MIDI note)
    58: -1,             // overridingRootKey (−1 = use sample header)
};

// ── parser ─────────────────────────────────────────────────────────────────────

export class SF2Parser {
    /** @type {ArrayBuffer} */  #buf;
    /** @type {DataView} */     #view;

    #phdr = []; // preset headers
    #pbag = []; // preset bags
    #pgen = []; // preset generators
    #inst = []; // instrument headers
    #ibag = []; // instrument bags
    #igen = []; // instrument generators
    #shdr = []; // sample headers

    #smplOff = 0; // byte offset of smpl PCM data in #buf
    #smplLen = 0;

    // Cache decoded AudioBuffers keyed by sample index so shared samples
    // (common in large soundfonts) are only decoded once per buildInstrument call.
    #sampleCache = null;

    /**
     * Parse an SF2 file from an ArrayBuffer. Throws if the buffer is not valid SF2.
     * @param {ArrayBuffer} arrayBuffer
     */
    constructor(arrayBuffer) {
        this.#buf  = arrayBuffer;
        this.#view = new DataView(arrayBuffer);
        this.#parseRiff();
    }

    // ── public API ─────────────────────────────────────────────────────────────

    /**
     * List all presets in the file.
     * @returns {{ index: number, name: string, bank: number, program: number, isPercussion: boolean }[]}
     */
    getPresets() {
        // Last entry is the terminal EOP marker — skip it.
        return this.#phdr.slice(0, -1).map((p, i) => ({
            index:        i,
            name:         p.name,
            bank:         p.bank,
            program:      p.program,
            isPercussion: p.bank === 128,
        }));
    }

    /**
     * Decode all samples for a preset and return SamplerSynth-ready data.
     * Synchronous — PCM is already in the file, no decodeAudioData needed.
     *
     * @param {AudioContext} ctx
     * @param {number} presetIndex  — index into getPresets() results
     * @param {{ voices?: number, stealPolicy?: string }} [options]
     * @returns {{ def: object, zones: object[] }}
     *   def   — instrument definition (type:'sampler', name, voices, filter, …)
     *   zones — decoded zone list for SamplerSynth constructor (has .buffer AudioBuffers)
     */
    buildInstrument(ctx, presetIndex, options = {}) {
        const preset = this.#phdr[presetIndex];
        if (!preset) throw new Error(`SF2: preset ${presetIndex} not found`);

        this.#sampleCache = new Map();
        const zones = this.#extractZones(ctx, presetIndex);
        this.#sampleCache = null;

        if (zones.length === 0)
            throw new Error(`SF2: no usable zones in preset "${preset.name}" (${presetIndex})`);

        const def = {
            type:        'sampler',
            name:        preset.name,
            voices:      options.voices      ?? 8,
            stealPolicy: options.stealPolicy ?? 'oldest',
            filter:      { type: 'allpass', frequency: 20000, Q: 1 },
        };

        return { def, zones };
    }

    /**
     * Build multiple instruments at once, sharing one decode pass per instrument.
     * @param {AudioContext} ctx
     * @param {number[]|null} presetIndices  — null = build all presets
     * @param {object} [options]
     * @returns {Map<number, { def: object, zones: object[] }>}
     */
    buildInstruments(ctx, presetIndices = null, options = {}) {
        const indices = presetIndices ?? this.#phdr.slice(0, -1).map((_, i) => i);
        const result  = new Map();
        for (const i of indices) {
            try {
                result.set(i, this.buildInstrument(ctx, i, options));
            } catch (e) {
                console.warn(`SF2: skipping preset ${i} — ${e.message}`);
            }
        }
        return result;
    }

    // ── RIFF structure parsing ─────────────────────────────────────────────────

    #parseRiff() {
        const v    = this.#view;
        const riff = readStr(v, 0, 4);
        const sfbk = readStr(v, 8, 4);
        if (riff !== 'RIFF' || sfbk !== 'sfbk')
            throw new Error('Not a valid SF2 file (missing RIFF/sfbk header)');

        const totalSize = v.getUint32(4, true);
        this.#walkChunks(12, totalSize - 4);
    }

    #walkChunks(offset, size) {
        const v   = this.#view;
        const end = offset + size;
        while (offset + 8 <= end) {
            const id    = readStr(v, offset, 4);
            const csize = v.getUint32(offset + 4, true);
            const data  = offset + 8;

            if (id === 'LIST') {
                const listType = readStr(v, data, 4);
                if      (listType === 'sdta') this.#parseSdta(data + 4, csize - 4);
                else if (listType === 'pdta') this.#parsePdta(data + 4, csize - 4);
                // INFO list — skip
            }

            // RIFF chunks align to even byte boundaries
            offset += 8 + csize + (csize & 1);
        }
    }

    #parseSdta(offset, size) {
        const v   = this.#view;
        const end = offset + size;
        while (offset + 8 <= end) {
            const id    = readStr(v, offset, 4);
            const csize = v.getUint32(offset + 4, true);
            if (id === 'smpl') { this.#smplOff = offset + 8; this.#smplLen = csize; }
            // sm24 (24-bit extension) — ignored, 16-bit is sufficient
            offset += 8 + csize + (csize & 1);
        }
    }

    #parsePdta(offset, size) {
        const v   = this.#view;
        const end = offset + size;
        while (offset + 8 <= end) {
            const id    = readStr(v, offset, 4);
            const csize = v.getUint32(offset + 4, true);
            const data  = offset + 8;
            switch (id) {
                case 'phdr': this.#parsePhdr(data, csize); break;
                case 'pbag': this.#parsePbag(data, csize); break;
                case 'pgen': this.#parsePgen(data, csize); break;
                case 'inst': this.#parseInst(data, csize); break;
                case 'ibag': this.#parseIbag(data, csize); break;
                case 'igen': this.#parseIgen(data, csize); break;
                case 'shdr': this.#parseShdr(data, csize); break;
            }
            offset += 8 + csize + (csize & 1);
        }
    }

    // ── pdta record parsers ────────────────────────────────────────────────────

    #parsePhdr(off, size) {
        const v = this.#view;
        for (let i = 0, n = size / 38; i < n; i++, off += 38) {
            this.#phdr.push({
                name:    readStr(v, off, 20),
                program: v.getUint16(off + 20, true),
                bank:    v.getUint16(off + 22, true),
                bagIdx:  v.getUint16(off + 24, true),
            });
        }
    }

    #parsePbag(off, size) {
        const v = this.#view;
        for (let i = 0, n = size / 4; i < n; i++, off += 4)
            this.#pbag.push({ genIdx: v.getUint16(off, true), modIdx: v.getUint16(off + 2, true) });
    }

    #parsePgen(off, size) {
        const v = this.#view;
        for (let i = 0, n = size / 4; i < n; i++, off += 4)
            this.#pgen.push({
                oper:   v.getUint16(off,     true),
                amount: v.getInt16 (off + 2, true),
                lo:     v.getUint8 (off + 2),
                hi:     v.getUint8 (off + 3),
            });
    }

    #parseInst(off, size) {
        const v = this.#view;
        for (let i = 0, n = size / 22; i < n; i++, off += 22)
            this.#inst.push({ name: readStr(v, off, 20), bagIdx: v.getUint16(off + 20, true) });
    }

    #parseIbag(off, size) {
        const v = this.#view;
        for (let i = 0, n = size / 4; i < n; i++, off += 4)
            this.#ibag.push({ genIdx: v.getUint16(off, true), modIdx: v.getUint16(off + 2, true) });
    }

    #parseIgen(off, size) {
        const v = this.#view;
        for (let i = 0, n = size / 4; i < n; i++, off += 4)
            this.#igen.push({
                oper:   v.getUint16(off,     true),
                amount: v.getInt16 (off + 2, true),
                lo:     v.getUint8 (off + 2),
                hi:     v.getUint8 (off + 3),
            });
    }

    #parseShdr(off, size) {
        const v = this.#view;
        for (let i = 0, n = size / 46; i < n; i++, off += 46)
            this.#shdr.push({
                name:       readStr(v, off, 20),
                start:      v.getUint32(off + 20, true),
                end:        v.getUint32(off + 24, true),
                loopStart:  v.getUint32(off + 28, true),
                loopEnd:    v.getUint32(off + 32, true),
                sampleRate: v.getUint32(off + 36, true),
                rootKey:    v.getUint8 (off + 40),
                correction: v.getInt8  (off + 41),
                link:       v.getUint16(off + 42, true),
                type:       v.getUint16(off + 44, true),
                // type: 1=mono, 2=right, 4=left, 0x8000+=ROM (skip)
            });
    }

    // ── zone extraction ────────────────────────────────────────────────────────

    // Build a Map of oper→gen from a contiguous slice of igen
    #buildGenMap(from, to) {
        const m = new Map();
        for (let i = from; i < to; i++) m.set(this.#igen[i].oper, this.#igen[i]);
        return m;
    }

    // Read a generator value, falling back to the global zone then the spec default
    #gv(map, oper, global) {
        const g = map.get(oper) ?? global?.get(oper);
        if (g) return g.amount;
        return IGEN_DEFAULTS[oper] ?? 0;
    }

    #extractZones(ctx, presetIndex) {
        const zones      = [];
        const preset     = this.#phdr[presetIndex];
        const nextPreset = this.#phdr[presetIndex + 1];

        // Walk preset bags to find instrument references
        for (let pb = preset.bagIdx; pb < nextPreset.bagIdx; pb++) {
            const pBag     = this.#pbag[pb];
            const pBagNext = this.#pbag[pb + 1];

            // Collect preset-level generators for this bag
            const pGens = new Map();
            for (let gi = pBag.genIdx; gi < pBagNext.genIdx; gi++) {
                const g = this.#pgen[gi];
                pGens.set(g.oper, g);
            }

            // Generator 41 = instrument reference; absent → global preset bag
            const instGen = pGens.get(41);
            if (!instGen) continue;

            const instIdx  = instGen.amount;
            const inst     = this.#inst[instIdx];
            const nextInst = this.#inst[instIdx + 1];
            if (!inst || !nextInst) continue;

            // Walk instrument bags; first bag with no sampleID is the global zone
            let globalGen = null;
            let seenFirst = false;

            for (let ib = inst.bagIdx; ib < nextInst.bagIdx; ib++) {
                const iBag     = this.#ibag[ib];
                const iBagNext = this.#ibag[ib + 1];
                const iGens    = this.#buildGenMap(iBag.genIdx, iBagNext.genIdx);

                // Global zone: first bag without a sampleID generator
                if (!seenFirst && !iGens.has(53)) {
                    globalGen = iGens;
                    seenFirst = true;
                    continue;
                }
                seenFirst = true;

                const sampleGen = iGens.get(53);
                if (!sampleGen) continue; // no sample — skip

                const sampleIdx = sampleGen.amount & 0xFFFF;
                const sample    = this.#shdr[sampleIdx];
                if (!sample) continue;

                // Skip ROM samples and the terminal EOS record
                if (sample.type & 0x8000) continue;
                if (sample.name === 'EOS' || sample.end <= sample.start) continue;

                // Right-channel halves of stereo pairs: skip here, decoded via left
                if (sample.type === 2) continue;

                // ── key / velocity range ──────────────────────────────────────
                const kr    = iGens.get(43) ?? globalGen?.get(43);
                const vr    = iGens.get(44) ?? globalGen?.get(44);
                const loNote = kr ? kr.lo : 0;
                const hiNote = kr ? kr.hi : 127;
                const loVel  = vr ? vr.lo : 0;
                const hiVel  = vr ? vr.hi : 127;

                // ── root key + coarse tuning ──────────────────────────────────
                const overrideKey = this.#gv(iGens, 58, globalGen);
                const coarseTune  = this.#gv(iGens, 51, globalGen);
                let   rootNote    = (overrideKey >= 0 && overrideKey <= 127)
                    ? overrideKey
                    : sample.rootKey;
                // Fold coarse semitone shift into root note (inverted: higher tune = lower root)
                rootNote = Math.max(0, Math.min(127, rootNote - coarseTune));

                // ── loop points ───────────────────────────────────────────────
                const modes   = this.#gv(iGens, 54, globalGen);
                const doLoop  = (modes & 1) !== 0;
                let loopStart = null;
                let loopEnd   = null;

                if (doLoop && sample.loopEnd > sample.loopStart) {
                    // Fine + coarse offsets from zone generators adjust the sample-header loop points
                    const lsOff = this.#gv(iGens, 2,  globalGen)
                                + this.#gv(iGens, 45, globalGen) * 32768;
                    const leOff = this.#gv(iGens, 3,  globalGen)
                                + this.#gv(iGens, 50, globalGen) * 32768;
                    // Relative to this sample's start frame, converted to seconds
                    loopStart = Math.max(0, sample.loopStart + lsOff - sample.start) / sample.sampleRate;
                    loopEnd   = Math.max(0, sample.loopEnd   + leOff - sample.start) / sample.sampleRate;
                }

                // ── volume envelope ───────────────────────────────────────────
                const envelope = {
                    attack:  Math.max(0.001, tcToSec(this.#gv(iGens, 34, globalGen))),
                    decay:   Math.max(0.001, tcToSec(this.#gv(iGens, 36, globalGen))),
                    sustain: Math.min(1, cbToGain(this.#gv(iGens, 37, globalGen))),
                    release: Math.max(0.02,  tcToSec(this.#gv(iGens, 38, globalGen))),
                };

                // ── decode PCM ────────────────────────────────────────────────
                const buffer = this.#decodeBuffer(ctx, sample, sampleIdx);
                if (!buffer) continue;

                zones.push({ loNote, hiNote, loVel, hiVel, rootNote, loopStart, loopEnd, envelope, buffer });
            }
        }

        return zones;
    }

    // ── sample decoding ────────────────────────────────────────────────────────

    #decodeBuffer(ctx, sample, sampleIdx) {
        // Return cached buffer if this sample was already decoded this pass
        if (this.#sampleCache?.has(sampleIdx)) return this.#sampleCache.get(sampleIdx);

        const len = sample.end - sample.start;
        if (len <= 0) return null;

        // Check the right-channel partner for stereo (left sample type = 4)
        const isLeft      = sample.type === 4;
        const rightSample = isLeft ? this.#shdr[sample.link] : null;
        const isLinked    = isLeft && rightSample?.type === 2
                          && (rightSample.end - rightSample.start) >= len;

        const channels = isLinked ? 2 : 1;
        const buf      = ctx.createBuffer(channels, len, sample.sampleRate);

        this.#fillChannel(buf.getChannelData(0), sample.start, len);
        if (isLinked) this.#fillChannel(buf.getChannelData(1), rightSample.start, len);

        this.#sampleCache?.set(sampleIdx, buf);
        return buf;
    }

    #fillChannel(dest, sampleStart, len) {
        const byteOff = this.#smplOff + sampleStart * 2;
        const v       = this.#view;
        for (let i = 0; i < len; i++) {
            dest[i] = v.getInt16(byteOff + i * 2, true) / 32768;
        }
    }
}
