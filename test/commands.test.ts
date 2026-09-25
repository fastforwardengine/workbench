import { describe, expect, it } from 'vitest';
import { type Choices, parse, type RoomChoice, suggest } from '../src/terminal/commands.ts';

const rooms: RoomChoice[] = [
	{ name: 'characterization', status: 'running', working: false },
	{ name: 'cycling', status: 'running', working: true },
	{ name: 'budget', status: 'stopped', working: false },
];

const choices: Choices = {
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
			owner: 'mira',
			due: '2026-09-25T10:00:00.000Z',
			text: 'Check the sweep.',
		},
		{
			seq: 57,
			seat: 'bench',
			owner: 'mira',
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

	it('sends a multi-line text as a message, even after a slash', () => {
		expect(parse('/abort\nand then explain')).toMatchObject({ kind: 'message' });
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
				'/expand',
				'/collapse',
			]),
		);
	});

	it('filters commands by prefix', () => {
		expect(suggest('/a', choices).map((row) => row.label)).toEqual(['/abort']);
	});

	it('runs a command that takes no argument, and only completes one that does', () => {
		expect(suggest('/abo', choices)[0]).toMatchObject({ insert: '/abort', run: true });
		expect(suggest('/ro', choices)[0]).toMatchObject({ insert: '/room ', run: false });
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
