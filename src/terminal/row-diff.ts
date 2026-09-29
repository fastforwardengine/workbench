/**
 * How to turn one list of rows into another while keeping as many rows as
 * possible. A row is known by its signature: two rows with the same signature
 * are the same row. The list keeps its order, so a kept row never moves.
 */
export interface RowPlan {
	/** The rows before `start` are the same in both lists. */
	start: number;
	/** The old rows from `oldEnd` on are the same as the new rows from `newEnd` on. */
	oldEnd: number;
	newEnd: number;
	/** Between them, the new row at each key keeps the old row at its value. */
	kept: ReadonlyMap<number, number>;
}

/** How many rows at the top are equal. */
function commonTop(old: readonly string[], wanted: readonly string[]): number {
	let at = 0;
	while (at < old.length && at < wanted.length && old[at] === wanted[at]) at += 1;
	return at;
}

/** How many rows at the bottom are equal, without going above `start` in either list. */
function commonBottom(old: readonly string[], wanted: readonly string[], start: number): number {
	let count = 0;
	while (
		old.length - count > start &&
		wanted.length - count > start &&
		old[old.length - 1 - count] === wanted[wanted.length - 1 - count]
	)
		count += 1;
	return count;
}

/** The positions of each signature among the old rows in a range, in order. */
function positions(old: readonly string[], from: number, to: number): Map<string, number[]> {
	const pool = new Map<string, number[]>();
	for (let at = from; at < to; at += 1) {
		const signature = old[at] ?? '';
		pool.set(signature, [...(pool.get(signature) ?? []), at]);
	}
	return pool;
}

/**
 * Pair each new row in a range with an old row of the same signature in
 * another range. Each pair lies below the one before it in the old list, so
 * no old row is used twice and no pair crosses another.
 */
function pairs(
	old: readonly string[],
	oldRange: [number, number],
	wanted: readonly string[],
	newRange: [number, number],
): Map<number, number> {
	const pool = positions(old, oldRange[0], oldRange[1]);
	const kept = new Map<number, number>();
	let last = -1;
	for (let at = newRange[0]; at < newRange[1]; at += 1) {
		const candidates = pool.get(wanted[at] ?? '') ?? [];
		const next = candidates.find((index) => index > last);
		if (next === undefined) continue;
		kept.set(at, next);
		last = next;
	}
	return kept;
}

/** Plan the change from the rows `old` to the rows `wanted`, by their signatures. */
export function planRows(old: readonly string[], wanted: readonly string[]): RowPlan {
	const start = commonTop(old, wanted);
	const bottom = commonBottom(old, wanted, start);
	const oldEnd = old.length - bottom;
	const newEnd = wanted.length - bottom;
	return { start, oldEnd, newEnd, kept: pairs(old, [start, oldEnd], wanted, [start, newEnd]) };
}
