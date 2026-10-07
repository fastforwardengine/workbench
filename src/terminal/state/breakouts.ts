import type { RoomView } from '../../host/host.ts';
import type { RoomChoice } from './commands.ts';

/** The background work of the open room: its running breakout rooms, and whether one has an open exchange. */
export interface Background {
	running: number;
	working: boolean;
}

/** The breakout rooms that the room `parent` holds. */
const childrenOf = (rooms: readonly RoomView[], parent: string): RoomView[] =>
	rooms.filter((room) => room.breakout?.parent === parent);

/**
 * Count the breakout rooms of `open` that run, and tell whether one of them works. A room runs
 * when the host holds its live handle. A stopped parent or a failed start leaves a row with the
 * state `running` and no handle, so the state alone does not count.
 */
export function backgroundOf(rooms: readonly RoomView[], open: string): Background {
	const running = childrenOf(rooms, open).filter((room) => room.status === 'running');
	return { running: running.length, working: running.some((room) => Boolean(room.exchange)) };
}

/** The short chip of the header, or an empty string when no breakout room runs. */
export const backgroundChip = ({ running }: Background): string =>
	running === 0 ? '' : `⇉ ${running} in background`;

/** What the header says of a breakout room: its parent, and its result once archived. */
export function breakoutLabel(view: RoomView | undefined): string {
	const info = view?.breakout;
	if (!info) return '';
	const label = `breakout of ${info.parent}`;
	return info.state === 'archived' && info.close ? `${label} · ${info.close.result}` : label;
}

/** The choice that one room makes in the room palette. */
function choiceOf(room: RoomView): RoomChoice {
	const { name, status, goal, breakout } = room;
	const base = { name, status, working: Boolean(room.exchange) };
	if (!breakout) return base;
	const { parent, state, close } = breakout;
	return {
		...base,
		breakout: { parent, state, goal: goal ?? '', ...(close ? { result: close.result } : {}) },
	};
}

/**
 * The rooms of the palette: each root room, then its breakout rooms. The palette
 * lists an archived breakout room only when its parent is the open room or the
 * parent of the open room, so old rooms do not pile up.
 */
export function roomChoices(rooms: readonly RoomView[], open: string): RoomChoice[] {
	const family = rooms.find((room) => room.name === open)?.breakout?.parent ?? open;
	const listed = (child: RoomView): boolean =>
		child.breakout?.state !== 'archived' || child.breakout.parent === family;
	return rooms
		.filter((room) => !room.breakout)
		.flatMap((root) => [root, ...childrenOf(rooms, root.name).filter(listed)])
		.map(choiceOf);
}
