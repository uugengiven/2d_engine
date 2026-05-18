const SCHEDULE_AHEAD = 0.1;  // seconds to look ahead
const TICK_MS = 25;           // scheduler poll interval in ms

/**
 * Pattern format:
 * {
 *   ticksPerBeat: 4,   // subdivision (4 = 16th notes)
 *   length: 16,        // total rows
 *   tracks: [
 *     {
 *       id: 'lead',
 *       instrument: OscSynth,
 *       events: [
 *         { row: 0, note: 60, velocity: 0.8, length: 2 }
 *       ]
 *     }
 *   ]
 * }
 *
 * `note` uses MIDI numbers (60 = middle C).
 * `length` is in rows; omit or set to 1 for a single-row note.
 */
export class Sequencer {
    /** @type {AudioContext} */ #ctx;
    #bpm = 120;
    #pattern = null;
    #ticksPerBeat = 4;
    #currentRow = 0;
    #nextRowTime = 0;
    #timerId = null;
    #running = false;
    #loop = true;
    onLoopEnd = null; // called at each loop boundary — used by song arrangement

    // { time: number, instrument: OscSynth, note: number }[]
    #pendingNoteOffs = [];

    /** @param {AudioContext} ctx */
    constructor(ctx) {
        this.#ctx = ctx;
    }

    // ─── public API ──────────────────────────────────────────────────────────

    get bpm() { return this.#bpm; }
    set bpm(v) {
        this.#bpm = Math.max(1, Math.min(999, v));
    }

    get running() { return this.#running; }
    get currentRow() { return this.#currentRow; }

    /** @param {boolean} v */
    set loop(v) { this.#loop = v; }

    /**
     * @param {object} pattern
     */
    setPattern(pattern) {
        this.#pattern = pattern;
        this.#ticksPerBeat = pattern.ticksPerBeat ?? 4;
    }

    start() {
        if (this.#running || !this.#pattern) return;
        this.#running = true;
        this.#currentRow = 0;
        this.#nextRowTime = this.#ctx.currentTime + 0.05;
        this.#pendingNoteOffs = [];
        this.#tick();
    }

    stop() {
        this.#running = false;
        clearTimeout(this.#timerId);
        this.#timerId = null;
        this.#currentRow = 0;
        this.#pendingNoteOffs = [];
        this.#allNotesOff();
    }

    pause() {
        if (!this.#running) return;
        this.#running = false;
        clearTimeout(this.#timerId);
        this.#allNotesOff();
    }

    resume() {
        if (this.#running || !this.#pattern) return;
        this.#running = true;
        this.#nextRowTime = this.#ctx.currentTime + 0.05;
        this.#tick();
    }

    // ─── internal helpers ────────────────────────────────────────────────────

    #allNotesOff() {
        if (!this.#pattern) return;
        for (const track of this.#pattern.tracks) {
            track.instrument?.allNotesOff?.();
        }
    }

    // ─── scheduler ───────────────────────────────────────────────────────────

    #rowDuration() {
        return 60 / this.#bpm / this.#ticksPerBeat;
    }

    #tick() {
        if (!this.#running || !this.#pattern) return;

        const { length, tracks } = this.#pattern;
        const horizon = this.#ctx.currentTime + SCHEDULE_AHEAD;

        while (this.#nextRowTime < horizon) {
            this.#scheduleRow(this.#currentRow, this.#nextRowTime, tracks);
            this.#nextRowTime += this.#rowDuration();
            this.#currentRow++;

            if (this.#currentRow >= length) {
                if (this.#loop) {
                    this.#currentRow = 0;
                    this.onLoopEnd?.();
                } else {
                    this.#running = false;
                    return;
                }
            }
        }

        // Fire any pending noteOffs that are now within range
        this.#flushNoteOffs();

        this.#timerId = setTimeout(() => this.#tick(), TICK_MS);
    }

    #scheduleRow(row, time, tracks) {
        const rowDur = this.#rowDuration();

        for (const track of tracks) {
            for (const evt of track.events) {
                if (evt.row !== row) continue;

                // noteOn at the exact scheduled audio time
                track.instrument.noteOn(evt.note, evt.velocity ?? 0.8, time);

                // Store noteOff for later dispatch, tagged with this note's start
                // time so stale noteOffs (after voice stealing) can be ignored.
                const noteOffTime = time + (evt.length ?? 1) * rowDur - 0.005;
                this.#pendingNoteOffs.push({
                    time: noteOffTime,
                    instrument: track.instrument,
                    note: evt.note,
                    noteStartTime: time,
                });
            }
        }

        // Keep sorted by time so flushNoteOffs can process in order
        this.#pendingNoteOffs.sort((a, b) => a.time - b.time);
    }

    #flushNoteOffs() {
        const now = this.#ctx.currentTime + SCHEDULE_AHEAD;
        while (this.#pendingNoteOffs.length > 0 && this.#pendingNoteOffs[0].time <= now) {
            const { time, instrument, note, noteStartTime } = this.#pendingNoteOffs.shift();
            // Delay the JS call so it fires close to the actual audio time
            const delayMs = Math.max(0, (time - this.#ctx.currentTime) * 1000);
            setTimeout(() => instrument.noteOff(note, noteStartTime), delayMs);
        }
    }
}
