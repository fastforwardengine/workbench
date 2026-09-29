import type { ProcessStatus } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import { endedPost } from '../src/host/process-post.ts';

const process = (change: Partial<ProcessStatus>): ProcessStatus => ({
	handle: 'bash-3f9a2c1d0b7e',
	kind: 'bash',
	agent: 'instruments',
	command: 'python3 scan/scan.py',
	state: 'exited',
	output: '/home/instruments/.processes/bash-3f9a2c1d0b7e/out',
	timeout: 600,
	room: 'led-sweep',
	startedAt: '2026-09-29T20:00:00Z',
	exitCode: 0,
	...change,
});

describe('the post for a process that ended', () => {
	it('names the process, the outcome, the command, and the tool that reads the output', () => {
		expect(endedPost(process({ name: 'scan' }))).toEqual({
			to: 'instruments',
			text:
				'Background process scan (bash-3f9a2c1d0b7e) finished with exit code 0. ' +
				'Command: python3 scan/scan.py. Read its output with status bash-3f9a2c1d0b7e. ' +
				'Stay silent if you already read it.',
			key: 'process-ended:bash-3f9a2c1d0b7e',
		});
	});

	it('uses the handle for a process with no name, and gives one key for each process', () => {
		const post = endedPost(process({}));
		expect(post?.text).toMatch(/^Background process bash-3f9a2c1d0b7e finished/);
		expect(post?.key).toBe('process-ended:bash-3f9a2c1d0b7e');
	});

	it.each([
		[{ state: 'exited', exitCode: 2 }, 'finished with exit code 2'],
		[{ state: 'timed_out' }, 'stopped at its timeout of 600 s'],
		[
			{ state: 'failed', error: 'The host run ended before the process did.' },
			'failed: The host run ended before the process did.',
		],
	] as const)('states the outcome of %o', (change, words) => {
		expect(endedPost(process({ ...change }))?.text).toContain(words);
	});

	it('shows the first line of a long command, cut at 80 characters', () => {
		const post = endedPost(process({ command: `${'x'.repeat(200)}\nsecond line` }));
		expect(post?.text).toContain(`Command: ${'x'.repeat(79)}….`);
		expect(post?.text).not.toContain('second line');
	});

	it('gives no post for a cancel, a running process, or a process with no room', () => {
		expect(endedPost(process({ state: 'cancelled' }))).toBeUndefined();
		expect(endedPost(process({ state: 'running' }))).toBeUndefined();
		expect(endedPost(process({ room: undefined }))).toBeUndefined();
	});
});
