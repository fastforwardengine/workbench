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
	getCurrentSystemPrompt,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { people } from '../src/domain/definitions.ts';
import { type Lab, openLab } from '../src/host/host.ts';
import { openRooms } from '../src/host/rooms.ts';
import { NO_ENDPOINTS } from '../src/host/viewfinder.ts';
import { PNG } from './png.ts';

const opened: { lab: Lab; directory: string }[] = [];

/** The one person of Workbench: the account that runs the tests. */
const person = people[0]?.name ?? '';

const PLAN = 'LED sweep plan: 1 mA to 20 mA in 1 mA steps.\n';

/**
 * The Engineer, at broadcast, wakes on the message of the person and asks the
 * Researcher, at named, for a plan. The Researcher writes it and says so to the room.
 */
function scriptedResponse(agent: string, call: number) {
	if (agent === 'engineer' && call === 1)
		return fauxAssistantMessage(
			[fauxToolCall('say', { to: 'researcher', text: 'Please plan the sweep.' })],
			{ stopReason: 'toolUse' },
		);
	if (agent === 'researcher' && call === 1)
		return fauxAssistantMessage(
			[fauxToolCall('write', { path: 'shared/plan.md', content: PLAN })],
			{ stopReason: 'toolUse' },
		);
	if (agent === 'researcher' && call === 2)
		return fauxAssistantMessage([fauxToolCall('say', { text: 'Plan written.' })], {
			stopReason: 'toolUse',
		});
	return fauxAssistantMessage('quiet', { stopReason: 'stop' });
}

/** What a scripted stream answers: the seat and its request count from 1. */
type Respond = (agent: string, call: number) => AssistantMessage;

/**
 * A model stream that answers each request of each Pi seat from `respond`. A
 * request whose signal has aborted ends with an abort.
 */
const scriptedStream = (respond: Respond): PiExecutionOptions['stream'] => {
	const calls = new Map<string, number>();
	return (_model, context, options) => {
		const output = createAssistantMessageEventStream();
		const system = getCurrentSystemPrompt(context.messages);
		const agent = system.match(/You are '([^']+)'/)?.[1] ?? 'unknown';
		const call = (calls.get(agent) ?? 0) + 1;
		calls.set(agent, call);
		const response = respond(agent, call);
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

/** A model stream whose replies never end, so an exchange stays open. */
const idleStream = () => createAssistantMessageEventStream();

async function messagesOf(lab: Lab, room: string) {
	return (await lab.read(room, 0)).messages;
}

/**
 * The exchange runs several activations over real SQLite and directory I/O.
 * Alone it takes about 300 ms, and a loaded run of the whole suite takes several
 * times that. The wait allows 5 s and returns as soon as an exchange closes.
 */
async function untilClosed(lab: Lab, room: string) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const view = await lab.read(room, 0);
		if (view.exchanges.some((exchange) => exchange.status === 'closed')) return view.messages;
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
	it('lists the person and the build room, and resumes it without seeding again', async () => {
		const parent = await freshDirectory();
		const directory = joinPath(parent, 'run');
		const first = await open(directory);
		expect(first.people.map((person) => person.name)).toEqual(people.map((person) => person.name));
		expect((await first.rooms()).map((room) => [room.name, room.status])).toEqual([
			['build', 'running'],
		]);
		await first.create('second', 'A second room.');
		await first.close();
		const again = await open(directory);
		expect((await again.rooms()).map((room) => room.name)).toEqual(['build', 'second']);
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
		await lab.join('build', person);
		await lab.join('second', person);
		await lab.send('build', person, 'sweep-1', 'Which current range?');
		await lab.send('build', person, 'sweep-1', 'Which current range?');
		await lab.send('second', person, 'second-1', 'Which camera?');
		const sweep = await messagesOf(lab, 'build');
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
		await expect(lab.send('build', person, 'k0', 'Hello?')).rejects.toThrow(/Enter this room/);
		await lab.join('build', person);
		await lab.send('build', person, 'k1', 'Keep this delivery.');
		await lab.leave('build', person);
		await expect(lab.send('build', person, 'k1', 'Keep this delivery.')).rejects.toThrow(
			/Enter this room/,
		);
		await lab.join('build', person);
		await lab.send('build', person, 'k1', 'Keep this delivery.');
		const messages = await messagesOf(lab, 'build');
		expect(messages.filter((message) => 'key' in message && message.key === 'k1')).toHaveLength(1);
		expect(messages.filter((message) => message.kind === 'arrived')).toHaveLength(2);
	});

	it('does not record a departure for a person who never entered, and rejects an unknown person', async () => {
		const lab = await open(joinPath(await freshDirectory(), 'run'));
		const before = await messagesOf(lab, 'build');
		await lab.leave('build', person);
		expect(await messagesOf(lab, 'build')).toEqual(before);
		await expect(lab.join('build', 'nobody')).rejects.toThrow(/Unknown person/);
		await expect(lab.join('nowhere', person)).rejects.toThrow(/Unknown room/);
	});

	it('stops, keeps its history, and stays stopped across a restart until resumed', async () => {
		const parent = await freshDirectory();
		const directory = joinPath(parent, 'run');
		let lab = await open(directory);
		await lab.create('second', 'A second room.');
		await lab.join('build', person);
		await lab.send('build', person, 'stop-1', 'Persist this.');
		const before = await messagesOf(lab, 'build');
		const stopped = await lab.control('build', 'stop');
		expect(stopped.status).toBe('stopped');
		const history = await messagesOf(lab, 'build');
		expect(history).toEqual(expect.arrayContaining(before as unknown[]));
		expect(history.some((message) => message.kind === 'left')).toBe(true);
		await lab.close();
		lab = await open(directory);
		const restarted = await lab.rooms();
		expect(restarted.find((room) => room.name === 'build')?.status).toBe('stopped');
		expect(restarted.find((room) => room.name === 'second')?.status).toBe('running');
		const resumed = await lab.control('build', 'resume');
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
		expect((await lab.file('/shared/kit.md')).text).toContain('FM radio kit');
		expect((await lab.file('/plain.txt')).text).toBe('safe');
		await expect(lab.file('/escape.txt')).rejects.toThrow(/symbolic links/);
		await expect(lab.file('/../rooms.db')).rejects.toThrow(/absolute workspace file path/);
		await expect(lab.file('/missing.md')).rejects.toThrow(/File not found/);
	});

	it('shows each message of the specialists, records a specialist artifact, and keeps it after restart', async () => {
		const parent = await freshDirectory();
		const directory = joinPath(parent, 'run');
		let lab = await open(directory);
		await lab.join('build', person);
		await lab.send('build', person, 'plan-1', 'Plan the sweep.');
		const messages = await untilClosed(lab, 'build');
		const said = messages.flatMap((message) =>
			message.kind === 'said' ? [[message.from, message.to, message.text]] : [],
		);
		expect(said).toEqual([
			[person, undefined, 'Plan the sweep.'],
			['engineer', 'researcher', 'Please plan the sweep.'],
			['researcher', undefined, 'Plan written.'],
		]);
		expect(messages.some((message) => message.kind === 'summary')).toBe(false);
		const path = '/home/researcher/shared/plan.md';
		expect((await lab.file(path)).text).toBe(PLAN);
		await lab.close();
		lab = await open(directory);
		expect((await lab.file(path)).text).toBe(PLAN);
	}, 20_000);

	it('attaches a local picture, cites it in a message, and previews the file and the snapshot', async () => {
		const directory = await freshDirectory();
		const lab = await open(joinPath(directory, 'run'), idleStream);
		const local = joinPath(directory, 'bench.png');
		await writeFile(local, PNG);
		await lab.join('build', person);
		const attached = await lab.attach(local);
		expect(attached.path).toMatch(/^\/attachments\/\d+-bench\.png$/);
		await lab.send('build', person, 'attach-1', 'What is on the bench?', [attached.ref]);
		const sent = (await messagesOf(lab, 'build')).find(
			(message) => message.kind === 'said' && message.text === 'What is on the bench?',
		);
		expect(sent && 'refs' in sent && sent.refs).toEqual([attached.ref]);
		expect((await lab.files()).map((file) => file.path)).toContain(attached.path);
		for (const shown of [await lab.file(attached.path), await lab.snapshot(attached.ref)]) {
			expect(shown.image?.mimeType).toBe('image/png');
			expect(Buffer.from(shown.image?.data ?? [])).toEqual(PNG);
		}
	}, 20_000);

	it('keeps a message that cites a snapshot of another workspace, and refuses to read that snapshot', async () => {
		const lab = await open(joinPath(await freshDirectory(), 'run'), idleStream);
		await lab.join('build', person);
		const foreign = `ambion://workspace/elsewhere/snapshot/${'ab'.repeat(32)}/attachments/1-x.png`;
		// The room checks the form of a ref. The workspace checks whose it is, when it reads it.
		await lab.send('build', person, 'foreign-1', 'See this.', [foreign]);
		const cited = (await messagesOf(lab, 'build')).find(
			(message) => message.kind === 'said' && message.text === 'See this.',
		);
		expect(cited && 'refs' in cited && cited.refs).toEqual([foreign]);
		await expect(lab.snapshot(foreign)).rejects.toThrow();
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
		await lab.join('build', person);
		await lab.send('build', person, 'pending-1', 'Wait for work.');
		expect((await lab.read('build', 0)).exchange).toBeDefined();
		const aborted = await lab.control('build', 'abort');
		expect(aborted.exchange).toBeUndefined();
		expect(aborted.status).toBe('running');
		expect(aborted.exchanges).toContainEqual(
			expect.objectContaining({ status: 'closed', summary: { kind: 'silent' } }),
		);
	});
});

describe('Workbench host watch', () => {
	it('tells a watcher when the room records something, and stops after the watch ends', async () => {
		const lab = await open(joinPath(await freshDirectory(), 'run'));
		let changes = 0;
		let control = 0;
		const stop = lab.watch('build', () => {
			changes += 1;
		});
		lab.watch('build', () => {
			control += 1;
		});
		await lab.join('build', person);
		await vi.waitFor(() => expect(changes).toBeGreaterThan(0));
		stop();
		const seen = changes;
		const controlSeen = control;
		await lab.send('build', person, 'watch-1', 'Which current range?');
		await vi.waitFor(() => expect(control).toBeGreaterThan(controlSeen));
		expect(changes).toBe(seen);
	});

	it('watches one room and not another', async () => {
		const lab = await open(joinPath(await freshDirectory(), 'run'));
		await lab.create('second', 'A second room.');
		let sweep = 0;
		let second = 0;
		lab.watch('build', () => {
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
		lab.watch('build', () => {
			changes += 1;
		});
		await lab.control('build', 'stop');
		await lab.control('build', 'resume');
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		const settled = changes;
		await lab.join('build', person);
		await vi.waitFor(() => expect(changes).toBeGreaterThan(settled));
	}, 20_000);
});

describe('Workbench host steps, says, and processes', () => {
	it('reads the trace of an activation the room ran', async () => {
		const lab = await open(joinPath(await freshDirectory(), 'run'));
		await lab.join('build', person);
		await lab.send('build', person, 'trace-1', 'Plan the sweep.');
		await untilClosed(lab, 'build');
		const view = await lab.read('build', 0);
		const activations = view.exchanges.flatMap((exchange) => exchange.activations);
		expect(activations.length).toBeGreaterThan(0);
		const id = activations[0]?.id ?? '';
		const read = await lab.activation('build', id);
		expect(read?.activation).toBe(id);
		const passes = read?.passes ?? [];
		expect(passes.length).toBeGreaterThan(0);
		const steps = passes.flatMap((pass) => pass.steps);
		const types = steps.map((step) => step.type);
		expect(types).toContain('tool_call');
		expect(types.at(-1)).toBe('end');
		expect(await lab.activation('build', 'not-an-id')).toBeUndefined();
		await expect(lab.activation('nowhere', id)).rejects.toThrow(/Unknown room/);
	}, 20_000);

	it('lists a say that waits to return, and dismisses it once', async () => {
		const lab = await open(
			await freshDirectory(),
			scriptedStream((agent, call) => {
				if (agent !== 'engineer' || call !== 1)
					return fauxAssistantMessage('quiet', { stopReason: 'stop' });
				const later = { text: 'Check the LED temperature.', delaySeconds: 600 };
				return fauxAssistantMessage([fauxToolCall('schedule', later)], { stopReason: 'toolUse' });
			}),
		);
		await lab.join('build', person);
		await lab.send('build', person, 'later-1', 'Check the LED later.');
		const waiting = await vi.waitFor(async () => {
			const [say] = (await lab.read('build', 0)).scheduled;
			if (!say) throw new Error('No say waits yet.');
			return say;
		});
		expect(waiting).toMatchObject({ seat: 'engineer' });
		expect(await lab.dismiss('build', waiting.seq)).toBe(true);
		expect(await lab.dismiss('build', waiting.seq)).toBe(false);
		expect((await lab.read('build', 0)).scheduled).toEqual([]);
		expect((await messagesOf(lab, 'build')).at(-1)).toMatchObject({
			kind: 'dismissed',
			message: waiting.seq,
		});
	});

	it('lists the processes that a seat starts with bash, reads an output, and cancels a running one', async () => {
		// Engineer starts a short process that ends in its window, then a long one that it leaves running.
		const stream = scriptedStream((agent, call) => {
			const start = (command: string, name: string, wait: number) =>
				fauxAssistantMessage([fauxToolCall('bash', { command, name, wait })], {
					stopReason: 'toolUse',
				});
			if (agent !== 'engineer') return fauxAssistantMessage('quiet');
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
		await lab.join('build', person);
		await lab.send('build', person, 'ps-1', 'Start the soak.');
		await vi.waitFor(async () => expect(await lab.processes()).toHaveLength(2), {
			timeout: 5_000,
		});
		// The running process comes first, then the newest start.
		const [soak, greet] = await lab.processes();
		expect(soak).toMatchObject({ name: 'soak', agent: 'engineer', state: 'running' });
		expect(greet).toMatchObject({ name: 'greet', state: 'exited', exitCode: 0 });
		expect(await lab.processOutput(greet?.handle ?? '', 'engineer')).toEqual({
			handle: greet?.handle,
			text: 'hello from the bench\n',
			size: 21,
			truncated: false,
		});
		await expect(lab.processOutput('bash-000000000000', 'engineer')).rejects.toThrow(/No process/);

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

/** A stream that only records which seats got a request. Each seat stays quiet. */
function listeningStream(heard: Set<string>) {
	return scriptedStream((agent) => {
		heard.add(agent);
		return fauxAssistantMessage('quiet', { stopReason: 'stop' });
	});
}

const whenHeard = (heard: Set<string>, agent: string) =>
	vi.waitFor(() => expect(heard.has(agent)).toBe(true), { timeout: 5_000 });

describe('Workbench host, a message to one seat', () => {
	it('refuses a name that is not a specialist', async () => {
		const lab = await open(await freshDirectory(), listeningStream(new Set()));
		await lab.join('build', person);
		await expect(lab.send('build', person, 'to-2', '@nobody hi', [], 'nobody')).rejects.toThrow(
			"No seat or specialist named 'nobody'.",
		);
		expect((await lab.read('build', 0)).messages.some((m) => m.kind === 'said')).toBe(false);
	});

	it('seats the Researcher at named and the Engineer at broadcast in the build room', async () => {
		const lab = await open(await freshDirectory(), listeningStream(new Set()));
		const view = await lab.read('build', 0);
		expect(view.participants).toContainEqual(
			expect.objectContaining({ name: 'researcher', attention: 'named' }),
		);
		expect(view.participants).toContainEqual(
			expect.objectContaining({ name: 'engineer', attention: 'broadcast' }),
		);
	});

	it('seats a specialist that the room has not seated, at named, and wakes it', async () => {
		const directory = await freshDirectory();
		const database = new DatabaseSync(joinPath(directory, 'rooms.db'));
		const rooms = await openRooms(database, directory, {
			stream: listeningStream(new Set()),
		});
		await rooms.create('legacy', 'A room from before the Researcher seat.');
		await rooms.inRoom('legacy', async (room) => {
			await room.unseat('researcher');
		});
		await rooms.close();
		database.close();
		const heard = new Set<string>();
		const lab = await open(directory, listeningStream(heard));
		const before = await lab.read('legacy', 0);
		expect(before.participants.some((seat) => seat.name === 'researcher')).toBe(false);
		await lab.join('legacy', person);
		await lab.send('legacy', person, 'to-3', '@researcher check the diode.', [], 'researcher');
		await whenHeard(heard, 'researcher');
		const after = await lab.read('legacy', 0);
		expect(
			after.messages.find((m) => m.kind === 'said' && m.text.startsWith('@researcher')),
		).toMatchObject({
			to: 'researcher',
		});
		expect(after.participants).toContainEqual(
			expect.objectContaining({ name: 'researcher', kind: 'agent', attention: 'named' }),
		);
	});

	it('refuses a seat at none, and sends nothing', async () => {
		const directory = await freshDirectory();
		const database = new DatabaseSync(joinPath(directory, 'rooms.db'));
		const rooms = await openRooms(database, directory, { stream: listeningStream(new Set()) });
		await rooms.create('mute', 'A room with a seat that hears nothing.');
		await rooms.inRoom('mute', async (room) => {
			await room.unseat('researcher');
			await room.seat('researcher', { attention: 'none' });
		});
		await rooms.close();
		database.close();
		const lab = await open(directory, listeningStream(new Set()));
		await lab.join('mute', person);
		await expect(
			lab.send('mute', person, 'to-4', '@researcher hi', [], 'researcher'),
		).rejects.toThrow("'researcher' listens at none");
		expect((await lab.read('mute', 0)).messages.some((m) => m.kind === 'said')).toBe(false);
	});

	it('opens a viewfinder on a room, and a backend with no endpoints has no camera', async () => {
		const lab = await open(await freshDirectory(), listeningStream(new Set()));
		const changed = vi.fn();
		const finder = lab.viewfinder('build', changed);
		try {
			expect(finder.state).toEqual({ cameras: [], note: NO_ENDPOINTS });
		} finally {
			finder.close();
		}
		const missing = lab.viewfinder('no-such-room', changed);
		expect(missing.state.cameras).toEqual([]);
		missing.close();
	});

	it('lists the specialists as the seats to address', async () => {
		const lab = await open(await freshDirectory(), listeningStream(new Set()));
		expect(lab.team.map((seat) => seat.name)).toEqual(['researcher', 'engineer']);
	});
});
