/** A word edge this close to the cut is a better place to end the text than the cut. */
const EDGE_REACH = 16;

/**
 * Fit text on one line of `width` cells. The result ends with `…` when the text is
 * longer. It ends at a word edge when one lies within a few cells of the cut. It
 * counts each character as one cell, so it fits Latin text and does not measure
 * wide characters.
 */
export function ellipsize(text: string, width: number): string {
	const line = text.replace(/\s+/g, ' ').trim();
	if (line.length <= width) return line;
	if (width < 1) return '';
	const cut = line.slice(0, width - 1);
	const space = cut.lastIndexOf(' ');
	const edge = space > 0 && space >= cut.length - EDGE_REACH ? cut.slice(0, space) : cut;
	return `${edge.trimEnd()}…`;
}

/** The message of an error, or the text of any other thrown value. */
export const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** The most characters that `brief` keeps. */
const WIDTH = 100;

/** The first line of a text, cut to a fixed width. */
export function brief(text: string): string {
	const line = (text.split('\n')[0] ?? '').trim();
	return line.length > WIDTH ? `${line.slice(0, WIDTH - 1)}…` : line;
}

/** The first line of a text that holds a character, or an empty text. */
export const firstLine = (text: string): string =>
	text.split('\n').find((line) => line.trim() !== '') ?? '';

/** A value as one short line: a string as it is, anything else as JSON. */
export function render(value: unknown): string {
	if (typeof value === 'string') return brief(value);
	const json = JSON.stringify(value);
	return brief(json ?? '');
}
