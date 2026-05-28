const STANDARD_BUTTONS = {
    a: 0, b: 1, x: 2, y: 3,
    lb: 4, rb: 5, lt: 6, rt: 7,
    select: 8, start: 9,
    l3: 10, r3: 11,
    up: 12, down: 13, left: 14, right: 15,
};

export class Input {
    // Live state — written immediately by events, never read by the game
    #liveKeys = new Set();
    #liveMouse = { x: 0, y: 0, pageX: 0, pageY: 0, buttons: new Set(), scrollDX: 0, scrollDY: 0 };
    #liveMidi = { notes: new Map(), cc: new Map() };

    // Snapshot state — copied from live on update(), read by all query methods
    #keys = new Set();
    #mouse = { x: 0, y: 0, pageX: 0, pageY: 0, buttons: new Set(), scrollDX: 0, scrollDY: 0 };
    #gamepads = [];
    #midi = { notes: new Map(), cc: new Map() };

    #canvas;
    #internalWidth;
    #internalHeight;
    #captureResolve = null;

    // Codes whose browser default action is suppressed (KeyboardEvent.code or 'Mouse0'/'Mouse1'/'Mouse2')
    #preventedKeys      = new Set();
    #preventedMouseBtns = new Set();

    /**
     * @param {HTMLCanvasElement} canvas
     * @param {number} width  Internal engine resolution width
     * @param {number} height Internal engine resolution height
     */
    constructor(canvas, width, height) {
        this.#canvas = canvas;
        this.#internalWidth = width;
        this.#internalHeight = height;
        this.#attach();
    }

    #isFormTarget(target) {
        const tag = target.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
    }

    #onKeyDown = (e) => {
        if (this.#isFormTarget(e.target)) return;
        if (this.#preventedKeys.has(e.code)) e.preventDefault();
        this.#liveKeys.add(e.code);
        if (this.#captureResolve) {
            this.#captureResolve({ source: 'keyboard', code: e.code });
            this.#captureResolve = null;
        }
    };

    #onKeyUp = (e) => {
        if (this.#isFormTarget(e.target)) return;
        this.#liveKeys.delete(e.code);
    };

    #onMouseMove = (e) => {
        this.#liveMouse.pageX = e.clientX;
        this.#liveMouse.pageY = e.clientY;
        const rect = this.#canvas.getBoundingClientRect();
        this.#liveMouse.x = ((e.clientX - rect.left) / rect.width)  * this.#internalWidth;
        this.#liveMouse.y = ((e.clientY - rect.top)  / rect.height) * this.#internalHeight;
    };

    #onMouseDown = (e) => {
        if (this.#preventedMouseBtns.has(e.button)) e.preventDefault();
        this.#liveMouse.buttons.add(e.button);
        if (this.#captureResolve) {
            this.#captureResolve({ source: 'mouse', button: e.button });
            this.#captureResolve = null;
        }
    };

    #onContextMenu = (e) => { e.preventDefault(); };

    #onMouseUp = (e) => {
        this.#liveMouse.buttons.delete(e.button);
    };

    #onWheel = (e) => {
        this.#liveMouse.scrollDX += e.deltaX;
        this.#liveMouse.scrollDY += e.deltaY;
    };

    #attach() {
        document.addEventListener('keydown', this.#onKeyDown);
        document.addEventListener('keyup', this.#onKeyUp);
        document.addEventListener('mousemove', this.#onMouseMove);
        document.addEventListener('mousedown', this.#onMouseDown);
        document.addEventListener('mouseup', this.#onMouseUp);
        document.addEventListener('wheel', this.#onWheel, { passive: true });
    }

    /**
     * Advances the input snapshot. Call once per frame before reading any input state.
     */
    update() {
        this.#keys = new Set(this.#liveKeys);

        this.#mouse = { ...this.#liveMouse, buttons: new Set(this.#liveMouse.buttons) };
        this.#liveMouse.scrollDX = 0;
        this.#liveMouse.scrollDY = 0;

        // Gamepads have no events — poll directly into snapshot
        const rawPads = Array.from(navigator.getGamepads());
        this.#gamepads = rawPads.map(pad => {
            if (!pad) return null;
            return {
                connected: true,
                buttons: pad.buttons.map(b => b.pressed),
                values:  pad.buttons.map(b => b.value),
                axes:    Array.from(pad.axes),
            };
        });

        if (this.#captureResolve) {
            outer: for (const pad of rawPads) {
                if (!pad) continue;
                for (let i = 0; i < pad.buttons.length; i++) {
                    if (pad.buttons[i].pressed) {
                        this.#captureResolve({ source: 'gamepad', index: pad.index, button: i });
                        this.#captureResolve = null;
                        break outer;
                    }
                }
            }
        }

        this.#midi = {
            notes: new Map(this.#liveMidi.notes),
            cc:    new Map(this.#liveMidi.cc),
        };
    }

    /**
     * Returns true if the key is held in the current snapshot.
     * Uses KeyboardEvent.code values: 'Space', 'KeyA', 'ArrowLeft', etc.
     * @param {string} code
     */
    key(code) {
        return this.#keys.has(code);
    }

    /**
     * The full set of currently-held key codes, for iterating all pressed keys.
     * @returns {Set<string>}
     */
    get keyboard() {
        return this.#keys;
    }

    /**
     * Current mouse state as of the last update().
     * .x/.y are in internal engine resolution space.
     * .button(0/1/2) checks left/middle/right.
     * .scroll.dx/.dy accumulate wheel movement since the last update().
     */
    get mouse() {
        const snap = this.#mouse;
        return {
            x: snap.x,
            y: snap.y,
            pageX: snap.pageX,
            pageY: snap.pageY,
            button: (i) => snap.buttons.has(i),
            scroll: { dx: snap.scrollDX, dy: snap.scrollDY },
        };
    }

    /**
     * Returns an accessor for the gamepad at the given index.
     * .button(index or name) — true/false. Named buttons: 'a','b','x','y','lb','rb','lt','rt','up','down','left','right','start','select','l3','r3'
     * .value(index or name)  — 0–1 analog value (useful for triggers)
     * .axis(index)           — -1 to 1
     * .connected             — false if no pad is plugged in at this index
     * @param {number} index
     */
    gamepad(index) {
        const pad = this.#gamepads[index];
        if (!pad) return { connected: false, button: () => false, value: () => 0, axis: () => 0 };
        return {
            connected: true,
            button: (i) => {
                const idx = typeof i === 'string' ? (STANDARD_BUTTONS[i] ?? -1) : i;
                return pad.buttons[idx] ?? false;
            },
            value: (i) => {
                const idx = typeof i === 'string' ? (STANDARD_BUTTONS[i] ?? -1) : i;
                return pad.values[idx] ?? 0;
            },
            axis: (i) => pad.axes[i] ?? 0,
        };
    }

    /**
     * MIDI state as of the last update(). Call enableMidi() first.
     * .note(midiNumber) — true if the note is currently held
     * .cc(ccNumber)     — current CC value 0–127
     */
    get midi() {
        const snap = this.#midi;
        return {
            note: (n) => (snap.notes.get(n) ?? 0) > 0,
            cc:   (n) =>  snap.cc.get(n) ?? 0,
        };
    }

    /**
     * Waits for the next input from any source and resolves with a descriptor.
     * Store the descriptor and pass it to check() to query that input later.
     *
     * Keyboard: { source: 'keyboard', code: 'Space' }
     * Mouse:    { source: 'mouse',    button: 0 }
     * Gamepad:  { source: 'gamepad',  index: 0, button: 0 }
     * MIDI:     { source: 'midi',     note: 60 }
     *
     * @returns {Promise<object>}
     */
    captureNext() {
        return new Promise(resolve => {
            this.#captureResolve = resolve;
        });
    }

    /**
     * Checks whether the input described by a captureNext() descriptor is currently held.
     * Works across all source types, making it useful for remappable controls.
     * @param {object} descriptor
     */
    check(descriptor) {
        if (!descriptor) return false;
        switch (descriptor.source) {
            case 'keyboard': return this.#keys.has(descriptor.code);
            case 'mouse':    return this.#mouse.buttons.has(descriptor.button);
            case 'gamepad': {
                const pad = this.#gamepads[descriptor.index];
                return pad?.buttons[descriptor.button] ?? false;
            }
            case 'midi': return (this.#midi.notes.get(descriptor.note) ?? 0) > 0;
            default: return false;
        }
    }

    /**
     * Requests MIDI access and begins tracking note and CC state.
     * Shows a browser permission prompt the first time.
     * @returns {Promise<void>}
     */
    async enableMidi() {
        if (!navigator.requestMIDIAccess) throw new Error('Web MIDI API not supported in this browser');
        const access = await navigator.requestMIDIAccess();

        const onMessage = (e) => {
            const [status, data1, data2] = e.data;
            const type = status & 0xF0;
            if (type === 0x90 && data2 > 0) {
                this.#liveMidi.notes.set(data1, data2);
                if (this.#captureResolve) {
                    this.#captureResolve({ source: 'midi', note: data1 });
                    this.#captureResolve = null;
                }
            } else if (type === 0x80 || (type === 0x90 && data2 === 0)) {
                this.#liveMidi.notes.delete(data1);
            } else if (type === 0xB0) {
                this.#liveMidi.cc.set(data1, data2);
            }
        };

        for (const port of access.inputs.values()) {
            port.addEventListener('midimessage', onMessage);
        }
        access.addEventListener('statechange', (e) => {
            if (e.port.type === 'input' && e.port.state === 'connected') {
                e.port.addEventListener('midimessage', onMessage);
            }
        });
    }

    /**
     * Suppresses the browser's default action for a key or mouse button.
     * Use this to stop the browser from intercepting inputs before the engine sees them —
     * e.g. '/' opens Firefox quick-find, middle-click opens scroll mode.
     *
     * Keyboard: pass a KeyboardEvent.code string — 'Slash', 'Space', 'KeyF', etc.
     * Mouse:    pass 'Mouse0' (left), 'Mouse1' (middle), or 'Mouse2' (right).
     *           'Mouse2' also suppresses the context menu popup.
     *
     * @param {string} code
     */
    preventDefault(code) {
        if (code.startsWith('Mouse')) {
            const btn = parseInt(code.slice(5));
            this.#preventedMouseBtns.add(btn);
            if (btn === 2) document.addEventListener('contextmenu', this.#onContextMenu);
        } else {
            this.#preventedKeys.add(code);
        }
    }

    /**
     * Restores the browser's default action for a key or mouse button previously
     * passed to preventDefault().
     * @param {string} code
     */
    allowDefault(code) {
        if (code.startsWith('Mouse')) {
            const btn = parseInt(code.slice(5));
            this.#preventedMouseBtns.delete(btn);
            if (btn === 2) document.removeEventListener('contextmenu', this.#onContextMenu);
        } else {
            this.#preventedKeys.delete(code);
        }
    }

    /**
     * Removes all event listeners. Call when tearing down the engine.
     */
    detach() {
        document.removeEventListener('keydown', this.#onKeyDown);
        document.removeEventListener('keyup', this.#onKeyUp);
        document.removeEventListener('mousemove', this.#onMouseMove);
        document.removeEventListener('mousedown', this.#onMouseDown);
        document.removeEventListener('mouseup', this.#onMouseUp);
        document.removeEventListener('wheel', this.#onWheel);
        document.removeEventListener('contextmenu', this.#onContextMenu);
    }
}
