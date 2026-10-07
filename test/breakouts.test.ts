/** What the terminal reads from the breakout rooms of the room list. */
import { describe, expect, it } from 'vitest';
import {
	backgroundChip,
	backgroundOf,
	breakoutLabel,
	roomChoices,
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

describe('backgroundChip', () => {
	it('is one short phrase, and is empty when nothing runs', () => {
		expect(backgroundChip({ running: 2, working: false })).toBe('⇉ 2 in background');
		expect(backgroundChip({ running: 1, working: true })).toBe('⇉ 1 in background');
		expect(backgroundChip({ running: 0, working: false })).toBe('');
	});
});

describe('breakoutLabel', () => {
	it('names the parent, and adds the result of an archived room', () => {
		expect(breakoutLabel(child('a', 'build', 'running'))).toBe('breakout of build');
		expect(breakoutLabel(child('a', 'build', 'stopped'))).toBe('breakout of build');
		expect(breakoutLabel(child('a', 'build', 'archived'))).toBe('breakout of build · done');
	});

	it('is empty for a root room and for no room', () => {
		expect(breakoutLabel(view('build'))).toBe('');
		expect(breakoutLabel(undefined)).toBe('');
	});
});

describe('roomChoices', () => {
	const names = (open: string) => roomChoices(rooms, open).map((choice) => choice.name);

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
});
