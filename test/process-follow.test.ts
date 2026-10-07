/** The timer of the processes layer: it reads the output of a running process again and again. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessOutput, ProcessView } from '../src/host/host.ts';
import { FOLLOW_MS, ProcessBrowser } from '../src/terminal/state/process-browser.ts';
import { FakeHost } from './fake-host.ts';

const process = (handle: string, extra: Partial<ProcessView> = {}): ProcessView => ({
	handle,
	kind: 'bash',
	agent: 'engineer',
	command: 'python3 scan.py',
	state: 'running',
	output: `/home/engineer/.processes/${handle}/out`,
	timeout: 600,
	grace: 10,
	port: 20001,
	startedAt: '2026-01-01T12:00:00Z',
	...extra,
});

/** A host whose output reads count themselves, and wait for a gate while one is set. */
function hostOf(...table: ProcessView[]) {
	const host = new FakeHost();
	host.processTable = table;
	const reads: string[] = [];
	const gate: { current: Promise<void> | undefined } = { current: undefined };
	host.processOutput = async (handle: string): Promise<ProcessOutput> => {
		reads.push(handle);
		const text = `read ${reads.length} of ${handle}\n`;
		if (gate.current) await gate.current;
		return { handle, text, size: text.length, truncated: false };
	};
	return { host, reads, gate };
}

/** Hold the next output reads until the returned function runs. */
function hold(gate: { current: Promise<void> | undefined }): () => void {
	let release = () => {};
	gate.current = new Promise<void>((resolve) => {
		release = () => {
			gate.current = undefined;
			resolve();
		};
	});
	return release;
}

const browsers: ProcessBrowser[] = [];
const browser = (host: FakeHost): ProcessBrowser => {
	const made = new ProcessBrowser(host, () => {});
	browsers.push(made);
	return made;
};

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	for (const made of browsers.splice(0)) made.dispose();
	vi.useRealTimers();
});

describe('the follow timer of the processes layer', () => {
	it('reads the output again each second while the chosen process runs', async () => {
		const { host, reads } = hostOf(process('bash-1'));
		const panel = browser(host);
		await panel.show();
		expect(reads).toEqual(['bash-1']);
		await vi.advanceTimersByTimeAsync(FOLLOW_MS);
		expect(reads).toHaveLength(2);
		expect(panel.output?.text).toBe('read 2 of bash-1\n');
		await vi.advanceTimersByTimeAsync(2 * FOLLOW_MS);
		expect(reads).toHaveLength(4);
	});

	it('draws after each read', async () => {
		const { host } = hostOf(process('bash-1'));
		const changed = vi.fn();
		const panel = new ProcessBrowser(host, changed);
		browsers.push(panel);
		await panel.show();
		const before = changed.mock.calls.length;
		await vi.advanceTimersByTimeAsync(FOLLOW_MS);
		expect(changed.mock.calls.length).toBe(before + 1);
	});

	it('starts no timer for a process that has ended', async () => {
		const { host, reads } = hostOf(process('bash-1', { state: 'exited', exitCode: 0 }));
		const panel = browser(host);
		await panel.show();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(3 * FOLLOW_MS);
		expect(reads).toHaveLength(1);
	});

	it('stops on hide, and starts again on resume', async () => {
		const { host, reads } = hostOf(process('bash-1'));
		const panel = browser(host);
		await panel.show();
		panel.hide();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(3 * FOLLOW_MS);
		expect(reads).toHaveLength(1);
		await panel.resume();
		expect(reads).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(FOLLOW_MS);
		expect(reads).toHaveLength(3);
	});

	it('stops on dispose', async () => {
		const { host, reads } = hostOf(process('bash-1'));
		const panel = browser(host);
		await panel.show();
		panel.dispose();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(3 * FOLLOW_MS);
		expect(reads).toHaveLength(1);
	});

	it('stops when the list reports that the chosen process ended', async () => {
		const { host, reads } = hostOf(process('bash-1'));
		const panel = browser(host);
		await panel.show();
		host.processTable = [process('bash-1', { state: 'exited', exitCode: 0 })];
		for (const changed of host.processWatchers) changed();
		await vi.waitFor(() => expect(panel.selected?.state).toBe('exited'));
		expect(vi.getTimerCount()).toBe(0);
		const count = reads.length;
		await vi.advanceTimersByTimeAsync(3 * FOLLOW_MS);
		expect(reads).toHaveLength(count);
	});

	it('follows the choice: it stops on an ended process and starts on a running one', async () => {
		const { host, reads } = hostOf(
			process('bash-1'),
			process('bash-2', { state: 'exited', exitCode: 0 }),
		);
		const panel = browser(host);
		await panel.show();
		expect(vi.getTimerCount()).toBe(1);
		panel.move(1);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(2 * FOLLOW_MS);
		expect(reads.filter((handle) => handle === 'bash-1')).toHaveLength(1);
		panel.move(-1);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(FOLLOW_MS);
		expect(reads.filter((handle) => handle === 'bash-1')).toHaveLength(3);
	});

	it('skips a tick while a read is in flight', async () => {
		const { host, reads, gate } = hostOf(process('bash-1'));
		const panel = browser(host);
		await panel.show();
		const release = hold(gate);
		await vi.advanceTimersByTimeAsync(FOLLOW_MS);
		expect(reads).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(3 * FOLLOW_MS);
		expect(reads).toHaveLength(2);
		release();
		await vi.advanceTimersByTimeAsync(FOLLOW_MS);
		expect(reads).toHaveLength(3);
	});

	it('drops a read that lands after a hide', async () => {
		const { host, gate } = hostOf(process('bash-1'));
		const panel = browser(host);
		await panel.show();
		const first = panel.output;
		const release = hold(gate);
		await vi.advanceTimersByTimeAsync(FOLLOW_MS);
		panel.hide();
		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(panel.output).toBe(first);
	});

	it('drops a read of the process that was chosen before a move', async () => {
		const { host } = hostOf(process('bash-1'), process('bash-2'));
		const panel = browser(host);
		await panel.show();
		let land = (_output: ProcessOutput) => {};
		host.processOutput = (handle: string) =>
			handle === 'bash-1'
				? new Promise<ProcessOutput>((resolve) => {
						land = resolve;
					})
				: Promise.resolve({ handle, text: 'second\n', size: 7, truncated: false });
		await vi.advanceTimersByTimeAsync(FOLLOW_MS);
		panel.move(1);
		await vi.advanceTimersByTimeAsync(0);
		expect(panel.output?.handle).toBe('bash-2');
		land({ handle: 'bash-1', text: 'late\n', size: 5, truncated: false });
		await vi.advanceTimersByTimeAsync(0);
		expect(panel.output?.handle).toBe('bash-2');
	});
});
