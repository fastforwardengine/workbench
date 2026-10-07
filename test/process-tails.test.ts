/** The newest output line of the processes that the running seats own, for the live block. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessOutput, ProcessView } from '../src/host/host.ts';
import { MOST, newestLine, ProcessTails, TAILS_MS } from '../src/terminal/state/process-tails.ts';
import { FakeHost } from './fake-host.ts';

const START = Date.parse('2026-01-01T12:00:00Z');
const at = (seconds: number) => new Date(START + seconds * 1000).toISOString();

const process = (handle: string, extra: Partial<ProcessView> = {}): ProcessView => ({
	handle,
	kind: 'bash',
	agent: 'engineer',
	room: 'build',
	command: 'python3 scan.py',
	state: 'running',
	output: `/home/engineer/.processes/${handle}/out`,
	timeout: 600,
	grace: 10,
	port: 20001,
	startedAt: at(0),
	...extra,
});

/** A host that counts its list reads and its output reads, and answers from `texts`. */
function hostOf(...table: ProcessView[]) {
	const host = new FakeHost();
	host.processTable = table;
	const texts = new Map<string, string>();
	const counts = { lists: 0, outputs: [] as string[] };
	const list = host.processes.bind(host);
	host.processes = async () => {
		counts.lists += 1;
		return list();
	};
	host.processOutput = async (handle: string): Promise<ProcessOutput> => {
		counts.outputs.push(handle);
		const text = texts.get(handle) ?? '';
		return { handle, text, size: text.length, truncated: false };
	};
	return { host, texts, counts };
}

const tailsOf = (host: FakeHost, now = () => START + 42_000) => {
	const changed = vi.fn();
	const tails = new ProcessTails(host, changed, now);
	made.push(tails);
	return { tails, changed };
};
const made: ProcessTails[] = [];

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	for (const tails of made.splice(0)) tails.stop();
	vi.useRealTimers();
});

describe('newestLine', () => {
	it.each([
		['one\ntwo\nthree\n', 'three'],
		['one\n\n   \n', 'one'],
		['', ''],
		['\u001b[32mgreen\u001b[0m ok\n', 'green ok'],
		['\u001b]0;title\u0007prompt $\n', 'prompt $'],
		['progress 10%\rprogress 90%\r', 'progress 90%'],
		['a\tb\u0000c\n', 'a bc'],
		['one\r\ntwo\r\n', 'two'],
		['\u001b[2K\n', ''],
		['\u001b[1mbold\u001b(B\u001b[m done\n', 'bold done'],
		['a\u009b31mb\u0085c\n', 'a31mbc'],
	])('takes the newest line of %j as %j', (text, line) => {
		expect(newestLine(text)).toBe(line);
	});
});

describe('the tails of the running seats', () => {
	it('reads nothing while no seat runs', async () => {
		const { host, counts } = hostOf(process('bash-1'));
		const { tails, changed } = tailsOf(host);
		tails.watch('build', []);
		await vi.advanceTimersByTimeAsync(5 * TAILS_MS);
		expect(counts.lists).toBe(0);
		expect(counts.outputs).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
		expect(tails.bySeat.size).toBe(0);
		expect(changed).not.toHaveBeenCalled();
	});

	it('reads at once, then each second, while a seat runs', async () => {
		const { host, texts, counts } = hostOf(process('bash-1'));
		texts.set('bash-1', 'booting\n');
		const { tails, changed } = tailsOf(host);
		tails.watch('build', ['engineer']);
		await vi.advanceTimersByTimeAsync(0);
		expect(counts.lists).toBe(1);
		expect(tails.bySeat.get('engineer')).toEqual([
			{ name: 'bash-1', runs: '0:42', line: 'booting' },
		]);
		expect(changed).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(TAILS_MS);
		await vi.advanceTimersByTimeAsync(TAILS_MS);
		expect(counts.lists).toBe(3);
		expect(counts.outputs).toEqual(['bash-1', 'bash-1', 'bash-1']);
	});

	it('shows the name, the newest line, and the new line after a change', async () => {
		const { host, texts } = hostOf(process('bash-1', { name: 'scan' }));
		texts.set('bash-1', 'step 1\n');
		const { tails, changed } = tailsOf(host);
		tails.watch('build', ['engineer']);
		await vi.advanceTimersByTimeAsync(0);
		texts.set('bash-1', 'step 1\nstep 2\n');
		await vi.advanceTimersByTimeAsync(TAILS_MS);
		expect(tails.bySeat.get('engineer')).toEqual([{ name: 'scan', runs: '0:42', line: 'step 2' }]);
		expect(changed).toHaveBeenCalledTimes(2);
		// The same lines draw nothing again.
		await vi.advanceTimersByTimeAsync(TAILS_MS);
		expect(changed).toHaveBeenCalledTimes(2);
	});

	it('keeps the processes of the open room, of a running seat, that run', async () => {
		const { host } = hostOf(
			process('bash-mine'),
			process('bash-other-room', { room: 'budget' }),
			process('bash-no-room', { room: undefined }),
			process('bash-other-seat', { agent: 'researcher' }),
			process('bash-ended', { state: 'exited', exitCode: 0 }),
		);
		const { tails } = tailsOf(host);
		tails.watch('build', ['engineer']);
		await vi.advanceTimersByTimeAsync(0);
		expect([...tails.bySeat.keys()]).toEqual(['engineer']);
		expect(tails.bySeat.get('engineer')?.map((line) => line.name)).toEqual(['bash-mine']);
	});

	it('groups by seat, newest first, and shows at most three of each', async () => {
		const table = [0, 1, 2, 3, 4].map((second) =>
			process(`bash-e${second}`, { startedAt: at(second) }),
		);
		table.push(process('bash-r', { agent: 'researcher', startedAt: at(1) }));
		const { host, counts } = hostOf(...table);
		const { tails } = tailsOf(host);
		tails.watch('build', ['engineer', 'researcher']);
		await vi.advanceTimersByTimeAsync(0);
		expect(MOST).toBe(3);
		expect(tails.bySeat.get('engineer')?.map((line) => line.name)).toEqual([
			'bash-e4',
			'bash-e3',
			'bash-e2',
		]);
		expect(tails.bySeat.get('researcher')?.map((line) => line.name)).toEqual(['bash-r']);
		// An output that no line shows is not read.
		expect(counts.outputs).not.toContain('bash-e0');
	});

	it('shows a process with no output yet, and one whose read failed, with an empty line', async () => {
		const { host } = hostOf(process('bash-1', { startedAt: at(1) }), process('bash-2'));
		host.processOutput = async (handle: string) => {
			if (handle === 'bash-2') throw new Error('The file is gone.');
			return { handle, text: '', size: 0, truncated: false };
		};
		const { tails } = tailsOf(host);
		tails.watch('build', ['engineer']);
		await vi.advanceTimersByTimeAsync(0);
		expect(tails.bySeat.get('engineer')).toEqual([
			{ name: 'bash-1', runs: '0:41', line: '' },
			{ name: 'bash-2', runs: '0:42', line: '' },
		]);
	});

	it('stops reading, and drops the lines, when the seats end', async () => {
		const { host, texts, counts } = hostOf(process('bash-1'));
		texts.set('bash-1', 'booting\n');
		const { tails } = tailsOf(host);
		tails.watch('build', ['engineer']);
		await vi.advanceTimersByTimeAsync(0);
		expect(tails.bySeat.size).toBe(1);
		tails.watch('build', []);
		expect(tails.bySeat.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		const lists = counts.lists;
		await vi.advanceTimersByTimeAsync(5 * TAILS_MS);
		expect(counts.lists).toBe(lists);
	});

	it('starts again when a seat runs again', async () => {
		const { host, counts } = hostOf(process('bash-1'));
		const { tails } = tailsOf(host);
		tails.watch('build', ['engineer']);
		await vi.advanceTimersByTimeAsync(0);
		tails.watch('build', []);
		tails.watch('build', ['engineer']);
		await vi.advanceTimersByTimeAsync(0);
		expect(counts.lists).toBe(2);
		expect(vi.getTimerCount()).toBe(1);
	});

	it('does not start a second timer for a second read of the room', async () => {
		const { host } = hostOf(process('bash-1'));
		const { tails } = tailsOf(host);
		tails.watch('build', ['engineer']);
		tails.watch('build', ['engineer', 'researcher']);
		expect(vi.getTimerCount()).toBe(1);
	});

	it('drops the lines of another room, and a read that lands after the change', async () => {
		const { host, texts } = hostOf(process('bash-1'));
		texts.set('bash-1', 'booting\n');
		let open = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const list = host.processes.bind(host);
		host.processes = async () => {
			const table = await list();
			await gate;
			return table;
		};
		const { tails, changed } = tailsOf(host);
		tails.watch('build', ['engineer']);
		await vi.advanceTimersByTimeAsync(0);
		tails.watch('budget', ['engineer']);
		open();
		await vi.advanceTimersByTimeAsync(0);
		expect(tails.bySeat.size).toBe(0);
		expect(changed).not.toHaveBeenCalled();
	});

	it('skips a tick while a read is in flight', async () => {
		const { host, counts } = hostOf(process('bash-1'));
		let open = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const list = host.processes.bind(host);
		host.processes = async () => {
			counts.lists += 1;
			await gate;
			return list();
		};
		const { tails } = tailsOf(host);
		tails.watch('build', ['engineer']);
		await vi.advanceTimersByTimeAsync(3 * TAILS_MS);
		expect(counts.lists).toBe(1);
		open();
		await vi.advanceTimersByTimeAsync(TAILS_MS);
		expect(counts.lists).toBeGreaterThan(1);
	});

	it('keeps the last lines when a list read fails', async () => {
		const { host, texts } = hostOf(process('bash-1'));
		texts.set('bash-1', 'booting\n');
		const { tails } = tailsOf(host);
		tails.watch('build', ['engineer']);
		await vi.advanceTimersByTimeAsync(0);
		host.processFailure = 'The workspace is closed.';
		await vi.advanceTimersByTimeAsync(TAILS_MS);
		expect(tails.bySeat.get('engineer')?.[0]?.line).toBe('booting');
		host.processFailure = undefined;
		texts.set('bash-1', 'done\n');
		await vi.advanceTimersByTimeAsync(TAILS_MS);
		expect(tails.bySeat.get('engineer')?.[0]?.line).toBe('done');
	});

	it('starts no timer after dispose, for a room read that lands late', async () => {
		const { host, counts } = hostOf(process('bash-1'));
		const { tails } = tailsOf(host);
		tails.watch('build', ['engineer']);
		await vi.advanceTimersByTimeAsync(0);
		tails.dispose();
		tails.watch('build', ['engineer']);
		await vi.advanceTimersByTimeAsync(5 * TAILS_MS);
		expect(vi.getTimerCount()).toBe(0);
		expect(counts.lists).toBe(1);
		expect(tails.bySeat.size).toBe(0);
	});
});
