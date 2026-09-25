/**
 * One tool set and one filesystem, on the real Pi family. Three claims:
 *
 * - Each full specialist lists the same tool names, and none of them is a
 *   native tool: Pi holds only the tools it receives.
 * - One specialist writes a file with the workspace tool, and the others
 *   read it back.
 * - A request to read `/etc/hosts` reaches no tool that reads a host file.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createRuntime,
	isSpoken,
	type Message,
	type Room,
	type RoomNotification,
	startRoom,
} from '@ambionframework/ambion';
import { settled } from '@ambionframework/ambion/testing';
import { memoryJournals } from '@ambionframework/journal';
import { memoryBackend } from '@ambionframework/just-bash';
import { piExecution } from '@ambionframework/pi';
import { openWorkspace } from '@ambionframework/workspace';
import { openSqlResource } from '@ambionframework/workspace/sql';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';
import { describe, expect, it } from 'vitest';
import { people, team } from '../../src/domain/definitions.ts';
import { hasKey } from '../../src/domain/families.ts';
import { openInstrument } from '../../src/domain/instrument.ts';
import { instruments, labSchema, labWritable } from '../../src/domain/scenarios.ts';
import { stepLog } from '../../src/view/steps.ts';

const QUIET_MS = 150_000;

/** The full specialists: every seat but the two stubs, plus the assistant. */
const specialists = ['assistant', 'datasheets', 'design', 'experiments'] as const;

/**
 * Native tool names a harness might add. Pi holds none of them by design. The
 * list omits the native `wait` of Codex: the workspace process tool has the
 * same name.
 */
const NATIVE = [
	'exec',
	'shell',
	'Bash',
	'Read',
	'Write',
	'Edit',
	'Glob',
	'Grep',
	'apply_patch',
	'web_search',
	'web.run',
	'view_image',
	'node_repl',
	'request_user_input',
];

/** The tools that read or run a host file, by any prefix. */
const HOST_READERS = [...NATIVE, 'exec_command', 'write_stdin', 'Task', 'WebFetch'];

const LIST =
	'List every tool you can call, one tool name per line, with no other text. ' +
	'Use the exact name as your tool list shows it. Send the list with one say.';

function asker() {
	const [person] = people;
	if (!person) throw new Error('Workbench has no person.');
	return person;
}

async function openRoom(seats: readonly string[]) {
	const directory = await mkdtemp(join(tmpdir(), 'workbench-toolset-live-'));
	const workspace = openWorkspace({
		name: 'workbench',
		backend: { bash: memoryBackend(), sql: sqliteBackend(':memory:') },
	});
	const lab = openSqlResource({
		name: 'lab',
		location: join(directory, 'lab.db'),
		schema: labSchema,
		writable: labWritable,
	});
	const built = team(workspace, lab, openInstrument({ lab, instruments }));
	const log = stepLog();
	const runtime = createRuntime({
		storage: memoryJournals(),
		execution: piExecution({}),
		logger: log.logger,
	});
	const name = `toolset-live-${process.pid}-${Date.now()}`;
	const room = await startRoom({
		name,
		goal: 'Report on the tools you hold.',
		agents: built.agents.filter((agent) => seats.includes(agent.name)),
		runtime,
		seats: Object.fromEntries(seats.map((seat) => [seat, 'named' as const])),
	});
	const events: RoomNotification[] = [];
	room.subscribe((event) => void events.push(event));
	const close = async () => {
		await room.stop().catch(() => undefined);
		await workspace.dispose().catch(() => undefined);
		await lab.dispose().catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	};
	return { room, name, log, events, close };
}

async function untilQuiet(room: Room): Promise<void> {
	try {
		await settled(room, { timeout: QUIET_MS });
	} catch (error) {
		await room.abort().catch(() => undefined);
		throw error;
	}
}

/** Ask one seat and wait for the room to go quiet. Returns what the seat said. */
async function ask(room: Room, seat: string, text: string): Promise<string> {
	const before = (await room.read()).messages.length;
	await (await room.visit(asker())).send({ to: seat, text });
	await untilQuiet(room);
	const messages: readonly Message[] = (await room.read()).messages.slice(before);
	return messages
		.filter(isSpoken)
		.filter((message) => message.from === seat)
		.map((message) => message.text)
		.join('\n');
}

/** The names of the tools that one seat called, from the trace of its activations. */
async function calledBy(
	opened: Awaited<ReturnType<typeof openRoom>>,
	seat: string,
): Promise<string[]> {
	const activations = opened.events.flatMap((event) =>
		event.type === 'activation_start' && event.agent === seat ? [event.activation] : [],
	);
	return activations
		.map((id) => opened.log.read(opened.name, id))
		.flatMap((read) => read?.passes.flatMap((pass) => [...pass.steps]) ?? [])
		.flatMap((step) => (step.type === 'tool_call' ? [step.name] : []));
}

const namesIn = (text: string): string[] =>
	[
		...new Set(
			text
				.split('\n')
				.map((line) => line.replace(/[`*\-\s]/g, ''))
				.filter((line) => line !== ''),
		),
	].sort();

describe.skipIf(!hasKey('pi'))('Workbench tool set on Pi', () => {
	it('lists the same tools for every full specialist, and no native tool', async () => {
		const opened = await openRoom(specialists);
		try {
			const lists = new Map<string, string[]>();
			for (const seat of specialists) lists.set(seat, namesIn(await ask(opened.room, seat, LIST)));
			const [first, ...rest] = specialists.map((seat) => lists.get(seat) ?? []);
			expect(first?.length).toBeGreaterThan(0);
			for (const list of rest) expect(list).toEqual(first);
			for (const list of lists.values())
				for (const name of NATIVE) expect(list).not.toContain(name);
		} finally {
			await opened.close();
		}
	});

	it('shares one filesystem: one specialist writes a file and the others read it back', async () => {
		const opened = await openRoom(specialists);
		try {
			const token = `workbench-${Date.now().toString(36)}`;
			const path = `/shared/live-${token}.md`;
			const [writer = '', ...readers] = specialists;
			await ask(
				opened.room,
				writer,
				`Write the text ${token} to the file ${path} with your write tool. Then say done.`,
			);
			for (const seat of readers) {
				const said = await ask(
					opened.room,
					seat,
					`Read the file ${path} with your read tool and say its exact content.`,
				);
				expect(said, seat).toContain(token);
			}
		} finally {
			await opened.close();
		}
	});

	it('reads no host file when asked for /etc/hosts', async () => {
		const opened = await openRoom(specialists);
		try {
			for (const seat of specialists) {
				await ask(
					opened.room,
					seat,
					'Read the file /etc/hosts and say its first line. If you cannot, say so.',
				);
				const called = await calledBy(opened, seat);
				for (const tool of HOST_READERS) expect(called, seat).not.toContain(tool);
			}
			const errors = opened.events.filter(
				(event) => event.type === 'error' || event.type === 'delivery_error',
			);
			expect(errors).toEqual([]);
		} finally {
			await opened.close();
		}
	});
});
