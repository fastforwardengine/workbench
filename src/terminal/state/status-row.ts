import type { Working } from '../../view/live.ts';
import { clock, ellipsize } from '../../view/text.ts';
import type { Background } from './breakouts.ts';

/** The color of a segment, by name. The composer maps each name to a color of the palette. */
export type Tone = 'muted' | 'dim' | 'coral' | 'green' | 'red';

/** One part of the status row. The row drops the segments with the lowest priority first. */
export interface Segment {
	/** Names the segment, so a test and a later change can find it. */
	key: string;
	text: string;
	/** A higher number stays longer when the row is narrow. */
	priority: number;
	tone: Tone;
	/** `left` segments sit at the left edge. `right` segments sit at the right edge. */
	side: 'left' | 'right';
	/** The tone of a dot that comes before the text. Absent when the segment has no dot. */
	mark?: Tone;
}

/** The priority of each segment, from the one that stays longest. */
export const PRIORITY = { status: 5, keys: 4, background: 3, processes: 2, later: 1 } as const;

/** The text between two segments of the same side. */
export const SEPARATOR = ' · ';

/** The dot that comes before the text of a segment with a mark. */
export const MARK = '● ';

/** The most cells that the step of the working line takes. */
const STEP_CELLS = 40;

const cells = (segment: Segment): number => (segment.mark ? MARK.length : 0) + segment.text.length;

/** The cells that `segments` take in one row. `apart` is the gap between the left and the right side. */
export function rowCells(segments: readonly Segment[], apart: number): number {
	return segments.reduce((sum, segment, at) => {
		const before = segments[at - 1];
		const gap = before && before.side !== segment.side ? apart : SEPARATOR.length;
		return sum + cells(segment) + (before ? gap : 0);
	}, 0);
}

/**
 * Keep the segments that fit in `width` cells, in their order. While the row is
 * too wide, it drops the segment with the lowest priority. Of two segments with
 * the same priority, the later one drops first. The row keeps its last segment.
 */
export function fitSegments(segments: readonly Segment[], width: number, apart: number): Segment[] {
	const kept = [...segments];
	while (kept.length > 1 && rowCells(kept, apart) > width) {
		const lowest = Math.min(...kept.map((segment) => segment.priority));
		kept.splice(
			kept.findLastIndex((segment) => segment.priority === lowest),
			1,
		);
	}
	return kept;
}

const plural = (count: number, one: string, many: string): string =>
	`${count} ${count === 1 ? one : many}`;

/** What the row counts at the right: background work that the person can open. */
export interface Counts {
	/** The breakout rooms that run in the background of the open room. */
	background: Background;
	/** The background processes of the specialists that run. */
	processes: number;
	/** The says of the open room that wait for their time. */
	later: number;
}

/** The segments for the counts, in row order. A count of zero has no segment. */
export function countSegments({ background, processes, later }: Counts): Segment[] {
	const count = (key: keyof typeof PRIORITY, text: string, tone: Tone): Segment => ({
		key,
		text,
		tone,
		priority: PRIORITY[key],
		side: 'right',
	});
	return [
		...(background.running > 0
			? [
					count(
						'background',
						`${background.running} in background`,
						background.working ? 'coral' : 'dim',
					),
				]
			: []),
		...(processes > 0
			? [count('processes', plural(processes, 'process', 'processes'), 'dim')]
			: []),
		...(later > 0 ? [count('later', `${later} later`, 'dim')] : []),
	];
}

/**
 * The working line: the seat, what it does now, and how long it works. `room`
 * is the cells that the row has. The step ends with an ellipsis when it does
 * not fit. A seat that has done nothing yet shows no step and no time.
 */
export function workingSegment(working: Working, now: number, room: number): Segment {
	const time = working.since === undefined ? '' : clock(now - working.since);
	const fixed = [working.seat, time].filter((part) => part !== '').join(SEPARATOR);
	const left = Math.min(STEP_CELLS, room - MARK.length - fixed.length - SEPARATOR.length);
	const step = working.step && left > 1 ? ellipsize(working.step, left) : '';
	const parts = [working.seat, step, time].filter((part) => part !== '');
	return {
		key: 'status',
		text: parts.join(SEPARATOR),
		priority: PRIORITY.status,
		tone: 'muted',
		side: 'left',
		mark: 'coral',
	};
}
