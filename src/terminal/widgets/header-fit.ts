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
	pattern: string;
}

export interface HeaderFit {
	goal: string;
	pattern: string;
}

/**
 * Decide what the rows of the header show at one width. The goal takes the cells
 * that the room name and the identity leave, and it ends with an ellipsis when it
 * is longer. The pattern shows only when it fits on the row of the participants.
 */
export function fitHeader(input: HeaderFitInput): HeaderFit {
	const { width, name, identity } = input;
	const taken = name.length + APART + (identity ? identity.length + APART : 0);
	const goal = ellipsize(input.goal, width - taken);
	const fits = input.people + APART + input.pattern.length <= width;
	return { goal, pattern: fits ? input.pattern : '' };
}
