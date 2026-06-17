// Cell geometry for images/monogram-bitmap.png — 16 cols x 8 rows, 6x12 px cells (96x96 total).
export const FONT_COLS   = 16;
export const FONT_ROWS   = 8;
export const CELL_WIDTH  = 6;
export const CELL_HEIGHT = 12;

// The sheet lays out glyphs in ASCII order starting at space (code 32) in cell 0,
// so any printable ASCII character's frame is just its char code minus 32.
export function charToFrame(ch) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) return 0; // outside the sheet — fall back to space
    return code - 32;
}
