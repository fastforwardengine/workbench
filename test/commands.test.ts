import { describe, expect, it } from 'vitest';
import { type Choices, parse, type RoomChoice, suggest } from '../src/terminal/state/commands.ts';
import { rowLabel } from '../src/terminal/widgets/composer.ts';

const rooms: RoomChoice[] = [
	{ name: 'characterization', status: 'running', working: false },
	{ name: 'cycling', status: 'running', working: true },
	{ name: 'budget', status: 'stopped', working: false },
];

const choices: Choices = {
	seats: [
		{ name: 'engineer', state: 'broadcast' },
		{ name: 'researcher', state: 'named' },
	],
	rooms,
	people: [
		{ name: 'priya', role: 'Hardware lead' },
		{ name: 'noor', role: 'Electrochemistry lead' },
	],
	files: [
		{ path: '/library/cell-18650.md', size: 797 },
		{ path: '/shared/notes.md', size: 2048 },
	],
	says: [
		{
			seq: 41,
			seat: 'bench',
			due: '2026-09-25T10:00:00.000Z',
			text: 'Check the sweep.',
		},
		{
			seq: 57,
			seat: 'bench',
			due: '2026-09-25T11:00:00.000Z',
			text: 'Read the log.',
		},
	],
};

describe('parse', () => {
	it('reads plain text as a message', () => {
		expect(parse('  Which resistor?  ')).toEqual({ kind: 'message', text: 'Which resistor?' });
	});

	it('reads a command and its argument', () => {
		expect(parse('/room characterization')).toEqual({
			kind: 'command',
			name: 'room',
			argument: 'characterization',
		});
		expect(parse('/ABORT')).toEqual({ kind: 'command', name: 'abort', argument: '' });
	});

	it('reports an unknown command by name', () => {
		expect(parse('/library/cell-18650.md')).toEqual({
			kind: 'unknown',
			name: 'library/cell-18650.md',
		});
	});

	it('lets a double slash send a message that starts with one slash', () => {
		expect(parse('//library/cell-18650.md is the datasheet')).toEqual({
			kind: 'message',
			text: '/library/cell-18650.md is the datasheet',
		});
	});

	it('reads a leading @name as the seat that the message addresses, and keeps the text', () => {
		expect(parse('@Engineer check the diode')).toEqual({
			kind: 'message',
			text: '@Engineer check the diode',
			to: 'engineer',
		});
		expect(parse('@engineer, check the diode')).toMatchObject({ to: 'engineer' });
		expect(parse('@engineer: check')).toMatchObject({ to: 'engineer' });
		expect(parse("@Engineer's step")).toMatchObject({ to: 'engineer' });
		expect(parse('@researcher')).toEqual({
			kind: 'message',
			text: '@researcher',
			to: 'researcher',
		});
		expect(parse('@engineer\nsecond line')).toMatchObject({ to: 'engineer' });
	});

	it('addresses a seat only at the start, and only for a name', () => {
		expect(parse('ask @engineer')).toEqual({ kind: 'message', text: 'ask @engineer' });
		expect(parse('@ 5 V')).toEqual({ kind: 'message', text: '@ 5 V' });
	});

	it('lets a double at sign send a message that starts with one at sign', () => {
		expect(parse('@@engineer is the name')).toEqual({
			kind: 'message',
			text: '@engineer is the name',
		});
	});

	it('sends a multi-line text as a message, even after a slash', () => {
		expect(parse('/abort\nand then explain')).toMatchObject({ kind: 'message' });
	});
});

describe('suggest a seat', () => {
	it('lists every seat for a lone at sign, with its attention', () => {
		expect(
			suggest('@', choices).map((row) => [row.label, row.detail, row.insert, row.run]),
		).toEqual([
			['@engineer', 'broadcast', '@engineer ', false],
			['@researcher', 'named', '@researcher ', false],
		]);
	});

	it('narrows by prefix, and closes once the name has a space', () => {
		expect(suggest('@e', choices).map((row) => row.label)).toEqual(['@engineer']);
		expect(suggest('@x', choices)).toEqual([]);
		expect(suggest('@engineer ', choices)).toEqual([]);
	});
});

describe('suggest', () => {
	it('lists every command for a lone slash', () => {
		const labels = suggest('/', choices).map((row) => row.label);
		expect(labels).toEqual(
			expect.arrayContaining([
				'/room',
				'/new',
				'/user',
				'/files',
				'/open',
				'/try',
				'/abort',
				'/dismiss',
				'/stop',
				'/resume',
			]),
		);
	});

	it('filters commands by prefix', () => {
		expect(suggest('/a', choices).map((row) => row.label)).toEqual(['/attach', '/abort']);
		expect(suggest('/ab', choices).map((row) => row.label)).toEqual(['/abort']);
	});

	it('runs a command that takes no argument, and only completes one that does', () => {
		expect(suggest('/abo', choices)[0]).toMatchObject({ insert: '/abort', run: true });
		expect(suggest('/ro', choices)[0]).toMatchObject({ insert: '/room ', run: false });
		expect(suggest('/att', choices)[0]).toMatchObject({ insert: '/attach ', run: false });
	});

	it('lists the rooms after /room, with their state', () => {
		const rows = suggest('/room ', choices);
		expect(rows.map((row) => [row.label, row.detail])).toEqual([
			['characterization', 'running'],
			['cycling', 'working'],
			['budget', 'stopped'],
		]);
		expect(rows[0]).toMatchObject({ insert: '/room characterization', run: true });
	});

	it('lists a breakout room after its parent, with its state and its goal', () => {
		const breakout = (state: 'running' | 'stopped' | 'archived', extra = {}) => ({
			parent: 'cycling',
			state,
			goal: 'Compare the datasheets of three tuners',
			...extra,
		});
		const withChildren: Choices = {
			...choices,
			rooms: [
				rooms[0] as RoomChoice,
				rooms[1] as RoomChoice,
				{ name: 'tuners', status: 'running', working: true, breakout: breakout('running') },
				{ name: 'plan', status: 'running', working: false, breakout: breakout('running') },
				{ name: 'idle', status: 'stopped', working: false, breakout: breakout('stopped') },
				{
					name: 'old',
					status: 'stopped',
					working: false,
					breakout: breakout('archived', { result: 'done' }),
				},
				{
					name: 'lost',
					status: 'stopped',
					working: false,
					breakout: breakout('archived', { result: 'failed' }),
				},
				rooms[2] as RoomChoice,
			],
		};
		const rows = suggest('/room ', withChildren);
		const goal = 'Compare the datasheets of three tuners';
		expect(rows.map((row) => [row.label, row.detail])).toEqual([
			['characterization', 'running'],
			['cycling', 'working'],
			['tuners', `working · ${goal}`],
			['plan', `running · ${goal}`],
			['idle', `stopped · ${goal}`],
			['old', `done · ${goal}`],
			['lost', `failed · ${goal}`],
			['budget', 'stopped'],
		]);
		expect(rows[2]).toMatchObject({ insert: '/room tuners', run: true });
	});

	describe('the tree of the room list', () => {
		const breakout = (parent: string, state: 'running' | 'stopped' | 'archived', extra = {}) => ({
			parent,
			state,
			goal: 'Compare three LDOs',
			...extra,
		});
		const tree: Choices = {
			...choices,
			rooms: [
				{ name: 'build', status: 'running', working: true },
				{
					name: 'build-datasheets',
					status: 'running',
					working: true,
					breakout: breakout('build', 'running'),
				},
				{
					name: 'build-sweep',
					status: 'running',
					working: false,
					breakout: breakout('build', 'running'),
				},
				{
					name: 'build-tuner-notes',
					status: 'stopped',
					working: false,
					breakout: breakout('build', 'archived', { result: 'done' }),
				},
				{ name: 'bench', status: 'running', working: false },
				{
					name: 'stray',
					status: 'running',
					working: false,
					breakout: breakout('bench', 'running'),
				},
			],
		};

		it('shows the short name, the mark, and the branch of each breakout row', () => {
			const rows = suggest('/room ', tree);
			expect(rows.map((row) => [row.label, row.tree])).toEqual([
				['build', undefined],
				['datasheets', { last: false, mark: '●' }],
				['sweep', { last: false, mark: '○' }],
				['tuner-notes', { last: true, mark: '✓' }],
				['bench', undefined],
				['stray', { last: true, mark: '○' }],
			]);
			expect(rows.map(rowLabel)).toEqual([
				'build',
				'  ├ ● datasheets',
				'  ├ ○ sweep',
				'  └ ✓ tuner-notes',
				'bench',
				'  └ ○ stray',
			]);
		});

		it('inserts the full name, and keeps the state and the goal in the detail', () => {
			const rows = suggest('/room ', tree);
			expect(rows[1]).toMatchObject({
				insert: '/room build-datasheets',
				run: true,
				detail: 'working · Compare three LDOs',
			});
			expect(rows[5]?.insert).toBe('/room stray');
		});

		it('matches the full name or the short name, and keeps the tree order', () => {
			const labels = (text: string) => suggest(`/room ${text}`, tree).map((row) => row.label);
			expect(labels('data')).toEqual(['datasheets']);
			expect(labels('build-s')).toEqual(['sweep']);
			expect(labels('S')).toEqual(['sweep', 'stray']);
			expect(labels('b')).toEqual(['build', 'datasheets', 'sweep', 'tuner-notes', 'bench']);
			expect(labels('nothing')).toEqual([]);
		});

		it('ends the branch at the last shown child of a filter', () => {
			const last = (text: string) => suggest(`/room ${text}`, tree).map((row) => row.tree?.last);
			expect(last('build-')).toEqual([false, false, true]);
			expect(last('build-s')).toEqual([true]);
			expect(last('s')).toEqual([true, true]);
		});

		it('flags the picked room for an empty filter only', () => {
			const picked: Choices = {
				...tree,
				rooms: tree.rooms.map((room) =>
					room.name === 'build-sweep' ? { ...room, picked: true } : room,
				),
			};
			expect(suggest('/room ', picked).map((row) => row.picked)).toEqual([
				undefined,
				undefined,
				true,
				undefined,
				undefined,
				undefined,
			]);
			expect(suggest('/room sw', picked).map((row) => row.picked)).toEqual([undefined]);
			expect(suggest('/room   ', picked).some((row) => row.picked)).toBe(true);
		});

		it('keeps the whole name when the prefix of the parent does not match', () => {
			const rows = suggest('/room stray', tree);
			expect(rows[0]?.label).toBe('stray');
		});
	});

	it('cuts the goal of a breakout room to fit', () => {
		const goal = 'Compare the datasheets of three tuners and rank them by sensitivity and cost';
		const rows = suggest('/room ', {
			...choices,
			rooms: [
				{
					name: 'tuners',
					status: 'running',
					working: false,
					breakout: { parent: 'cycling', state: 'running', goal },
				},
			],
		});
		const detail = rows[0]?.detail ?? '';
		expect(detail.startsWith('running · Compare the datasheets')).toBe(true);
		expect(detail.endsWith('…')).toBe(true);
		expect(detail.length).toBeLessThan(`running · ${goal}`.length);
	});

	it('lists the people after /user, with their role', () => {
		expect(suggest('/user ', choices).map((row) => [row.label, row.detail, row.insert])).toEqual([
			['priya', 'Hardware lead', '/user priya'],
			['noor', 'Electrochemistry lead', '/user noor'],
		]);
		expect(suggest('/user n', choices).map((row) => row.label)).toEqual(['noor']);
	});

	it('lists the files after /open, matching anywhere in the path', () => {
		expect(suggest('/open ', choices).map((row) => [row.label, row.detail])).toEqual([
			['/library/cell-18650.md', '797 B'],
			['/shared/notes.md', '2.0 KB'],
		]);
		expect(suggest('/open NOTES', choices).map((row) => row.insert)).toEqual([
			'/open /shared/notes.md',
		]);
	});

	it('lists the says that wait after /dismiss, with their seat and text, in their own palette', () => {
		const rows = suggest('/dismiss ', choices);
		expect(rows.map((row) => [row.label, row.detail, row.insert, row.kind])).toEqual([
			['41', 'bench: Check the sweep.', '/dismiss 41', 'say'],
			['57', 'bench: Read the log.', '/dismiss 57', 'say'],
		]);
		expect(suggest('/dismiss 5', choices).map((row) => row.label)).toEqual(['57']);
	});

	it('only completes /new, which takes free text', () => {
		expect(suggest('/n', choices)[0]).toMatchObject({ insert: '/new ', run: false });
		expect(suggest('/new characterization2', choices)).toEqual([]);
	});

	it('filters the rooms by what follows /room', () => {
		expect(suggest('/room BU', choices).map((row) => row.label)).toEqual(['budget']);
	});

	it('opens no palette for text, for a double slash, or for an argument of another command', () => {
		expect(suggest('hello', choices)).toEqual([]);
		expect(suggest('//path', choices)).toEqual([]);
		expect(suggest('/abort now', choices)).toEqual([]);
		expect(suggest('/room a\nb', choices)).toEqual([]);
	});
});

describe('the steps command', () => {
	it('parses with its argument and appears in the palette', () => {
		expect(parse('/steps 2')).toEqual({ kind: 'command', name: 'steps', argument: '2' });
		expect(suggest('/st', choices).map((row) => row.label)).toContain('/steps');
	});
});

describe('the camera command', () => {
	it('parses with no argument and appears in the palette', () => {
		expect(parse('/camera')).toEqual({ kind: 'command', name: 'camera', argument: '' });
		expect(suggest('/cam', choices)).toEqual([
			expect.objectContaining({ label: '/camera', insert: '/camera', run: true }),
		]);
	});
});
