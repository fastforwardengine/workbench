import { ellipsize, ellipsizeMiddle } from '../../view/text.ts';
import { CITED_HEAD, type FileRow } from '../state/browser.ts';
import { LIST_ROWS, windowStart } from './side-panel.ts';
import { APART, INSET } from './space.ts';

/**
 * The lines of the files layer, without color: the section of the room, a heading
 * for each group of files, and the rows. The columns drop as the width shrinks. The
 * time of a citation goes first, then the size of a file. A path takes its
 * ellipsis in the middle, so the file name stays.
 */

/** From this width, a cited row shows the time of its citation, and the author shows the version count in words. */
const TIME_FROM = 60;

/** From this width, a file shows its size. */
const SIZE_FROM = 44;

/** The cells of the time, such as `12:41`. */
const TIME_WIDTH = 5;

/** The least cells of the author column. */
const MIN_AUTHOR = 6;

export const bytes = (size: number): string =>
	size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;

/** The time of day of an ISO time, such as `12:41`, or nothing when the text is not a time. */
export function timeOfDay(at: string): string {
	const date = new Date(at);
	if (Number.isNaN(date.valueOf())) return '';
	const two = (value: number) => String(value).padStart(2, '0');
	return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** One line of the list. */
export type ListLine =
	| { kind: 'heading'; text: string; cited: boolean }
	| { kind: 'gap' }
	| { kind: 'row'; index: number; mark: 'cited' | 'plain'; text: string };

/** The author of a cited row, with the count of its versions when the room cites more than one. */
function authorText(row: FileRow, wide: boolean): string {
	const author = row.cite?.author ?? '';
	const versions = row.cite?.opens.length ?? 0;
	if (versions < 2) return author;
	return wide ? `${author} · ${versions} versions` : `${author} ·${versions}`;
}

const padded = (text: string, width: number): string => ellipsize(text, width).padEnd(width);

/** The widths of the columns for the rows that match, in a list `width` cells wide. */
interface Columns {
	/** True when the width shows the time and the long form of the versions. */
	wide: boolean;
	/** The cells of the author column of a cited row. */
	author: number;
	/** The cells of the size column of a file. Zero hides it. */
	size: number;
	/** The cells of the path of a cited row, and the spare cells that follow its author. */
	citedPath: number;
	spare: number;
	/** The cells that a path may take in a file row. */
	filePath: number;
}

function columns(rows: readonly FileRow[], width: number): Columns {
	const wide = width >= TIME_FROM;
	const room = width - INSET;
	const longest = Math.max(
		0,
		...rows.filter((row) => row.kind === 'cited').map((row) => authorText(row, wide).length),
	);
	const author = Math.min(longest, Math.max(MIN_AUTHOR, Math.floor(room / 3)));
	const size =
		width >= SIZE_FROM
			? Math.max(0, ...rows.map((row) => (row.size === undefined ? 0 : bytes(row.size).length)))
			: 0;
	const timeRoom = wide ? TIME_WIDTH + APART : 0;
	const available = Math.max(1, room - (author > 0 ? author + APART : 0) - timeRoom);
	// The author follows the longest path, and the spare cells sit before the time.
	const citedPath = Math.min(
		available,
		Math.max(0, ...rows.filter((row) => row.kind === 'cited').map((row) => row.label.length)),
	);
	return {
		wide,
		author,
		size,
		citedPath,
		spare: available - citedPath,
		filePath: Math.max(1, room - (size > 0 ? size + APART : 0)),
	};
}

/** The text of a cited row after its mark: the path, the author, and the time. */
function citedText(row: FileRow, cols: Columns): string {
	const gap = ' '.repeat(APART);
	const path = ellipsizeMiddle(row.label, cols.citedPath).padEnd(cols.citedPath);
	const author =
		cols.author > 0 ? `${gap}${padded(authorText(row, cols.wide), cols.author + cols.spare)}` : '';
	const time = cols.wide ? `${gap}${timeOfDay(row.cite?.at ?? '')}`.trimEnd() : '';
	return `${path}${author}${time}`;
}

/** The text of a file row after its mark: the path in its group, and the size. */
function fileText(row: FileRow, cols: Columns): string {
	const path = ellipsizeMiddle(row.label, cols.filePath);
	if (cols.size === 0 || row.size === undefined) return path;
	const gap = ' '.repeat(APART);
	return `${path.padEnd(cols.filePath)}${gap}${bytes(row.size).padStart(cols.size)}`;
}

/** The lines above a row that starts a group: a blank line after the section of the room, and the heading. */
function headLines(group: string, before: string | undefined): ListLine[] {
	const gap: ListLine[] = before === CITED_HEAD ? [{ kind: 'gap' }] : [];
	const heading: ListLine[] =
		group === '' ? [] : [{ kind: 'heading', text: group, cited: group === CITED_HEAD }];
	return [...gap, ...heading];
}

/** The lines for the rows that match, in a list `width` cells wide. */
export function listLines(rows: readonly FileRow[], width: number): ListLine[] {
	const cols = columns(rows, width);
	return rows.flatMap((row, index) => {
		const before = rows[index - 1]?.group;
		const head = index === 0 || row.group !== before ? headLines(row.group, before) : [];
		const text = row.kind === 'cited' ? citedText(row, cols) : fileText(row, cols);
		const mark = row.kind === 'file' && row.cite ? 'cited' : 'plain';
		return [...head, { kind: 'row' as const, index, mark, text }];
	});
}

/** The lines `[start, end)` to show, with the chosen row in view and its heading too when both fit. */
export function visibleLines(
	lines: readonly ListLine[],
	chosen: number,
	rows: number,
): [number, number] {
	const at = lines.findIndex((line) => line.kind === 'row' && line.index === chosen);
	let start = windowStart(Math.max(0, at), lines.length, rows);
	let head = at;
	while (head > 0 && lines[head - 1]?.kind === 'row') head -= 1;
	if (head > 0 && lines[head - 1]?.kind === 'heading') head -= 1;
	if (head < start && at - head < rows) start = head;
	return [start, Math.min(lines.length, start + rows)];
}

/** How many lines the list takes in a layer `height` rows tall. The preview gets the other half. */
export const listRows = (height: number): number =>
	Math.max(LIST_ROWS, Math.min(2 * LIST_ROWS, Math.floor(height / 2)));
