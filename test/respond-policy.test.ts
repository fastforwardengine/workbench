import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RESPOND_POLICY } from '@ambionframework/ambion';
import type { PiExecutionOptions } from '@ambionframework/pi';
import {
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	getCurrentSystemPrompt,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { people } from '../src/domain/definitions.ts';
import { RESPOND_POLICY } from '../src/domain/respond-policy.ts';
import { type Lab, openLab } from '../src/host/host.ts';

const person = people[0]?.name ?? '';

/** What the model of one seat reads in its first request: the system prompt and the context. */
interface Prompt {
	system: string;
	context: string;
}

/** The text of the user messages of a request, joined. */
function userText(messages: Context['messages']): string {
	return messages
		.flatMap((message) => {
			if (message.role !== 'user') return [];
			if (typeof message.content === 'string') return [message.content];
			return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
		})
		.join('\n');
}

/** A stream that records the first prompt of each seat. Each seat stays quiet. */
function recordingStream(prompts: Map<string, Prompt>): PiExecutionOptions['stream'] {
	return (_model, context) => {
		const system = getCurrentSystemPrompt(context.messages);
		const agent = system.match(/You are '([^']+)'/)?.[1] ?? 'unknown';
		if (!prompts.has(agent)) prompts.set(agent, { system, context: userText(context.messages) });
		const response = fauxAssistantMessage('quiet', { stopReason: 'stop' });
		const output = createAssistantMessageEventStream();
		queueMicrotask(() => {
			output.push({ type: 'start', partial: response });
			output.push({ type: 'done', reason: 'stop', message: response });
		});
		return output;
	};
}

const opened: { lab: Lab; directory: string }[] = [];

afterEach(async () => {
	for (const { lab, directory } of opened.splice(0)) {
		await lab.close().catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	}
});

/** Ask each specialist one question, and give the first prompt of each. */
async function promptsOfSpecialists(): Promise<Map<string, Prompt>> {
	const prompts = new Map<string, Prompt>();
	const directory = await mkdtemp(join(tmpdir(), 'workbench-policy-'));
	const lab = await openLab({ directory, stream: recordingStream(prompts) });
	opened.push({ lab, directory });
	await lab.join('build', person);
	await lab.send('build', person, 'ask-1', 'Which diode fits?', [], 'engineer');
	await lab.send('build', person, 'ask-2', '@researcher Which diode fits?', [], 'researcher');
	await vi.waitFor(() => expect([...prompts.keys()].sort()).toEqual(['engineer', 'researcher']), {
		timeout: 5_000,
	});
	return prompts;
}

describe('the respond policy of the specialists', () => {
	it('is shorter than the default policy', () => {
		expect(RESPOND_POLICY.length).toBeLessThan(DEFAULT_RESPOND_POLICY.length / 2);
	});

	it('replaces the default policy in the system prompt of each specialist', async () => {
		const prompts = await promptsOfSpecialists();
		for (const { system } of prompts.values()) {
			expect(system).toContain(RESPOND_POLICY);
			expect(system).not.toContain('restating it in your own words is repetition');
			expect(system).not.toContain(DEFAULT_RESPOND_POLICY);
			expect(system.indexOf(RESPOND_POLICY)).toBeLessThan(system.indexOf('Your instructions:'));
		}
	});

	it('keeps the kernel line for [new] in the ask line, and drops the advice of the default ask', async () => {
		const prompts = await promptsOfSpecialists();
		for (const { context } of prompts.values()) {
			expect(context).toContain(
				'this is a respond activation. A line marked [new] is a message that landed during your activation.',
			);
			expect(context).not.toContain('speak only to add something the record lacks');
		}
	});
});
