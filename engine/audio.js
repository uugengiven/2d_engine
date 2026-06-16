import { OscSynth }     from './synth.js';
import { FmSynth }      from './fm-synth.js';
import { SamplerSynth } from './sampler-synth.js';
import { SF2Parser }    from './sf2-parser.js';

function generateIR(context, duration = 2.0, decay = 2.0) {
    const length = Math.ceil(context.sampleRate * duration);
    const ir = context.createBuffer(2, length, context.sampleRate);
    for (let c = 0; c < 2; c++) {
        const data = ir.getChannelData(c);
        for (let i = 0; i < length; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
        }
    }
    return ir;
}

class Channel {
    /** @type {GainNode} */ #volumeNode;
    /** @type {BiquadFilterNode|null} */ #filterNode = null;
    /** @type {GainNode|null} */ #dryGain = null;
    /** @type {GainNode|null} */ #wetGain = null;

    /**
     * @param {AudioContext} context
     * @param {AudioNode} destination
     * @param {ChannelOptions} options
     */
    constructor(context, destination, options = {}) {
        this.#volumeNode = context.createGain();
        this.#volumeNode.gain.value = options.volume ?? 1.0;

        let last = this.#volumeNode;

        if (options.filter) {
            this.#filterNode = context.createBiquadFilter();
            this.#filterNode.type = 'lowpass';
            this.#filterNode.frequency.value = options.filter.cutoff ?? 8000;
            this.#filterNode.Q.value = options.filter.resonance ?? 1.0;
            last.connect(this.#filterNode);
            last = this.#filterNode;
        }

        if (options.reverb != null && options.reverb !== false) {
            const opts = typeof options.reverb === 'number' ? { wet: options.reverb } : options.reverb;
            const wet = Math.max(0, Math.min(1, opts.wet ?? 0.3));

            this.#dryGain = context.createGain();
            this.#wetGain = context.createGain();
            this.#dryGain.gain.value = 1 - wet;
            this.#wetGain.gain.value = wet;

            const convolver = context.createConvolver();
            convolver.buffer = generateIR(context, opts.duration ?? 2.0, opts.decay ?? 2.0);

            const reverbOut = context.createGain();
            last.connect(this.#dryGain);
            last.connect(convolver);
            convolver.connect(this.#wetGain);
            this.#dryGain.connect(reverbOut);
            this.#wetGain.connect(reverbOut);
            reverbOut.connect(destination);
            return;
        }

        last.connect(destination);
    }

    /** @returns {AudioNode} */
    get inputNode() { return this.#volumeNode; }

    get volume() { return this.#volumeNode.gain.value; }
    set volume(v) { this.#volumeNode.gain.value = Math.max(0, v); }

    /** @param {number} wet 0–1 */
    setReverbWet(wet) {
        if (!this.#dryGain || !this.#wetGain) return;
        const clamped = Math.max(0, Math.min(1, wet));
        this.#dryGain.gain.value = 1 - clamped;
        this.#wetGain.gain.value = clamped;
    }

    /** @param {number} hz */
    setFilterCutoff(hz) {
        if (this.#filterNode) this.#filterNode.frequency.value = hz;
    }
}

export class Sound {
    /** @type {AudioBuffer} */ #buffer;
    /** @type {Channel} */ #channel;
    /** @type {AudioContext} */ #context;
    /** @type {AudioBufferSourceNode|null} */ #source = null;
    /** @type {GainNode|null} */ #gainNode = null;
    #startTime = 0;
    #pauseOffset = 0;
    #playing = false;
    #loop;
    #loopTimeout = null;
    #listeners = { stop: [], end: [], loop: [] };

    /** Default volume for this sound (0–1). Can be overridden per play() call. */
    volume = 1.0;
    /** Default stereo pan (-1 left, 0 center, 1 right). Can be overridden per play() call. */
    pan = 0;
    /** Default playback rate multiplier. 2.0 = one octave up. Can be overridden per play() call. */
    pitch = 1.0;

    /**
     * @param {AudioBuffer} buffer
     * @param {Channel} channel
     * @param {AudioContext} context
     * @param {SoundOptions} options
     */
    constructor(buffer, channel, context, options = {}) {
        this.#buffer = buffer;
        this.#channel = channel;
        this.#context = context;
        this.#loop = options.loop ?? false;
        if (options.volume != null) this.volume = options.volume;
        if (options.pan != null) this.pan = options.pan;
        if (options.pitch != null) this.pitch = options.pitch;
    }

    get playing() { return this.#playing; }
    get duration() { return this.#buffer.duration; }

    get currentTime() {
        if (!this.#playing) return this.#pauseOffset;
        const raw = this.#pauseOffset + (this.#context.currentTime - this.#startTime);
        return this.#loop ? raw % this.#buffer.duration : Math.min(raw, this.#buffer.duration);
    }

    #buildChain(options) {
        this.#gainNode?.disconnect();
        this.#gainNode = this.#context.createGain();
        this.#gainNode.gain.value = options.volume ?? this.volume;

        let last = this.#gainNode;

        const pan = options.pan ?? this.pan;
        if (pan !== 0) {
            const panner = this.#context.createStereoPanner();
            panner.pan.value = pan;
            last.connect(panner);
            last = panner;
        }

        last.connect(this.#channel.inputNode);
    }

    #startPlayback(offset, options = {}) {
        this.#buildChain(options);

        this.#source = this.#context.createBufferSource();
        this.#source.buffer = this.#buffer;
        this.#source.loop = this.#loop;
        this.#source.playbackRate.value = options.pitch ?? this.pitch;
        this.#source.connect(this.#gainNode);
        this.#source.onended = () => this.#onEnded();

        this.#pauseOffset = offset;
        this.#startTime = this.#context.currentTime;
        this.#source.start(this.#context.currentTime, offset);
        this.#playing = true;

        if (this.#loop) this.#scheduleLoopEvent();
    }

    #onEnded() {
        if (!this.#playing) return; // manually stopped — already handled
        clearTimeout(this.#loopTimeout);
        this.#playing = false;
        this.#pauseOffset = 0;
        this.#emit('end');
        this.#emit('stop');
    }

    #scheduleLoopEvent() {
        clearTimeout(this.#loopTimeout);
        if (!this.#loop || !this.#playing) return;
        const bufferPos = (this.#pauseOffset + (this.#context.currentTime - this.#startTime)) % this.#buffer.duration;
        const msUntilLoop = (this.#buffer.duration - bufferPos) * 1000;
        this.#loopTimeout = setTimeout(() => {
            if (!this.#playing) return;
            this.#emit('loop');
            this.#scheduleLoopEvent();
        }, msUntilLoop);
    }

    /**
     * Play from the beginning. If already playing, restarts.
     * @param {{ volume?: number, pan?: number, pitch?: number }} [options]
     * @returns {this}
     */
    play(options = {}) {
        if (this.#playing) {
            this.#playing = false;
            clearTimeout(this.#loopTimeout);
            try { this.#source?.stop(); } catch {}
        }
        const start = () => this.#startPlayback(0, options);
        if (this.#context.state === 'suspended') {
            this.#context.resume().then(start);
        } else {
            start();
        }
        return this;
    }

    /** Pause at the current position. Call resume() to continue. @returns {this} */
    pause() {
        if (!this.#playing) return this;
        clearTimeout(this.#loopTimeout);
        const pos = this.currentTime;
        this.#playing = false;
        try { this.#source?.stop(); } catch {}
        this.#pauseOffset = pos;
        return this;
    }

    /** Continue from a paused position. @returns {this} */
    resume() {
        if (this.#playing) return this;
        const offset = this.#pauseOffset;
        const start = () => this.#startPlayback(offset);
        if (this.#context.state === 'suspended') {
            this.#context.resume().then(start);
        } else {
            start();
        }
        return this;
    }

    /** Stop playback and reset position to the beginning. @returns {this} */
    stop() {
        const hadActivity = this.#playing || this.#pauseOffset > 0;
        clearTimeout(this.#loopTimeout);
        this.#playing = false;
        this.#pauseOffset = 0;
        try { this.#source?.stop(); } catch {}
        if (hadActivity) this.#emit('stop');
        return this;
    }

    /**
     * Subscribe to a playback event.
     * - `'end'`  — non-looping sound reached its natural end
     * - `'stop'` — sound stopped for any reason (natural end or explicit stop())
     * - `'loop'` — looping sound completed one cycle (approximate, ±15ms)
     * @param {'end'|'stop'|'loop'} event
     * @param {(sound: Sound) => void} cb
     * @returns {this}
     */
    on(event, cb) {
        this.#listeners[event]?.push(cb);
        return this;
    }

    /** @param {'end'|'stop'|'loop'} event @param {(sound: Sound) => void} cb @returns {this} */
    off(event, cb) {
        const arr = this.#listeners[event];
        if (arr) {
            const i = arr.indexOf(cb);
            if (i !== -1) arr.splice(i, 1);
        }
        return this;
    }

    #emit(event) {
        for (const cb of this.#listeners[event]) cb(this);
    }
}

export class AudioManager {
    /** @type {AudioContext|null} */ #context = null;
    /** @type {Map<string, Channel>} */ #channels = new Map();
    /** @type {Channel|null} */ #defaultChannel = null;
    /** @type {DynamicsCompressorNode|null} */ #masterCompressor = null;
    /** @type {GainNode|null} */ #masterGain = null;
    #workletLoaded = false;
    #fmWorkletLoaded = false;

    #ensureContext() {
        if (this.#context) return;
        this.#context = new AudioContext();
        this.#masterCompressor = this.#context.createDynamicsCompressor();
        this.#masterGain = this.#context.createGain();
        this.#masterCompressor.connect(this.#masterGain);
        this.#masterGain.connect(this.#context.destination);
        this.#defaultChannel = new Channel(this.#context, this.#masterCompressor, {});
    }

    /**
     * Define a named audio channel with optional processing. Call before load().
     * @param {string} name
     * @param {ChannelOptions} [options]
     * @returns {Channel}
     *
     * @example
     * audio.createChannel('music', { volume: 0.8, reverb: 0.35 });
     * audio.createChannel('sfx',   { volume: 1.0 });
     * audio.createChannel('menu',  { volume: 1.0 }); // clean, no reverb
     */
    createChannel(name, options = {}) {
        this.#ensureContext();
        const ch = new Channel(this.#context, this.#masterCompressor, options);
        this.#channels.set(name, ch);
        return ch;
    }

    /** @param {string} name @returns {Channel|null} */
    getChannel(name) {
        return this.#channels.get(name) ?? null;
    }

    /**
     * Fetch and decode an audio file. Returns a ready-to-play Sound.
     * @param {string} url
     * @param {{ channel?: string, loop?: boolean, volume?: number, pan?: number, pitch?: number }} [options]
     * @returns {Promise<Sound>}
     *
     * @example
     * const jump = await audio.load('jump.mp3');
     * const bgm  = await audio.load('theme.mp3', { channel: 'music', loop: true });
     */
    async load(url, options = {}) {
        this.#ensureContext();
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await this.#context.decodeAudioData(arrayBuffer);
        const ch = options.channel
            ? (this.#channels.get(options.channel) ?? this.#defaultChannel)
            : this.#defaultChannel;
        return new Sound(audioBuffer, ch, this.#context, options);
    }

    /**
     * Load an instrument definition from a JSON file and return a ready-to-play OscSynth.
     * @param {string} url
     * @param {{ channel?: string, voices?: number }} [options]
     * @returns {Promise<OscSynth>}
     *
     * @example
     * const lead = await audio.loadInstrument('instruments/nes-pulse-25.json', { channel: 'sfx' });
     * lead.noteOn(60, 0.8);
     */
    /**
     * Register the synth AudioWorklet module. Called automatically by loadInstrument(),
     * but can be called explicitly before constructing OscSynth instances directly.
     * @param {string} [moduleUrl]  defaults to './engine/synth-worklet.js'
     * @returns {Promise<void>}
     */
    async loadSynthWorklet(moduleUrl = '/engine/synth-worklet.js') {
        this.#ensureContext();
        if (!this.#workletLoaded) {
            await this.#context.audioWorklet.addModule(moduleUrl);
            this.#workletLoaded = true;
        }
    }

    async loadFmWorklet(moduleUrl = '/engine/fm-worklet.js') {
        this.#ensureContext();
        if (!this.#fmWorkletLoaded) {
            await this.#context.audioWorklet.addModule(moduleUrl);
            this.#fmWorkletLoaded = true;
        }
    }

    /**
     * Load an instrument definition from a JSON file. Returns OscSynth or FmSynth
     * depending on the `type` field in the JSON ("osc" or "fm").
     * @param {string} url
     * @param {{ channel?: string, voices?: number }} [options]
     * @returns {Promise<OscSynth|FmSynth>}
     */
    async loadInstrument(url, options = {}) {
        this.#ensureContext();
        const response = await fetch(url);
        const def = await response.json();
        const ch = options.channel
            ? (this.#channels.get(options.channel) ?? this.#defaultChannel)
            : this.#defaultChannel;
        if (def.type === 'fm') {
            await this.loadFmWorklet();
            return new FmSynth(this.#context, ch, def, { voices: options.voices });
        }
        if (def.type === 'sampler') {
            return SamplerSynth.load(this.#context, ch, def, url, { voices: options.voices });
        }
        await this.loadSynthWorklet();
        return new OscSynth(this.#context, ch, def, { voices: options.voices });
    }

    async loadFmInstrument(url, options = {}) {
        this.#ensureContext();
        await this.loadFmWorklet();
        const response = await fetch(url);
        const def = await response.json();
        const ch = options.channel
            ? (this.#channels.get(options.channel) ?? this.#defaultChannel)
            : this.#defaultChannel;
        return new FmSynth(this.#context, ch, def, { voices: options.voices });
    }

    /**
     * Fetch an SF2 file and return a parsed SF2Parser ready for instrument extraction.
     * Call parser.getPresets() to list available presets, then buildSF2Instrument()
     * to decode the ones you want into live SamplerSynth instances.
     * @param {string} url
     * @returns {Promise<SF2Parser>}
     */
    async loadSF2(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`SF2 load failed (${response.status}): ${url}`);
        const buf = await response.arrayBuffer();
        return new SF2Parser(buf);
    }

    /**
     * Decode a preset from a parsed SF2Parser into a live SamplerSynth.
     * Synchronous sample decoding happens here — call at load time, not mid-frame.
     * @param {SF2Parser} parser
     * @param {number} presetIndex          — from parser.getPresets()[n].index
     * @param {{ channel?: string, voices?: number, stealPolicy?: string }} [options]
     * @returns {SamplerSynth}
     */
    buildSF2Instrument(parser, presetIndex, options = {}) {
        this.#ensureContext();
        const ch = options.channel
            ? (this.#channels.get(options.channel) ?? this.#defaultChannel)
            : this.#defaultChannel;
        const { def, zones } = parser.buildInstrument(this.#context, presetIndex, options);
        return new SamplerSynth(this.#context, ch, def, zones, options);
    }

    /**
     * Unlock audio after a user gesture. Call once from a click/keydown handler.
     * Sounds will auto-resume from suspension on play() as well, but calling this
     * explicitly avoids the first-play delay.
     * @returns {Promise<void>}
     */
    async resume() {
        if (this.#context?.state === 'suspended') {
            await this.#context.resume();
        }
    }

    /** The underlying AudioContext. Initializes lazily; use after a user gesture. */
    get context() {
        this.#ensureContext();
        return this.#context;
    }

    get volume() { return this.#masterGain?.gain.value ?? 1.0; }
    set volume(v) {
        this.#ensureContext();
        this.#masterGain.gain.value = Math.max(0, v);
    }

    /** Combined hardware output latency in seconds. Useful for AV sync. */
    get baseLatency() {
        return (this.#context?.baseLatency ?? 0) + (this.#context?.outputLatency ?? 0);
    }
}

/**
 * @typedef {{ volume?: number, reverb?: number | { wet?: number, duration?: number, decay?: number }, filter?: { cutoff?: number, resonance?: number } }} ChannelOptions
 * @typedef {{ channel?: string, loop?: boolean, volume?: number, pan?: number, pitch?: number }} SoundOptions
 */
