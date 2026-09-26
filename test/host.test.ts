import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PiExecutionOptions } from '@ambionframework/pi';
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { people } from '../src/domain/definitions.ts';
import { type Lab, openLab } from '../src/host/host.ts';

const opened: { lab: Lab; directory: string }[] = [];

/** The one person of Workbench: the account that runs the tests. */
const person = people[0]?.name ?? '';

const PLAN = 'LED sweep plan: 1 mA to 20 mA in 1 mA steps.\n';

function scriptedResponse(agent: string, call: number, closing: boolean) {
	if (closing)
		return fauxAssistantMessage([fauxToolCall('say', { text: 'Summary: the lab answered.' })], {
			stopReason: 'toolUse',
		});
	if (agent === 'assistant' && call === 1)
		return fauxAssistantMessage(
			[fauxToolCall('say', { to: 'experiments', text: 'Please plan the sweep.' })],
			{ stopReason: 'toolUse' },
		);
	if (agent === 'assistant' && call === 2)
		return fauxAssistantMessage(
			[fauxToolCall('say', { to: 'experiments', text: 'Thanks, that is clear.' })],
			{ stopReason: 'toolUse' },
		);
	if (agent === 'experiments' && call === 1)
		return fauxAssistantMessage(
			[fauxToolCall('write', { path: 'shared/plan.md', content: PLAN })],
			{ stopReason: 'toolUse' },
		);
	if (agent === 'experiments' && call === 2)
		return fauxAssistantMessage([fauxToolCall('say', { to: 'assistant', text: 'Plan written.' })], {
			stopReason: 'toolUse',
		});
	return fauxAssistantMessage('quiet', { stopReason: 'stop' });
}

/** What a scripted stream answers: the seat, its request count from 1, and whether the exchange closes. */
type Respond = (agent: string, call: number, closing: boolean) => AssistantMessage;

/**
 * A model stream that answers each request of each Pi seat from `respond`. A
 * request whose signal has aborted ends with an abort.
 */
const scriptedStream = (respond: Respond): PiExecutionOptions['stream'] => {
	const calls = new Map<string, number>();
	return (_model, context, options) => {
		const output = createAssistantMessageEventStream();
		const closing = context.systemPrompt?.includes('The exchange is over.') ?? false;
		const agent = context.systemPrompt?.match(/You are '([^']+)'/)?.[1] ?? 'assistant';
		const call = (calls.get(agent) ?? 0) + 1;
		calls.set(agent, call);
		const response = respond(agent, call, closing);
		queueMicrotask(() => {
			if (options?.signal?.aborted) {
				output.push({
					type: 'error',
					reason: 'aborted',
					error: fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'aborted' }),
				});
				return;
			}
			output.push({ type: 'start', partial: response });
			output.push({
				type: 'done',
				reason: response.stopReason as 'stop' | 'toolUse',
				message: response,
			});
		});
		return output;
	};
};

async function open(directory: string, stream = scriptedStream(scriptedResponse)) {
	const lab = await openLab({ directory, stream });
	opened.push({ lab, directory });
	return lab;
}

const freshDirectory = () => mkdtemp(joinPath(tmpdir(), 'workbench-host-'));

async function messagesOf(lab: Lab, room: string) {
	return (await lab.read(room, 0)).messages;
}

async function untilSummary(lab: Lab, room: string) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const messages = await messagesOf(lab, room);
		if (messages.some((message) => message.kind === 'summary')) return messages;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	return messagesOf(lab, room);
}

afterEach(async () => {
	for (const { lab, directory } of opened.splice(0)) {
		await lab.close().catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	}
});

describe('Workbench host', () => {
	it('lists the person and the sample room, and resumes it without seeding again', async () => {
		const parent = await freshDirectory();
		const directory = joinPath(parent, 'run');
		const first = await open(directory);
		expect(first.people.map((person) => person.name)).toEqual(people.map((person) => person.name));
		expect((await first.rooms()).map((room) => [room.name, room.status])).toEqual([
			['led-sweep', 'running'],
		]);
		await first.create('second', 'A second room.');
		await first.close();
		const again = await open(directory);
		expect((await again.rooms()).map((room) => room.name)).toEqual(['led-sweep', 'second']);
	});

	it('creates a room, and refuses a duplicate and a bad name or goal', async () => {
		const lab = await open(joinPath(await freshDirectory(), 'run'));
		const created = await lab.create('formulation', '  Mix a coating for the cell tabs.  ');
		expect(created).toMatchObject({
			name: 'formulation',
			status: 'running',
			goal: 'Mix a coating for the cell tabs.',
		});
		await expect(lab.create('formulation', 'Again.')).rejects.toThrow(/already exists/);
		for (const [name, goal] of [
			['Bad Name', 'x'],
			['9lives', 'x'],
			['empty-goal', '   '],
			['long-goal', 'x'.repeat(2_001)],
		] as const)
			await expect(lab.create(name, goal)).rejects.toThrow(/room name|room goal/);
		expect((await lab.rooms()).map((room) => room.name)).toContain('formulation');
	});

	it('attributes deliveries, retries by key, and keeps rooms independent', async () => {
		const lab = await open(joinPath(await freshDirectory(), 'run'));
		await lab.create('second', 'A second room.');
		await lab.join('led-sweep', person);
		await lab.join('second', person);
		await lab.send('led-sweep', person, 'sweep-1', 'Which current range?');
		await lab.send('led-sweep', person, 'sweep-1', 'Which current range?');
		await lab.send('second', person, 'second-1', 'Which camera?');
		const sweep = await messagesOf(lab, 'led-sweep');
		const second = await messagesOf(lab, 'second');
		expect(sweep.filter((message) => 'key' in message && message.key === 'sweep-1')).toHaveLength(
			1,
		);
		expect(sweep).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ from: person, text: 'Which current range?' }),
			]),
		);
		expect(second).toEqual(
			expect.arrayContaining([expect.objectContaining({ from: person, text: 'Which camera?' })]),
		);
		expect(sweep.some((message) => 'text' in message && message.text === 'Which camera?')).toBe(
			false,
		);
	});

	it('requires a person to be present before sending, also after leaving', async () => {
		const lab = await open(joinPath(await freshDirectory(), 'run'));
		await expect(lab.send('led-sweep', person, 'k0', 'Hello?')).rejects.toThrow(/Enter this room/);
		await lab.join('led-sweep', person);
		await lab.send('led-sweep', person, 'k1', 'Keep this delivery.');
		await lab.leave('led-sweep', person);
		await expect(lab.send('led-sweep', person, 'k1', 'Keep this delivery.')).rejects.toThrow(
			/Enter this room/,
		);
		await lab.join('led-sweep', person);
		await lab.send('led-sweep', person, 'k1', 'Keep this delivery.');
		const messages = await messagesOf(lab, 'led-sweep');
		expect(messages.filter((message) => 'key' in message && message.key === 'k1')).toHaveLength(1);
		expect(messages.filter((message) => message.kind === 'arrived')).toHaveLength(2);
	});

	it('does not record a departure for a person who never entered, and rejects an unknown person', async () => {
		const lab = await open(joinPath(await freshDirectory(), 'run'));
		const before = await messagesOf(lab, 'led-sweep');
		await lab.leave('led-sweep', person);
		expect(await messagesOf(lab, 'led-sweep')).toEqual(before);
		await expect(lab.join('led-sweep', 'nobody')).rejects.toThrow(/Unknown person/);
		await expect(lab.join('nowhere', person)).rejects.toThrow(/Unknown room/);
	});

	it('stops, keeps its history, and stays stopped across a restart until resumed', async () => {
		const parent = await freshDirectory();
		const directory = joinPath(parent, 'run');
		let lab = await open(directory);
		await lab.create('second', 'A second room.');
		await lab.join('led-sweep', person);
		await lab.send('led-sweep', person, 'stop-1', 'Persist this.');
		const before = await messagesOf(lab, 'led-sweep');
		const stopped = await lab.control('led-sweep', 'stop');
		expect(stopped.status).toBe('stopped');
		const history = await messagesOf(lab, 'led-sweep');
		expect(history).toEqual(expect.arrayContaining(before as unknown[]));
		expect(history.some((message) => message.kind === 'left')).toBe(true);
		await lab.close();
		lab = await open(directory);
		const restarted = await lab.rooms();
		expect(restarted.find((room) => room.name === 'led-sweep')?.status).toBe('stopped');
		expect(restarted.find((room) => room.name === 'second')?.status).toBe('running');
		const resumed = await lab.control('led-sweep', 'resume');
		expect(resumed.status).toBe('running');
	}, 20_000);

	it('lists the seeded library, hides shell devices, and refuses unsafe file paths', async () => {
		const directory = joinPath(await freshDirectory(), 'run');
		const lab = await open(directory);
		const root = joinPath(directory, 'workspace');
		await writeFile(joinPath(root, 'plain.txt'), 'safe');
		await mkdir(joinPath(root, 'dev'), { recursive: true });
		await writeFile(joinPath(root, 'dev/null'), '');
		await symlink('/etc/hosts', joinPath(root, 'escape.txt'));
		const paths = (await lab.files()).map((file) => file.path);
		expect(paths).toEqual(
			expect.arrayContaining(['/plain.txt', '/library/README.md', '/shared/kit.md']),
		);
		expect(paths).not.toContain('/dev/null');
		expect((await lab.file('/shared/kit.md')).text).toContain('LED parameter sweep');
		expect((await lab.file('/plain.txt')).text).toBe('safe');
		await expect(lab.file('/escape.txt')).rejects.toThrow(/symbolic links/);
		await expect(lab.file('/../rooms.db')).rejects.toThrow(/absolute workspace file path/);
		await expect(lab.file('/missing.md')).rejects.toThrow(/File not found/);
	});

	it('publishes a summary, records a specialist artifact, and keeps it after restart', async () => {
		const parent = await freshDirectory();
		const directory = joinPath(parent, 'run');
		let lab = await open(directory);
		await lab.join('led-sweep', person);
		await lab.send('led-sweep', person, 'summary-1', 'Plan the sweep.');
		const messages = await untilSummary(lab, 'led-sweep');
		expect(messages.some((message) => message.kind === 'summary')).toBe(true);
		const path = '/home/experiments/shared/plan.md';
		expect((await lab.file(path)).text).toBe(PLAN);
		await lab.close();
		lab = await open(directory);
		expect((await lab.file(path)).text).toBe(PLAN);
	}, 20_000);

	it('previews a SQLite database as tables, and refuses a file that is not one', async () => {
		const directory = joinPath(await freshDirectory(), 'run');
		const lab = await open(directory);
		const root = joinPath(directory, 'workspace');
		const database = new DatabaseSync(joinPath(root, 'shared/data.db'));
		database.exec(
			'CREATE TABLE readings (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO readings (note) VALUES (\'near\'), (NULL); CREATE TABLE "odd name" (a);',
		);
		database.close();
		await writeFile(joinPath(root, 'shared/fake.db'), 'not a database');
		const preview = await lab.file('/shared/data.db');
		expect(preview.tables).toEqual([
			{ name: 'odd name', columns: ['a'], rows: [], count: 0 },
			{
				name: 'readings',
				columns: ['id', 'note'],
				rows: [
					['1', 'near'],
					['2', 'NULL'],
				],
				count: 2,
			},
		]);
		expect(preview.text).toContain('# readings (2 rows)');
		await expect(lab.file('/shared/fake.db')).rejects.toThrow(/not a SQLite database/);
	});

	it('aborts an open exchange and keeps the room available', async () => {
		const lab = await open(joinPath(await freshDirectory(), 'run'), () =>
			createAssistantMessageEventStream(),
		);
		await lab.join('led-sweep', person);
		await lab.send('led-sweep', person, 'pending-1', 'Wait for work.');
		expect((await lab.read('led-sweep', 0)).exchange).toBeDefined();
		const aborted = await lab.control('led-sweep', 'abort');
		expect(aborted.exchange).toBeUndefined();
		expect(aborted.status).toBe('running');
		expect(aborted.exchanges).toContainEqual(
			expect.objectContaining({ status: 'closed', summary: { status: 'silent' } }),
		);
	});
});

describe('Workbench host watch', () => {
	it('tells a watcher when the room records something, and stops after the watch ends', async () => {
		const lab = await open(joinPath(await freshDirectory(), 'run'));
		let changes = 0;
		let control = 0;
		const stop = lab.watch('led-sweep', () => {
			changes += 1;
		});
		lab.watch('led-sweep', () => {
			control += 1;
		});
		await lab.join('led-sweep', person);
		await vi.waitFor(() => expect(changes).toBeGreaterThan(0));
		stop();
		const seen = changes;
		const controlSeen = control;
		await lab.send('led-sweep', person, 'watch-1', 'Which current range?');
		await vi.waitFor(() => expect(control).toBeGreaterThan(controlSeen));
		expect(changes).toBe(seen);
	});

	it('watches one room and not another', async () => {
		const lab = await open(joinPath(await freshDirectory(), 'run'));
		await lab.create('second', 'A second room.');
		let sweep = 0;
		let second = 0;
		lab.watch('led-sweep', () => {
			sweep += 1;
		});
		lab.watch('second', () => {
			second += 1;
		});
		await lab.join('second', person);
		await vi.waitFor(() => expect(second).toBeGreaterThan(0));
		expect(sweep).toBe(0);
	});

	it('refuses to watch a room that does not exist', async () => {
		const lab = await open(joinPath(await freshDirectory(), 'run'));
		expect(() => lab.watch('nowhere', () => {})).toThrow(/Unknown room/);
	});

	it('keeps a watch across a stop and a resume', async () => {
		const lab = await open(joinPath(await freshDirectory(), 'run'));
		let changes = 0;
		lab.watch('led-sweep', () => {
			changes += 1;
		});
		await lab.control('led-sweep', 'stop');
		await lab.control('led-sweep', 'resume');
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		const settled = changes;
		await lab.join('led-sweep', person);
		await vi.waitFor(() => expect(changes).toBeGreaterThan(settled));
	}, 20_000);
});

describe('Workbench host steps, says, and processes', () => {
	it('reads the trace of an activation the room ran', async () => {
		const lab = await open(joinPath(await freshDirectory(), 'run'));
		await lab.join('led-sweep', person);
		await lab.send('led-sweep', person, 'trace-1', 'Plan the sweep.');
		await untilSummary(lab, 'led-sweep');
		const view = await lab.read('led-sweep', 0);
		const activations = view.exchanges.flatMap((exchange) => exchange.activations);
		expect(activations.length).toBeGreaterThan(0);
		const id = activations[0]?.id ?? '';
		const read = await lab.activation('led-sweep', id);
		expect(read?.activation).toBe(id);
		const passes = read?.passes ?? [];
		expect(passes.length).toBeGreaterThan(0);
		const steps = passes.flatMap((pass) => pass.steps);
		const types = steps.map((step) => step.type);
		expect(types).toContain('tool_call');
		expect(types.at(-1)).toBe('end');
		expect(await lab.activation('led-sweep', 'not-an-id')).toBeUndefined();
		await expect(lab.activation('nowhere', id)).rejects.toThrow(/Unknown room/);
	}, 20_000);

	it('lists a say that waits to return, and dismisses it once', async () => {
		const lab = await open(
			await freshDirectory(),
			scriptedStream((agent, call, closing) => {
				if (closing || agent !== 'assistant' || call !== 1)
					return fauxAssistantMessage('quiet', { stopReason: 'stop' });
				const later = { to: 'assistant', text: 'Check the LED temperature.', after: 600 };
				return fauxAssistantMessage([fauxToolCall('say', later)], { stopReason: 'toolUse' });
			}),
		);
		await lab.join('led-sweep', person);
		await lab.send('led-sweep', person, 'later-1', 'Check the LED later.');
		const waiting = await vi.waitFor(async () => {
			const [say] = (await lab.read('led-sweep', 0)).scheduled;
			if (!say) throw new Error('No say waits yet.');
			return say;
		});
		expect(waiting).toMatchObject({ seat: 'assistant', owner: person });
		expect(await lab.dismiss('led-sweep', waiting.seq)).toBe(true);
		expect(await lab.dismiss('led-sweep', waiting.seq)).toBe(false);
		expect((await lab.read('led-sweep', 0)).scheduled).toEqual([]);
		expect((await messagesOf(lab, 'led-sweep')).at(-1)).toMatchObject({
			kind: 'dismissed',
			message: waiting.seq,
		});
	});

	it('lists the processes that an agent starts with bash, reads an output, and cancels a running one', async () => {
		// Instruments starts a short process that ends in its window, then a long one that it leaves running.
		const stream = scriptedStream((agent, call, closing) => {
			const start = (command: string, name: string, wait: number) =>
				fauxAssistantMessage([fauxToolCall('bash', { command, name, wait })], {
					stopReason: 'toolUse',
				});
			if (agent !== 'instruments' || closing) return fauxAssistantMessage('quiet');
			if (call === 1) return start('echo hello from the bench', 'greet', 5);
			if (call === 2) return start('sleep 60', 'soak', 0);
			return fauxAssistantMessage('quiet');
		});
		const lab = await open(await freshDirectory(), stream);
		let events = 0;
		const end = lab.watchProcesses(() => {
			events += 1;
		});
		expect(await lab.processes()).toEqual([]);
		await lab.join('led-sweep', person);
		await lab.send('led-sweep', person, 'ps-1', 'Start the soak.');
		await vi.waitFor(async () => expect(await lab.processes()).toHaveLength(2), {
			timeout: 5_000,
		});
		// The running process comes first, then the newest start.
		const [soak, greet] = await lab.processes();
		expect(soak).toMatchObject({ name: 'soak', agent: 'instruments', state: 'running' });
		expect(greet).toMatchObject({ name: 'greet', state: 'exited', exitCode: 0 });
		expect(await lab.processOutput(greet?.handle ?? '', 'instruments')).toEqual({
			handle: greet?.handle,
			text: 'hello from the bench\n',
			size: 21,
			truncated: false,
		});
		await expect(lab.processOutput('bash-000000000000', 'instruments')).rejects.toThrow(
			/No process/,
		);

		const cancelled = await lab.cancelProcess(soak?.handle ?? '');
		expect(cancelled.state).toBe('cancelled');
		expect((await lab.processes()).map((process) => process.state)).toEqual([
			'cancelled',
			'exited',
		]);
		// One start and one end for each process.
		await vi.waitFor(() => expect(events).toBe(4));
		end();
	}, 20_000);
});
