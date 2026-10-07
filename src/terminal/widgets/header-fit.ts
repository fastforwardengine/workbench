import { ellipsize } from '../../view/text.ts';
import { APART } from './space.ts';

export interface HeaderFitInput {
	/** The cells one row has, inside the padding. */
	width: number;
	name: string;
	goal: string;
	identity: string;
	/** The cells the participants take on their row. */
	people: number;
	/** The chip that follows the participants, or an empty string. */
	background: string;
	/** The text at the right edge of the row of the participants. */
	pattern: string;
}

export interface HeaderFit {
	goal: string;
	background: string;
	pattern: string;
}

/**
 * Decide what the rows of the header show at one width. The goal takes the cells
 * that the room name and the identity leave, and it ends with an ellipsis when it
 * is longer. The background chip shows only when it fits after the participants.
 * The pattern shows only when it fits after the participants and the chip. The
 * participants never give way: the pattern drops first, and then the chip.
 */
export function fitHeader(input: HeaderFitInput): HeaderFit {
	const { width, name, identity, people, background } = input;
	const taken = name.length + APART + (identity ? identity.length + APART : 0);
	const goal = ellipsize(input.goal, width - taken);
	const chipCells = background ? APART + background.length : 0;
	const chip = people + chipCells <= width ? background : '';
	const used = people + (chip ? chipCells : 0);
	const fits = used + APART + input.pattern.length <= width;
	return { goal, background: chip, pattern: fits ? input.pattern : '' };
}
