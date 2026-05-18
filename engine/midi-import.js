/**
 * Minimal MIDI file parser for the tracker.
 *
 * Supports format 0 (single track, multi-channel) and format 1 (multi-track).
 * Standard time division only (ticks per quarter note — not SMPTE).
 *
 * Usage:
 *   const result = parseMidi(arrayBuffer, 4);
 *   // result.tracks is ready to drop into the tracker's track/cell structure
 */

// ── binary helpers ────────────────────────────────────────────────────────────

function readStr(view, pos, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(pos + i));
    return s;
}

/** MIDI variable-length integer. Returns { value, bytes }. */
function readVarLen(view, pos) {
    let value = 0, bytes = 0, b;
    do {
        b = view.getUint8(pos + bytes++);
        value = (value << 7) | (b & 0x7F);
    } while (b & 0x80);
    return { value, bytes };
}

// ── track chunk parser ────────────────────────────────────────────────────────

/**
 * Parse one MTrk chunk into a flat event list with absolute tick timestamps.
 * @returns {Array<object>}
 */
function parseTrack(view, start, byteLen) {
    const events = [];
    let pos = start;
    const end = start + byteLen;
    let tick = 0;
    let runStatus = 0;

    while (pos < end) {
        // Delta time
        const dt = readVarLen(view, pos);
        pos += dt.bytes;
        tick += dt.value;

        const first = view.getUint8(pos);

        // ── Meta event ──────────────────────────────────────────────────────
        if (first === 0xFF) {
            pos++;
            const metaType = view.getUint8(pos++);
            const ml = readVarLen(view, pos);
            pos += ml.bytes;
            const mStart = pos;
            pos += ml.value;

            if (metaType === 0x51 && ml.value === 3) {
                // Tempo: microseconds per quarter note
                const us = (view.getUint8(mStart) << 16)
                         | (view.getUint8(mStart + 1) << 8)
                         |  view.getUint8(mStart + 2);
                events.push({ type: 'tempo', tick, us });

            } else if (metaType === 0x03) {
                // Track name
                events.push({ type: 'trackName', tick, name: readStr(view, mStart, ml.value) });

            } else if (metaType === 0x2F) {
                break; // end of track
            }
            // All other meta types are silently skipped

        // ── SysEx ───────────────────────────────────────────────────────────
        } else if (first === 0xF0 || first === 0xF7) {
            pos++;
            const sl = readVarLen(view, pos);
            pos += sl.bytes + sl.value;

        // ── Channel event ────────────────────────────────────────────────────
        } else {
            if (first & 0x80) {
                runStatus = first;
                pos++;
            }
            // else: running status — don't advance pos

            const type = (runStatus >> 4) & 0x0F;
            const ch   =  runStatus       & 0x0F;

            switch (type) {
                case 0x8: { // Note off
                    const note = view.getUint8(pos++);
                    const vel  = view.getUint8(pos++);
                    events.push({ type: 'noteOff', tick, ch, note, vel });
                    break;
                }
                case 0x9: { // Note on (vel=0 counts as note-off)
                    const note = view.getUint8(pos++);
                    const vel  = view.getUint8(pos++);
                    events.push({ type: vel > 0 ? 'noteOn' : 'noteOff', tick, ch, note, vel });
                    break;
                }
                case 0xA: pos += 2; break; // Polyphonic aftertouch
                case 0xB: pos += 2; break; // Control change
                case 0xC: pos += 1; break; // Program change
                case 0xD: pos += 1; break; // Channel pressure
                case 0xE: pos += 2; break; // Pitch bend
                default:  pos += 1; break; // Unknown — try to continue
            }
        }
    }

    return events;
}

// ── note assembly ─────────────────────────────────────────────────────────────

/**
 * Walk a flat event list and pair note-ons with note-offs into complete notes.
 * Overlapping notes on the same pitch (e.g. retrigger before noteOff) are ended
 * at the moment of retrigger, matching standard DAW behaviour.
 */
function collectNotes(events, channelData) {
    const pending = new Map(); // `ch_note` → { tick, vel }
    let trackName = '';

    for (const ev of events) {
        if (ev.type === 'trackName') { trackName = ev.name; continue; }

        if (ev.type === 'noteOn') {
            const key = `${ev.ch}_${ev.note}`;
            const prev = pending.get(key);
            if (prev) {
                // Implicit end of the previous note at retrigger point
                ensureChannel(channelData, ev.ch, trackName).push({
                    tick: prev.tick, note: ev.note,
                    velocity: prev.vel / 127,
                    durTicks: Math.max(1, ev.tick - prev.tick),
                });
            }
            pending.set(key, { tick: ev.tick, vel: ev.vel });

        } else if (ev.type === 'noteOff') {
            const key = `${ev.ch}_${ev.note}`;
            const start = pending.get(key);
            if (!start) continue;
            pending.delete(key);
            ensureChannel(channelData, ev.ch, trackName).push({
                tick: start.tick, note: ev.note,
                velocity: start.vel / 127,
                durTicks: Math.max(1, ev.tick - start.tick),
            });
        }
    }
    // Any notes still in pending had no matching noteOff — discard them.
}

function ensureChannel(channelData, ch, trackName) {
    if (!channelData.has(ch)) channelData.set(ch, { name: trackName, notes: [] });
    else if (!channelData.get(ch).name) channelData.get(ch).name = trackName;
    return channelData.get(ch).notes;
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Parse a MIDI file from an ArrayBuffer.
 *
 * @param {ArrayBuffer} buffer
 * @param {number} [targetTicksPerBeat=4]
 *   Tracker resolution — 4 = 16th notes, 8 = 32nd notes.
 *   Notes are quantised to the nearest row at this resolution.
 * @param {number} [maxRows=128]
 *   Hard cap on pattern length; notes beyond this are silently dropped.
 *
 * @returns {{
 *   format: number,
 *   bpm: number,
 *   ticksPerBeat: number,
 *   patternLength: number,
 *   tracks: Array<{ channel, isDrum, name, events: Array<{row,note,velocity,length}> }>
 * }}
 */
export function parseMidi(buffer, targetTicksPerBeat = 4, maxRows = 128) {
    const view = new DataView(buffer);
    let pos = 0;

    // ── Header ────────────────────────────────────────────────────────────────
    if (readStr(view, pos, 4) !== 'MThd') throw new Error('Not a valid MIDI file (missing MThd)');
    pos += 4 + 4; // tag + chunk length (always 6)

    const format  = view.getUint16(pos); pos += 2;
    const nTracks = view.getUint16(pos); pos += 2;
    const tickDiv = view.getUint16(pos); pos += 2;

    if (tickDiv & 0x8000) throw new Error('SMPTE timecode MIDI is not supported');

    // ── Track chunks ──────────────────────────────────────────────────────────
    const rawTracks = [];
    for (let t = 0; t < nTracks && pos < view.byteLength; t++) {
        if (readStr(view, pos, 4) !== 'MTrk') throw new Error(`Expected MTrk at byte ${pos}`);
        pos += 4;
        const len = view.getUint32(pos); pos += 4;
        rawTracks.push(parseTrack(view, pos, len));
        pos += len;
    }

    // ── Tempo (first event wins; default 120 BPM) ─────────────────────────────
    let bpm = 120;
    outer: for (const events of rawTracks) {
        for (const ev of events) {
            if (ev.type === 'tempo') {
                bpm = Math.max(1, Math.round(60_000_000 / ev.us));
                break outer;
            }
        }
    }

    // ── Collect notes per MIDI channel ────────────────────────────────────────
    // Format 0: one track, events split across channels
    // Format 1: track 0 is meta-only; tracks 1+ carry notes
    const channelData = new Map(); // ch → { name, notes[] }
    for (const events of rawTracks) {
        collectNotes(events, channelData);
    }

    // ── Convert to tracker rows ───────────────────────────────────────────────
    const tpbRatio = targetTicksPerBeat / tickDiv; // rows per MIDI tick
    let maxRow = 0;

    const tracks = [];
    for (const [channel, { name, notes }] of channelData) {
        if (notes.length === 0) continue;

        const events = [];
        for (const n of notes) {
            const row = Math.round(n.tick * tpbRatio);
            if (row >= maxRows) continue; // beyond the pattern cap
            const length = Math.min(
                Math.max(1, Math.round(n.durTicks * tpbRatio)),
                maxRows - row,
            );
            maxRow = Math.max(maxRow, row + length);
            events.push({
                row,
                note:     n.note,
                velocity: Math.round(n.velocity * 100) / 100,
                length,
            });
        }

        if (events.length === 0) continue;
        events.sort((a, b) => a.row - b.row);

        tracks.push({
            channel,
            isDrum: channel === 9, // GM drum channel
            name:   name || `Ch ${channel + 1}`,
            events,
        });
    }

    // Round pattern length up to the nearest bar (4 beats)
    const rowsPerBar = targetTicksPerBeat * 4;
    const patternLength = Math.min(
        maxRows,
        Math.max(rowsPerBar, Math.ceil(maxRow / rowsPerBar) * rowsPerBar),
    );

    return { format, bpm, ticksPerBeat: targetTicksPerBeat, patternLength, tracks };
}
