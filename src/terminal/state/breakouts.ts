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

/** The ways a breakout room stands, each with its mark. A mark tells the state without color. */
const MARKS = {
	working: '●',
	running: '○',
	stopped: '–',
	done: '✓',
	failed: '✗',
	archived: '·',
} as const;

/** How a breakout room stands: the word that the palette, the header, and the title show. */
export type Standing = keyof typeof MARKS;

/** The mark of a standing. */
export const markOf = (standing: Standing): string => MARKS[standing];

/** The mark and the word of a standing, such as `✓ done`. */
export const standingText = (standing: Standing): string => `${MARKS[standing]} ${standing}`;

/**
 * How a breakout room stands: its result once archived, else `stopped`, `working`, or `running`.
 * A room runs only when the host holds its live handle, which `status` tells. A root room has none.
 */
export function standingOf(room: RoomChoice): Standing | undefined {
	const info = room.breakout;
	if (!info) return undefined;
	if (info.state === 'archived') return info.result ?? 'archived';
	if (room.status !== 'running') return 'stopped';
	return room.working ? 'working' : 'running';
}

/** How the open room stands when it is a breakout room, or undefined for a root room and for no room. */
export function standingOfView(view: RoomView | undefined): Standing | undefined {
	return view?.breakout ? standingOf(choiceOf(view)) : undefined;
}

/** The name of a breakout room without the `<parent>-` prefix. A name without the prefix stays whole. */
export function shortName(name: string, parent: string): string {
	const prefix = `${parent}-`;
	return name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name;
}

/** The two parts of the path of a room: the dim head, and the leaf. A root room has an empty head. */
export function pathParts(name: string, parent?: string): { head: string; leaf: string } {
	return parent === undefined
		? { head: '', leaf: name }
		: { head: `${parent} › `, leaf: shortName(name, parent) };
}

/** The path of a room as text: `parent › short` for a breakout room, else the name. */
export function pathText(name: string, parent?: string): string {
	const { head, leaf } = pathParts(name, parent);
	return head + leaf;
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
 * The name of the room that the room list picks when it opens. In a breakout room, it is the
 * parent. In a room with running breakout rooms, it is the last of them in the list. The host
 * lists rooms in the order that they opened, and the view of a room has no creation time.
 * Otherwise it is the open room.
 */
function pickedOf(rooms: readonly RoomView[], open: string): string {
	const parent = rooms.find((room) => room.name === open)?.breakout?.parent;
	if (parent !== undefined) return parent;
	return (
		childrenOf(rooms, open)
			.filter((room) => room.status === 'running')
			.at(-1)?.name ?? open
	);
}

/**
 * The rooms of the palette: each root room, then its breakout rooms. The palette
 * lists an archived breakout room only when its parent is the open room or the
 * parent of the open room, so old rooms do not pile up. One room has the flag
 * `picked`: the row that the palette picks when it opens.
 */
export function roomChoices(rooms: readonly RoomView[], open: string): RoomChoice[] {
	const family = rooms.find((room) => room.name === open)?.breakout?.parent ?? open;
	const picked = pickedOf(rooms, open);
	const listed = (child: RoomView): boolean =>
		child.breakout?.state !== 'archived' || child.breakout.parent === family;
	return rooms
		.filter((room) => !room.breakout)
		.flatMap((root) => [root, ...childrenOf(rooms, root.name).filter(listed)])
		.map((room) => (room.name === picked ? { ...choiceOf(room), picked: true } : choiceOf(room)));
}
