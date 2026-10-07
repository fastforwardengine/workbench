import { describe, expect, it } from 'vitest';
import { callPhrase, failurePhrase, resultPhrase } from '../src/view/tool-phrases.ts';

const text = (value: string, details?: Record<string, unknown>) => ({
	content: [{ type: 'text', text: value }],
	...(details ? { details } : {}),
});

describe('callPhrase', () => {
	it.each([
		['bash', { command: 'python3 scan.py\nsecond line', name: 'scan' }, '$ python3 scan.py'],
		['read', { path: '/notes/board.md', offset: 3 }, '→ read /notes/board.md'],
		['write', { path: '/a.txt', content: 'b' }, '✎ write /a.txt'],
		['edit', { path: '/a.txt', edits: [{ oldText: 'a', newText: 'b' }] }, '✎ edit /a.txt'],
		['sql', { sql: 'select * from readings\nwhere v > 1' }, '◇ sql select * from readings'],
		['fetch', { process: 'bench', path: '/temperature' }, '⇄ fetch bench /temperature'],
		['ps', {}, '⋯ ps'],
		['wait', { handles: ['bash-1', 'bash-2'], timeout: 5 }, '⋯ wait bash-1, bash-2'],
		['cancel', { handle: 'bash-1' }, '⋯ cancel bash-1'],
		[
			'breakout',
			{
				name: 'datasheets',
				goal: 'Compare the tuners.\nSecond line',
				message: 'm',
				agents: ['engineer-bg'],
			},
			'⇉ breakout datasheets: Compare the tuners.',
		],
		['breakout', { name: 'datasheets', message: 'm' }, '⇉ breakout datasheets'],
		['tell', { room: 'build-datasheets', text: 'Add the TEA5767.' }, '⇢ tell build-datasheets'],
		['archive', { room: 'build-datasheets', result: 'done' }, '⇥ archive build-datasheets done'],
		[
			'archive',
			{ room: 'build-datasheets', result: 'failed', note: 'x' },
			'⇥ archive build-datasheets failed',
		],
		['archive', { room: 'build-datasheets' }, '⇥ archive build-datasheets'],
		[
			'report',
			{ text: 'The RDA5807FP wins.\nBecause.', refs: ['file:///library/a.md'] },
			'⇇ report The RDA5807FP wins.',
		],
	])('writes %s as %s', (name, input, phrase) => {
		expect(callPhrase(name, input)).toBe(phrase);
	});

	it('cuts a long command to one short line', () => {
		expect(callPhrase('bash', { command: 'x'.repeat(200) })).toBe(`$ ${'x'.repeat(99)}…`);
	});

	it('keeps the plain form for a tool with no phrase', () => {
		expect(callPhrase('camera', { shot: 1, fast: true })).toBe('camera {"shot":1,"fast":true}');
		expect(callPhrase('say', { text: 'hello\nmore' })).toBe('say hello');
		expect(callPhrase('list', {})).toBe('list {}');
		expect(callPhrase('echo', 'plain')).toBe('echo plain');
		expect(callPhrase('noop', undefined)).toBe('noop');
	});

	it('keeps the plain form when the input lacks the field of the phrase', () => {
		expect(callPhrase('bash', { script: 'ls' })).toBe('bash ls');
		expect(callPhrase('read', {})).toBe('read {}');
		expect(callPhrase('wait', { handles: [] })).toBe('wait {"handles":[]}');
		expect(callPhrase('fetch', { process: 'bench' })).toBe('fetch bench');
		expect(callPhrase('constructor', {})).toBe('constructor {}');
		expect(callPhrase('breakout', { goal: 'Compare.' })).toBe('breakout Compare.');
		expect(callPhrase('archive', { result: 'done' })).toBe('archive done');
		expect(callPhrase('tell', {})).toBe('tell {}');
	});
});

describe('resultPhrase', () => {
	const running =
		'[Process bash-1a2b (scan) is running. Output: /p/bash-1a2b/out. Call wait with its handle.]';
	const exited = 'ok\n\n[Process bash-1a2b exited with code 0. Output: /p/bash-1a2b/out.]';

	it('shows the handle of a bash process that runs, and its exit code when known', () => {
		expect(resultPhrase('bash', text(running))).toBe('→ bash-1a2b');
		expect(resultPhrase('bash', text(exited))).toBe('exit 0');
		expect(resultPhrase('bash', text('x\n\n[Process bash-9 timed out after 5 seconds.]'))).toBe(
			'timed out',
		);
	});

	it('shows the first line of a bash output that holds no process line', () => {
		expect(resultPhrase('bash', text('\n0.00 V\nmore'))).toBe('0.00 V');
	});

	it('shows the lines of a file from the details, else from the text', () => {
		expect(resultPhrase('read', text('a\nb', { lines: 42 }))).toBe('42 lines');
		expect(resultPhrase('read', text('a\nb\nc\n'))).toBe('3 lines');
		expect(resultPhrase('read', text('a'))).toBe('1 line');
		expect(resultPhrase('read', text('a', { from: 100, to: 110, lines: 500 }))).toBe(
			'lines 100-110 of 500',
		);
		expect(resultPhrase('read', text('a', { from: 1, to: 500, lines: 500 }))).toBe('500 lines');
		expect(resultPhrase('read', text('', { from: 5, to: 4, lines: 4 }))).toBe('4 lines');
		expect(resultPhrase('read', text('', { image: { mimeType: 'image/png' } }))).toBe('image');
		expect(resultPhrase('read', { value: 3 })).toBe('{"value":3}');
	});

	it('shows no result for a write, and the blocks of an edit', () => {
		expect(resultPhrase('write', text('Successfully wrote to /a'))).toBe('');
		expect(resultPhrase('edit', text('Successfully replaced 2 block(s) in /a.'))).toBe('2 blocks');
		expect(resultPhrase('edit', text('Successfully replaced 1 block(s) in /a.'))).toBe('1 block');
		expect(resultPhrase('edit', text('Changed.'))).toBe('Changed.');
	});

	it('shows the rows of a query from the details, else from the footer', () => {
		expect(resultPhrase('sql', text('| a |', { count: 3 }))).toBe('3 rows');
		expect(resultPhrase('sql', text('| a |\n\n1 row.'))).toBe('1 row');
		expect(resultPhrase('sql', text('| a |\n\nShows 50 of 120 rows. Add a LIMIT.'))).toBe(
			'120 rows',
		);
		expect(resultPhrase('sql', text('Ran on lab. No rows.'))).toBe('0 rows');
		expect(resultPhrase('sql', text('done'))).toBe('done');
	});

	it('shows the status of a fetch', () => {
		const line = 'Fetched /temperature from bench (bash-1): 200, text/plain, 4 bytes.';
		expect(resultPhrase('fetch', text(line, { status: 503 }))).toBe('503');
		expect(resultPhrase('fetch', text(line))).toBe('200');
	});

	it('shows the processes of ps, and the state of wait and cancel', () => {
		expect(resultPhrase('ps', text('No running processes.'))).toBe('none');
		expect(resultPhrase('ps', text('| Handle |\n\n2 running processes.'))).toBe('2 running');
		expect(resultPhrase('ps', text('x', { processes: [{}] }))).toBe('1 running');
		expect(resultPhrase('wait', text(exited))).toBe('exit 0');
		expect(resultPhrase('wait', text(running))).toBe('running');
		expect(resultPhrase('cancel', text('[Process bash-3 is cancelled. Output: /p.]'))).toBe(
			'cancelled',
		);
	});

	it('shows the room of a breakout, the seq of a tell and a report, and nothing for an archive', () => {
		const opened = text('Opened the breakout room "build-datasheets": running.', {
			room: 'build-datasheets',
			state: 'running',
		});
		expect(resultPhrase('breakout', opened)).toBe('build-datasheets');
		expect(resultPhrase('breakout', text('Opened.'))).toBe('Opened.');
		expect(
			resultPhrase('tell', text('Posted into "r" as message #7.', { room: 'r', from: 7 })),
		).toBe('#7');
		expect(resultPhrase('report', text('Reported into "build" as message #9.', { from: 9 }))).toBe(
			'#9',
		);
		expect(resultPhrase('report', text('Reported into "build".'))).toBe('Reported into "build".');
		expect(resultPhrase('archive', text('Archived "r" as done.', { result: 'done' }))).toBe('');
	});

	it('keeps the first line of the output for a tool with no phrase', () => {
		expect(resultPhrase('camera', text('\nframe 1\nframe 2'))).toBe('frame 1');
		expect(resultPhrase('camera', { value: 3 })).toBe('{"value":3}');
		expect(resultPhrase('camera', 'plain')).toBe('plain');
		expect(resultPhrase('camera', [{ type: 'text', text: 'bare' }])).toBe('bare');
	});
});

describe('the state of a process in a result', () => {
	const facts = (handle: string, state: string, exitCode?: number) => ({
		handle,
		state,
		...(exitCode === undefined ? {} : { exitCode }),
	});
	const line = (handle: string, end: string) => `[Process ${handle} ${end} Output: /p/out.]`;

	it('reads the state from the details when they hold it', () => {
		const shown = 'Process worker-1 is running\n\n[Process bash-2 exited with code 0. Output: /p.]';
		expect(resultPhrase('bash', text(shown, { process: facts('bash-2', 'exited', 0) }))).toBe(
			'exit 0',
		);
		expect(resultPhrase('bash', text(shown))).toBe('exit 0');
		const running = text('x', { process: facts('bash-3', 'running') });
		expect(resultPhrase('bash', running)).toBe('→ bash-3');
		expect(resultPhrase('wait', text('x', { process: facts('bash-3', 'timed_out') }))).toBe(
			'timed out',
		);
		expect(resultPhrase('cancel', text('x', { process: facts('bash-3', 'cancelled') }))).toBe(
			'cancelled',
		);
	});

	it('reads the last state line of a text with no details', () => {
		const output = `Process worker-1 is running\n\n${line('bash-2', 'is running.')}`;
		expect(resultPhrase('bash', text(output))).toBe('→ bash-2');
	});

	it('shows each process of a wait on several handles', () => {
		const processes = [facts('a', 'exited', 0), facts('b', 'running')];
		expect(resultPhrase('wait', text('x', { processes }))).toBe('a exit 0, b running');
		const both = `${line('a', 'exited with code 0.')}\n\n${line('b', 'is running.')}`;
		expect(resultPhrase('wait', text(both))).toBe('a exit 0, b running');
	});

	it('shows the first process that ended badly in an error', () => {
		const error = `${line('a', 'exited with code 0.')}\n\n${line('b', 'exited with code 1.')}`;
		expect(failurePhrase('wait', error)).toBe('failed: exit 1');
		const last = `${line('a', 'exited with code 2.')}\n\n${line('b', 'timed out after 5 seconds.')}`;
		expect(failurePhrase('wait', last)).toBe('failed: exit 2');
		const timed = `${line('a', 'exited with code 0.')}\n\n${line('b', 'timed out after 5 seconds.')}`;
		expect(failurePhrase('wait', timed)).toBe('failed: timed out');
	});

	it('shows a process in the state failed once', () => {
		expect(failurePhrase('bash', line('a', 'failed: spawn error.'))).toBe('failed');
	});
});

describe('failurePhrase', () => {
	it('shows the exit code of a process that ended badly', () => {
		const error = 'boom\n\n[Process bash-1 exited with code 2. Output: /p/out.]';
		expect(failurePhrase('bash', error)).toBe('failed: exit 2');
		expect(failurePhrase('wait', error)).toBe('failed: exit 2');
	});

	it('shows the first line of any other failure', () => {
		expect(failurePhrase('bash', 'port busy\nmore')).toBe('failed: port busy');
		expect(failurePhrase('read', 'ENOENT: no such file')).toBe('failed: ENOENT: no such file');
		expect(failurePhrase('camera', 'lens cap on')).toBe('failed: lens cap on');
	});
});
