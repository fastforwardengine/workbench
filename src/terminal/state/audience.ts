import type { RoomView } from '../../host/host.ts';
import { parse } from './commands.ts';
import { seatChoices, seatedAgents } from './session-text.ts';

/** What the composer text reaches: a command, one named seat, or the seats that hear every message. */
export interface Audience {
	/** `command` runs in the terminal and reaches no seat. */
	mode: 'plain' | 'command' | 'mention';
	/** The names of the seats that the message reaches, as the header shows them. */
	names: string[];
	/** A short remark on the one named seat, such as `no login`. */
	note?: string;
}

const COMMAND: Audience = { mode: 'command', names: [] };

/** The attention levels at which a seat wakes on plain text. */
const HEARS_PLAIN = ['broadcast', 'presence'];

/** The remark on a named seat, or undefined when the message wakes it as it is. */
function noteOf(name: string, state: string, view: RoomView | undefined): string | undefined {
	if ((view?.unavailable ?? []).includes(name)) return 'no login';
	if (state === 'none') return 'listens at none';
	return state === 'not seated' ? 'seats first' : undefined;
}

/** The audience of a mention. An unknown name reaches no seat, and the send path refuses it. */
function mentioned(
	to: string,
	team: readonly { name: string }[],
	view: RoomView | undefined,
): Audience {
	const seat = seatChoices(team, view).find((choice) => choice.name === to);
	if (!seat) return { mode: 'plain', names: [] };
	const note = noteOf(seat.name, seat.state, view);
	return { mode: 'mention', names: [seat.name], ...(note ? { note } : {}) };
}

/**
 * Who the composer text reaches. The text reads as the send path reads it
 * (`parse`): `/` starts a command, and `@name` addresses one seat. Any other
 * text reaches the seats that listen at `broadcast` or `presence`.
 */
export function audienceOf(
	text: string,
	team: readonly { name: string }[],
	view: RoomView | undefined,
): Audience {
	const parsed = parse(text);
	if (parsed.kind !== 'message') return COMMAND;
	if (parsed.to) return mentioned(parsed.to, team, view);
	const names = seatedAgents(view)
		.filter((seat) => HEARS_PLAIN.includes(seat.attention))
		.map((seat) => seat.name);
	return { mode: 'plain', names };
}
