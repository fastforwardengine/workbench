import { describe, expect, it } from 'vitest';
import { type Choices, parse, type RoomChoice, suggest } from '../src/terminal/state/commands.ts';

const rooms: RoomChoice[] = [
	{ name: 'characterization', status: 'running', working: false },
	{ name: 'cycling', status: 'running', working: true },
	{ name: 'budget', status: 'stopped', working: false },
];

const choices: Choices = {
	agents: [
		{ name: 'assistant', state: 'broadcast' },
		{ name: 'builder', state: 'named' },
		{ name: 'datasheets', state: 'not seated' },
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
		expect(parse('/CANCEL')).toEqual({ kind: 'command', name: 'cancel', argument: '' });
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
		expect(parse('@Builder check the diode')).toEqual({
			kind: 'message',
			text: '@Builder check the diode',
			to: 'builder',
		});
		expect(parse('@builder, check the diode')).toMatchObject({ to: 'builder' });
		expect(parse('@builder: check')).toMatchObject({ to: 'builder' });
		expect(parse("@Builder's step")).toMatchObject({ to: 'builder' });
		expect(parse('@datasheets')).toEqual({
			kind: 'message',
			text: '@datasheets',
			to: 'datasheets',
		});
		expect(parse('@builder\nsecond line')).toMatchObject({ to: 'builder' });
	});

	it('addresses a seat only at the start, and only for a name', () => {
		expect(parse('ask @builder')).toEqual({ kind: 'message', text: 'ask @builder' });
		expect(parse('@ 5 V')).toEqual({ kind: 'message', text: '@ 5 V' });
	});

	it('lets a double at sign send a message that starts with one at sign', () => {
		expect(parse('@@builder is the name')).toEqual({
			kind: 'message',
			text: '@builder is the name',
		});
	});

	it('sends a multi-line text as a message, even after a slash', () => {
		expect(parse('/cancel\nand then explain')).toMatchObject({ kind: 'message' });
	});
});

describe('suggest a seat', () => {
	it('lists every seat for a lone at sign, with its attention', () => {
		expect(
			suggest('@', choices).map((row) => [row.label, row.detail, row.insert, row.run]),
		).toEqual([
			['@assistant', 'broadcast', '@assistant ', false],
			['@builder', 'named', '@builder ', false],
			['@datasheets', 'not seated', '@datasheets ', false],
		]);
	});

	it('narrows by prefix, and closes once the name has a space', () => {
		expect(suggest('@b', choices).map((row) => row.label)).toEqual(['@builder']);
		expect(suggest('@x', choices)).toEqual([]);
		expect(suggest('@builder ', choices)).toEqual([]);
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
				'/cancel',
				'/dismiss',
				'/stop',
				'/resume',
				'/expand',
				'/collapse',
			]),
		);
	});

	it('filters commands by prefix', () => {
		expect(suggest('/c', choices).map((row) => row.label)).toEqual(['/cancel', '/collapse']);
		expect(suggest('/can', choices).map((row) => row.label)).toEqual(['/cancel']);
	});

	it('runs a command that takes no argument, and only completes one that does', () => {
		expect(suggest('/can', choices)[0]).toMatchObject({ insert: '/cancel', run: true });
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
		expect(suggest('/cancel now', choices)).toEqual([]);
		expect(suggest('/room a\nb', choices)).toEqual([]);
	});
});

describe('the steps command', () => {
	it('parses with its argument and appears in the palette', () => {
		expect(parse('/steps 2')).toEqual({ kind: 'command', name: 'steps', argument: '2' });
		expect(suggest('/st', choices).map((row) => row.label)).toContain('/steps');
	});
});
