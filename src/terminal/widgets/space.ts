/**
 * The spacing scale of the terminal. A cell is about twice as tall as it is
 * wide, so a gap of one row and a gap of two cells look alike. Every padding,
 * margin, and gap in `src/terminal` takes its value from this file.
 */

/** The cells between a rail, a border, or the window edge and the text beside it. */
export const GUTTER = 1;

/** The column where text starts inside a block: a rail of one cell, then the gutter. */
export const INSET = 1 + GUTTER;

/** The blank rows between two blocks. */
export const GAP = 1;

/** The cells between two texts on one row. It looks as wide as a gap of one row. */
export const APART = 2 * GUTTER;

/** The cells that keep text clear of a scrollbar. */
export const SCROLLBAR = 2;

/** The cells that the track of a scrollbar takes. */
export const TRACK = 1;

/** At or above this terminal height, the window has a blank row at the top and at the bottom. */
const ROOMY_ROWS = 30;

/** The blank rows at the top and at the bottom of the window, for a terminal of `rows` rows. */
export const edgeRows = (rows: number): number => (rows >= ROOMY_ROWS ? GAP : 0);
