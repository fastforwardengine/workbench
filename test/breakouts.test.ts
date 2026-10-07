/** What the terminal reads from the breakout rooms of the room list. */
import { describe, expect, it } from 'vitest';
import {
	backgroundOf,
	markOf,
	pathParts,
	pathText,
	roomChoices,
	shortName,
	standingOf,
	standingOfView,
	standingText,
} from '../src/terminal/state/breakouts.ts';
import { suggest } from '../src/terminal/state/commands.ts';
import { view } from './fake-host.ts';

const exchange = { id: 'x1' };

function child(
	name: string,
	parent: string,
	state: 'running' | 'stopped' | 'archived',
	extra: Record<string, unknown> = {},
) {
	const close = state === 'archived' ? { close: { result: 'done' } } : {};
	const status = state === 'running' ? 'running' : 'stopped';
	return view(name, {
		status,
		breakout: { parent, opener: 'engineer', state, ...close },
		...extra,
	});
}

const rooms = [
	view('build'),
	child('tuners', 'build', 'running', { exchange }),
	child('plan', 'build', 'running'),
	child('idle', 'build', 'stopped'),
	child('old-build', 'build', 'archived'),
	view('cycling'),
	child('old-cycling', 'cycling', 'archived'),
	child('live-cycling', 'cycling', 'running'),
];

describe('backgroundOf', () => {
	it('counts the running breakout rooms of the open room, and tells when one works', () => {
		expect(backgroundOf(rooms, 'build')).toEqual({ running: 2, working: true });
		expect(backgroundOf(rooms, 'cycling')).toEqual({ running: 1, working: false });
	});

	it('counts none for a breakout room, for an unknown room, and for no room', () => {
		for (const open of ['tuners', 'nowhere', '']) {
			expect(backgroundOf(rooms, open)).toEqual({ running: 0, working: false });
		}
	});

	it('does not count a stopped or an archived breakout room', () => {
		const quiet = [view('build'), child('a', 'build', 'stopped'), child('b', 'build', 'archived')];
		expect(backgroundOf(quiet, 'build')).toEqual({ running: 0, working: false });
	});
});

describe('a breakout room without a live handle', () => {
	// A stopped parent or a failed start leaves the row at `running`, and the host holds no handle.
	const dead = child('dead', 'build', 'running', { status: 'stopped', exchange });

	it('adds nothing to the chip', () => {
		expect(backgroundOf([view('build'), dead], 'build')).toEqual({ running: 0, working: false });
	});

	it('shows `stopped` in the palette', () => {
		const choice = roomChoices([view('build'), dead], 'build').find((row) => row.name === 'dead');
		expect(choice).toMatchObject({ status: 'stopped', working: true });
		const listed = suggest('/room dead', {
			rooms: roomChoices([view('build'), dead], 'build'),
			people: [],
			files: [],
			says: [],
			seats: [],
		});
		expect(listed[0]?.detail).toBe('stopped · dead goal');
	});
});

describe('standingOfView', () => {
	it('tells how a breakout room stands, with the result of an archived room', () => {
		expect(standingOfView(child('a', 'build', 'running'))).toBe('running');
		expect(standingOfView(child('a', 'build', 'running', { exchange }))).toBe('working');
		expect(standingOfView(child('a', 'build', 'stopped'))).toBe('stopped');
		expect(standingOfView(child('a', 'build', 'archived'))).toBe('done');
		const failed = {
			parent: 'build',
			opener: 'engineer',
			state: 'archived',
			close: { result: 'failed' },
		};
		expect(standingOfView(child('a', 'build', 'archived', { breakout: failed }))).toBe('failed');
		const plain = { parent: 'build', opener: 'engineer', state: 'archived' };
		expect(standingOfView(child('a', 'build', 'archived', { breakout: plain }))).toBe('archived');
	});

	it('is undefined for a root room and for no room', () => {
		expect(standingOfView(view('build'))).toBeUndefined();
		expect(standingOfView(undefined)).toBeUndefined();
	});

	it('gives each standing its own mark, and the mark and the word as text', () => {
		const standings = ['working', 'running', 'stopped', 'done', 'failed', 'archived'] as const;
		expect(standings.map(markOf)).toEqual(['●', '○', '–', '✓', '✗', '·']);
		expect(standingText('done')).toBe('✓ done');
		expect(standingText('working')).toBe('● working');
	});

	it('reads a room that the host does not hold as stopped, whatever its row says', () => {
		const dead = { name: 'a', status: 'stopped', working: true };
		const row = { ...dead, breakout: { parent: 'build', state: 'running' as const, goal: '' } };
		expect(standingOf(row)).toBe('stopped');
		expect(standingOf(dead)).toBeUndefined();
	});
});

describe('shortName and the path', () => {
	it('drops the prefix of the parent', () => {
		expect(shortName('build-datasheets', 'build')).toBe('datasheets');
		expect(shortName('build-a-b', 'build')).toBe('a-b');
	});

	it('keeps the full name when the prefix does not match, or when nothing would remain', () => {
		expect(shortName('tuners', 'build')).toBe('tuners');
		expect(shortName('builder-x', 'build')).toBe('builder-x');
		expect(shortName('build-', 'build')).toBe('build-');
		expect(shortName('build', 'build')).toBe('build');
	});

	it('joins the parent and the short name for a breakout room', () => {
		expect(pathParts('build-datasheets', 'build')).toEqual({
			head: 'build › ',
			leaf: 'datasheets',
		});
		expect(pathText('build-datasheets', 'build')).toBe('build › datasheets');
		expect(pathText('tuners', 'build')).toBe('build › tuners');
	});

	it('shows a root room by its name', () => {
		expect(pathParts('build')).toEqual({ head: '', leaf: 'build' });
		expect(pathText('build')).toBe('build');
	});
});

describe('roomChoices', () => {
	const names = (open: string) => roomChoices(rooms, open).map((choice) => choice.name);
	const picked = (open: string) =>
		roomChoices(rooms, open)
			.filter((choice) => choice.picked)
			.map((choice) => choice.name);

	it('lists each root room, then its breakout rooms, and the archived ones of the open room', () => {
		expect(names('build')).toEqual([
			'build',
			'tuners',
			'plan',
			'idle',
			'old-build',
			'cycling',
			'live-cycling',
		]);
	});

	it('lists the archived breakout rooms of the parent when a breakout room is open', () => {
		expect(names('tuners')).toEqual(names('build'));
		expect(names('old-cycling')).toEqual([
			'build',
			'tuners',
			'plan',
			'idle',
			'cycling',
			'old-cycling',
			'live-cycling',
		]);
	});

	it('hides every archived breakout room when no room is open', () => {
		expect(names('')).toEqual(['build', 'tuners', 'plan', 'idle', 'cycling', 'live-cycling']);
	});

	it('carries the facts that the palette shows', () => {
		const choices = roomChoices(rooms, 'build');
		expect(choices[0]).toEqual({ name: 'build', status: 'running', working: false });
		expect(choices[1]).toEqual({
			name: 'tuners',
			status: 'running',
			working: true,
			breakout: { parent: 'build', state: 'running', goal: 'tuners goal' },
		});
		expect(choices.find((choice) => choice.name === 'old-build')?.breakout).toEqual({
			parent: 'build',
			state: 'archived',
			result: 'done',
			goal: 'old-build goal',
		});
	});

	it('picks the newest running breakout room of the open room', () => {
		expect(picked('build')).toEqual(['plan']);
		expect(picked('cycling')).toEqual(['live-cycling']);
	});

	it('picks the parent when a breakout room is open, whatever its state', () => {
		expect(picked('tuners')).toEqual(['build']);
		expect(picked('idle')).toEqual(['build']);
		expect(picked('old-cycling')).toEqual(['cycling']);
	});

	it('picks the open room when it holds no running breakout room', () => {
		const quiet = [view('build'), child('a', 'build', 'stopped'), child('b', 'build', 'archived')];
		expect(roomChoices(quiet, 'build').filter((choice) => choice.picked)).toHaveLength(1);
		expect(roomChoices(quiet, 'build').find((choice) => choice.picked)?.name).toBe('build');
		expect(picked('bench')).toEqual([]);
	});

	it('does not count a running row without a live handle as running', () => {
		const dead = child('dead', 'build', 'running', { status: 'stopped' });
		const open = roomChoices([view('build'), dead], 'build');
		expect(open.find((choice) => choice.picked)?.name).toBe('build');
	});

	it('picks no room when none is open', () => {
		expect(picked('')).toEqual([]);
	});
});
