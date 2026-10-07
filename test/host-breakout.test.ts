/** The host and the breakout rooms: the view of a breakout room, its watchers, and the messages of a person. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiExecutionOptions } from '@ambionframework/pi';
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { people } from '../src/domain/definitions.ts';
import { type Lab, openLab } from '../src/host/host.ts';

const person = people[0]?.name ?? '';

const ROOM = 'build-datasheets';

const call = (name: string, input: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage([fauxToolCall(name, input)], { stopReason: 'toolUse' });

const quiet = () => fauxAssistantMessage('quiet', { stopReason: 'stop' });

/** The Engineer opens a breakout room. The twin reports, and the Engineer archives the room. */
function fullPath(agent: string, count: number): AssistantMessage {
	if (agent === 'engineer' && count === 1)
		return call('breakout', {
			name: 'datasheets',
			goal: 'Write and test a sweep script.',
			message: 'Write a script that sweeps the supply, and test it.',
			agents: ['engineer-bg'],
		});
	if (agent === 'engineer' && count === 2)
		return call('say', { text: 'The script runs in the background.' });
	if (agent === 'engineer-bg' && count === 1)
		return call('report', { text: 'The script passes its test.' });
	// A request that follows a `say` ends the activation: the script answers it with `quiet`.
	if (agent === 'engineer' && count === 4)
		return call('archive', { room: ROOM, result: 'done', note: 'Reported.' });
	if (agent === 'engineer' && count === 5)
		return call('say', { text: 'The script passes its test.' });
	return quiet();
}

/** The Engineer opens a breakout room. The twin does nothing, so the room stays open. */
function openOnly(agent: string, count: number): AssistantMessage {
	if (agent === 'engineer' && count === 1)
		return call('breakout', {
			name: 'datasheets',
			goal: 'Write and test a sweep script.',
			message: 'Write a script that sweeps the supply, and test it.',
			agents: ['engineer-bg'],
		});
	if (agent === 'engineer' && count === 2)
		return call('say', { text: 'The script runs in the background.' });
	return quiet();
}

const streamOf = (respond: (agent: string, count: number) => AssistantMessage) => {
	const counts = new Map<string, number>();
	const stream: PiExecutionOptions['stream'] = (_model, context) => {
		const output = createAssistantMessageEventStream();
		const agent = getCurrentSystemPrompt(context.messages).match(/You are '([^']+)'/)?.[1] ?? '';
		const count = (counts.get(agent) ?? 0) + 1;
		counts.set(agent, count);
		const response = respond(agent, count);
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
	return stream;
};

const opened: { lab: Lab; directory: string }[] = [];

afterEach(async () => {
	for (const { lab, directory } of opened.splice(0)) {
		await lab.close().catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	}
});

async function open(respond: (agent: string, count: number) => AssistantMessage) {
	const directory = await mkdtemp(join(tmpdir(), 'workbench-breakout-'));
	const lab = await openLab({ directory, stream: streamOf(respond) });
	opened.push({ lab, directory });
	return lab;
}

/** Wait until the rooms of the lab satisfy a check. */
async function until(lab: Lab, check: (rooms: Awaited<ReturnType<Lab['rooms']>>) => boolean) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const rooms = await lab.rooms();
		if (check(rooms)) return rooms;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	return lab.rooms();
}

/** The person asks the Engineer in `build`. */
async function ask(lab: Lab) {
	await lab.join('build', person);
	await lab.send('build', person, 'ask-1', 'Write and test a sweep script.', [], 'engineer');
}

describe('a breakout room in the host', () => {
	it('shows its parent, its opener, and its close, and shows no breakout field for a root room', async () => {
		const lab = await open(fullPath);
		await ask(lab);
		const rooms = await until(lab, (all) =>
			all.some((room) => room.breakout?.state === 'archived'),
		);
		const build = rooms.find((room) => room.name === 'build');
		const child = rooms.find((room) => room.name === ROOM);
		expect(build?.breakout).toBeUndefined();
		expect(build && 'breakout' in build).toBe(false);
		expect(child?.breakout).toEqual({
			parent: 'build',
			opener: 'engineer',
			state: 'archived',
			close: { result: 'done', note: 'Reported.' },
		});
		expect(child?.goal).toBe('Write and test a sweep script.');
		const reported = (await lab.read('build', 0)).messages.find(
			(message) => 'text' in message && message.text.startsWith(`breakout ${ROOM}:`),
		);
		expect(reported).toMatchObject({
			to: 'engineer',
			text: `breakout ${ROOM}: The script passes its test.`,
		});
	});

	it('tells the watchers of the room list when a breakout room opens and when it ends', async () => {
		const lab = await open(fullPath);
		let heard = 0;
		const stop = lab.watchRooms(() => {
			heard += 1;
		});
		await ask(lab);
		await until(lab, (all) => all.some((room) => room.breakout?.state === 'archived'));
		stop();
		// The breakout room opens and archives, and its twin starts: three events at least.
		expect(heard).toBeGreaterThanOrEqual(3);
		const after = heard;
		await lab.control('build', 'stop');
		expect(heard).toBe(after);
	});

	it('refuses a message to a specialist that the breakout room does not seat, and takes one for the twin', async () => {
		const lab = await open(openOnly);
		await ask(lab);
		const rooms = await until(lab, (all) => all.some((room) => room.name === ROOM));
		expect(rooms.find((room) => room.name === ROOM)?.breakout).toMatchObject({
			state: 'running',
			opener: 'engineer',
		});
		await lab.join(ROOM, person);
		await expect(
			lab.send(ROOM, person, 'to-researcher', 'Help.', [], 'researcher'),
		).rejects.toThrow("'researcher' is not a seat of this breakout room.");
		const seated = (await lab.read(ROOM, 0)).participants.map((seat) => seat.name);
		expect(seated).not.toContain('researcher');
		await expect(
			lab.send(ROOM, person, 'to-twin', 'Add the TEA5767.', [], 'engineer-bg'),
		).resolves.toBe(undefined);
		await expect(lab.send(ROOM, person, 'to-nobody', 'Hello.', [], 'nobody')).rejects.toThrow(
			"'nobody' is not a seat of this breakout room.",
		);
	});

	it('stops and resumes a running breakout room, and refuses to resume an archived one', async () => {
		const lab = await open(fullPath);
		await ask(lab);
		await until(lab, (all) => all.some((room) => room.breakout?.state === 'archived'));
		await expect(lab.control(ROOM, 'resume')).rejects.toThrow(/archived/);
		await expect(lab.control(ROOM, 'abort')).rejects.toThrow('This breakout room is archived.');
		const view = (await lab.rooms()).find((room) => room.name === ROOM);
		expect(view?.status).toBe('stopped');
		expect(view?.breakout?.state).toBe('archived');
	});

	it('stops a running breakout room, and starts it again', async () => {
		const lab = await open(openOnly);
		await ask(lab);
		await until(lab, (all) => all.some((room) => room.name === ROOM));
		const stopped = await lab.control(ROOM, 'stop');
		expect(stopped.status).toBe('stopped');
		expect(stopped.breakout?.state).toBe('stopped');
		const resumed = await lab.control(ROOM, 'resume');
		expect(resumed.status).toBe('running');
		expect(resumed.breakout?.state).toBe('running');
	});
});
