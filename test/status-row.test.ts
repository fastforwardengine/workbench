/** The pure parts of the status row: the fit, the counts, and the working line. */
import { describe, expect, it, vi } from 'vitest';
import { ProcessCount } from '../src/terminal/state/process-count.ts';
import {
	countSegments,
	fitSegments,
	PRIORITY,
	rowCells,
	type Segment,
	workingSegment,
} from '../src/terminal/state/status-row.ts';
import { Ticker } from '../src/terminal/state/ticker.ts';
import { APART } from '../src/terminal/widgets/space.ts';
import { FakeHost } from './fake-host.ts';

const segment = (key: string, text: string, priority: number, side: Segment['side']): Segment => ({
	key,
	text,
	priority,
	side,
	tone: 'dim',
});

const row = [
	segment('status', 'Active', PRIORITY.status, 'left'),
	segment('background', '2 in background', PRIORITY.background, 'right'),
	segment('processes', '1 process', PRIORITY.processes, 'right'),
	segment('later', '3 later', PRIORITY.later, 'right'),
	segment('keys', '? keys', PRIORITY.keys, 'right'),
];
const keysOf = (segments: readonly Segment[]) => segments.map((one) => one.key);

describe('fitSegments', () => {
	const all = rowCells(row, APART);

	it('keeps every segment, in order, when the row fits', () => {
		expect(keysOf(fitSegments(row, all, APART))).toEqual(keysOf(row));
	});

	it('counts the gap between sides and the separator inside a side', () => {
		// Active, 2 gap cells, then four right segments with three separators of three cells.
		expect(all).toBe(6 + APART + 15 + 9 + 7 + 6 + 3 * 3);
	});

	it('drops the lowest priority first, one segment at a time', () => {
		expect(keysOf(fitSegments(row, all - 1, APART))).toEqual([
			'status',
			'background',
			'processes',
			'keys',
		]);
		// Without the later segment the row takes 44 cells. One cell less drops the processes.
		expect(keysOf(fitSegments(row, 44, APART))).toEqual([
			'status',
			'background',
			'processes',
			'keys',
		]);
		expect(keysOf(fitSegments(row, 43, APART))).toEqual(['status', 'background', 'keys']);
	});

	it('drops the counts before the keys hint, and the hint before the status', () => {
		expect(keysOf(fitSegments(row, 6 + APART + 6, APART))).toEqual(['status', 'keys']);
		expect(keysOf(fitSegments(row, 6 + APART + 5, APART))).toEqual(['status']);
		expect(keysOf(fitSegments(row, 0, APART))).toEqual(['status']);
	});

	it('drops the later segment first when two have the same priority', () => {
		const tied = [
			segment('status', 'Active', 5, 'left'),
			segment('a', 'aaa', 1, 'right'),
			segment('b', 'bbb', 1, 'right'),
		];
		expect(keysOf(fitSegments(tied, 6 + APART + 3, APART))).toEqual(['status', 'a']);
	});

	it('does not change its input', () => {
		const before = [...row];
		fitSegments(row, 0, APART);
		expect(row).toEqual(before);
	});
});

describe('countSegments', () => {
	const none = { background: { running: 0, working: false }, processes: 0, later: 0 };

	it('has no segment for a count of zero', () => {
		expect(countSegments(none)).toEqual([]);
	});

	it('says each count in a short phrase, in row order', () => {
		const counts = countSegments({
			background: { running: 2, working: false },
			processes: 1,
			later: 3,
		});
		expect(counts.map((one) => one.text)).toEqual(['2 in background', '1 process', '3 later']);
		expect(countSegments({ ...none, processes: 2 })[0]?.text).toBe('2 processes');
	});

	it('turns the background count coral while a breakout room works', () => {
		const at = (working: boolean) =>
			countSegments({ ...none, background: { running: 1, working } })[0]?.tone;
		expect(at(false)).toBe('dim');
		expect(at(true)).toBe('coral');
	});

	it('orders the priorities: background, processes, later', () => {
		expect(PRIORITY.background).toBeGreaterThan(PRIORITY.processes);
		expect(PRIORITY.processes).toBeGreaterThan(PRIORITY.later);
		expect(PRIORITY.keys).toBeGreaterThan(PRIORITY.background);
		expect(PRIORITY.status).toBeGreaterThan(PRIORITY.keys);
	});
});

describe('workingSegment', () => {
	const now = 100_000;
	const working = { seat: 'engineer', step: 'running pnpm test', since: now - 34_000 };

	it('names the seat, the step, and the elapsed time', () => {
		const line = workingSegment(working, now, 80);
		expect(line).toMatchObject({
			key: 'status',
			text: 'engineer · running pnpm test · 0:34',
			mark: 'coral',
			side: 'left',
			priority: PRIORITY.status,
		});
	});

	it('leaves out the step and the time of a seat that has done nothing yet', () => {
		expect(workingSegment({ seat: 'engineer', step: '' }, now, 80).text).toBe('engineer');
	});

	it('ends a long step with an ellipsis so the line fits the room', () => {
		const long = { ...working, step: 'running a very long command with many arguments '.repeat(3) };
		for (const room of [80, 50, 30]) {
			const line = workingSegment(long, now, room);
			expect(line.text.length + 2).toBeLessThanOrEqual(room);
			expect(line.text).toContain('…');
		}
	});

	it('leaves out the step when the room is too small for it', () => {
		expect(workingSegment(working, now, 20).text).toBe('engineer · 0:34');
	});
});

describe('ProcessCount', () => {
	const process = (handle: string, state: string) => ({ handle, state }) as never;

	it('counts the running processes, and reads again on a start or an end', async () => {
		const host = new FakeHost();
		host.processTable = [process('a', 'running'), process('b', 'exited')];
		const changed = vi.fn();
		const count = new ProcessCount(host, changed);
		count.start();
		await vi.waitFor(() => expect(count.running).toBe(1));
		host.processTable = [process('a', 'running'), process('c', 'running')];
		for (const watcher of host.processWatchers) watcher();
		await vi.waitFor(() => expect(count.running).toBe(2));
		expect(changed).toHaveBeenCalledTimes(2);
	});

	it('watches once, and stops the watch on dispose', async () => {
		const host = new FakeHost();
		const count = new ProcessCount(host, () => {});
		count.start();
		count.start();
		expect(host.processWatchers.size).toBe(1);
		count.dispose();
		expect(host.processWatchers.size).toBe(0);
		count.start();
		expect(host.processWatchers.size).toBe(0);
	});

	it('keeps the last count when a list fails', async () => {
		const host = new FakeHost();
		host.processTable = [process('a', 'running')];
		const count = new ProcessCount(host, () => {});
		count.start();
		await vi.waitFor(() => expect(count.running).toBe(1));
		host.processFailure = 'down';
		for (const watcher of host.processWatchers) watcher();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(count.running).toBe(1);
	});

	it('drops a read that is in flight when the count is disposed', async () => {
		const host = new FakeHost();
		host.processTable = [process('a', 'running')];
		const changed = vi.fn();
		const count = new ProcessCount(host, changed);
		count.start();
		await vi.waitFor(() => expect(count.running).toBe(1));
		changed.mockClear();
		const listed = host.processes.bind(host);
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		host.processes = async () => {
			await gate;
			return listed();
		};
		host.processTable = [];
		for (const watcher of host.processWatchers) watcher();
		count.dispose();
		release();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(count.running).toBe(1);
		expect(changed).not.toHaveBeenCalled();
	});
});

describe('Ticker', () => {
	it('runs while followed, and stops when not followed', () => {
		vi.useFakeTimers();
		try {
			const tick = vi.fn();
			const ticker = new Ticker(1000, tick);
			ticker.follow(true);
			ticker.follow(true);
			vi.advanceTimersByTime(3000);
			expect(tick).toHaveBeenCalledTimes(3);
			ticker.follow(false);
			expect(ticker.running).toBe(false);
			vi.advanceTimersByTime(3000);
			expect(tick).toHaveBeenCalledTimes(3);
			ticker.follow(true);
			ticker.stop();
			vi.advanceTimersByTime(3000);
			expect(tick).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});
});
