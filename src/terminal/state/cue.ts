import type { WaitingMessage } from '../../view/steering.ts';
import { ellipsize } from '../../view/text.ts';
import { type StagedAttachment, stagedCue } from './attachments.ts';
import type { Tone } from './status-row.ts';

/** One line of the cue above the input: a mark, then a text. */
export interface CueLine {
	mark: string;
	markTone: Tone;
	text: string;
	tone: Tone;
}

/** The most waiting messages that the cue shows. */
const SHOWN_WAITING = 2;

const STEERING = 'steering: ';
/** The cells of the mark and the space after it. */
const MARK_CELLS = 2;

/**
 * The lines above the input. The staged files come first. A waiting message
 * follows, one line each, up to `SHOWN_WAITING`, then the count of the rest.
 * `room` is the cells that a line has. The text of a message ends with an
 * ellipsis when it does not fit.
 */
export function cueLines(
	staged: readonly StagedAttachment[],
	waiting: readonly WaitingMessage[],
	room: number,
): CueLine[] {
	const files = stagedCue(staged);
	const text = Math.max(1, room - MARK_CELLS - STEERING.length);
	const lines: CueLine[] = waiting.slice(0, SHOWN_WAITING).map((one) => ({
		mark: '↳',
		markTone: 'dim',
		text: `${STEERING}${ellipsize(one.text, text)}`,
		tone: 'dim',
	}));
	const more = waiting.length - SHOWN_WAITING;
	if (more > 0) lines.push({ mark: ' ', markTone: 'dim', text: `+${more} more`, tone: 'dim' });
	if (files !== undefined)
		lines.unshift({ mark: '▪', markTone: 'coral', text: files, tone: 'muted' });
	return lines;
}
