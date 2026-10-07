import type { SystemMessage } from '@ambionframework/ambion';
import { firstLine } from './text.ts';

/** The mark of a system message that gives the say of a seat back to it. */
const RETURN_MARK = '↩';

/** The mark of any other system message. */
const NOTE_MARK = '▸';

/** The start of a report or a close notice that a breakout room posts: `breakout <name>: `. */
const BREAKOUT_PREFIX = /^breakout ([^\s:]+): /;

/** What the folded row of a system message shows, before the clock time. */
export interface SystemRow {
	/** The mark at the start of the row. */
	mark: string;
	/** Who the message comes from, or whom it returns to. */
	source: string;
	/** The first line of the text, whole. The terminal fits it to the row. */
	text: string;
}

/**
 * The folded row of a system message. A returned say names the seat that gets it
 * back. A message that starts with `breakout <name>: ` names the breakout room, and
 * the row drops that prefix. Any other message names `system`.
 */
export function systemRow(message: SystemMessage): SystemRow {
	const text = message.text ?? '';
	if (message.returns !== undefined)
		return { mark: RETURN_MARK, source: message.to ?? 'room', text: firstLine(text).trim() };
	const named = BREAKOUT_PREFIX.exec(text);
	if (!named) return { mark: NOTE_MARK, source: 'system', text: firstLine(text).trim() };
	return {
		mark: NOTE_MARK,
		source: named[1] ?? 'system',
		text: firstLine(text.slice(named[0].length)).trim(),
	};
}
