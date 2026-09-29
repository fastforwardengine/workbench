import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiExecutionOptions } from '@ambionframework/pi';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { people } from '../src/domain/definitions.ts';
import { openLab } from '../src/host/host.ts';

const person = people[0]?.name ?? '';
const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

/**
 * A stream in which Instruments starts one background command at its first
 * request and then stays quiet, as every other seat does. `contexts` keeps
 * the text of what Instruments read at each request.
 */
function stream(contexts: string[]): PiExecutionOptions['stream'] {
	let started = false;
	return (_model, context) => {
		const output = createAssistantMessageEventStream();
		const agent = /You are '([^']+)'/.exec(getCurrentSystemPrompt(context.messages))?.[1];
		if (agent === 'instruments') contexts.push(JSON.stringify(context.messages));
		const start = agent === 'instruments' && !started;
		started ||= start;
		const response = start
			? fauxAssistantMessage(
					[fauxToolCall('bash', { command: 'echo scanned', name: 'scan', wait: 0 })],
					{ stopReason: 'toolUse' },
				)
			: fauxAssistantMessage('quiet', { stopReason: 'stop' });
		queueMicrotask(() => {
			output.push({ type: 'start', partial: response });
			output.push({
				type: 'done',
				reason: response.stopReason as 'stop' | 'toolUse',
				message: response,
			});
		});
		return output;
	};
}

describe('the host post for a background process', () => {
	it('wakes the seat that started the process, once, when the process ends', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'workbench-process-end-'));
		directories.push(directory);
		const contexts: string[] = [];
		const lab = await openLab({ directory: join(directory, 'run'), stream: stream(contexts) });
		try {
			await lab.join('led-sweep', person);
			await lab.send('led-sweep', person, 'scan-1', 'Scan the bench.');
			const posted = await vi.waitFor(
				async () => {
					const found = (await lab.read('led-sweep', 0)).messages.filter(
						(message) => message.kind === 'posted',
					);
					if (found.length === 0) throw new Error('No post yet.');
					return found;
				},
				{ timeout: 5_000, interval: 20 },
			);
			expect(posted).toHaveLength(1);
			expect(posted[0]).toMatchObject({ to: 'instruments' });
			expect(posted[0]?.kind === 'posted' && posted[0].text).toMatch(
				/^Background process scan \(bash-[0-9a-f]{12}\) finished with exit code 0\./,
			);
			await vi.waitFor(() => expect(contexts.at(-1)).toContain('Background process scan'));
		} finally {
			await lab.close().catch(() => undefined);
		}
	}, 20_000);
});
