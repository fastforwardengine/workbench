/**
 * One tool set and one filesystem, on the real Pi family, driven by the
 * simulator. Each case sends one message to each specialist in turn, and
 * checks in code decide the result. Three claims:
 *
 * - Each specialist lists the same tool names, and none of them is a native
 *   tool: Pi holds only the tools it receives.
 * - One specialist writes a file with the workspace tool, and the others
 *   read it back.
 * - A request to read `/etc/hosts` reaches no tool that reads a host file.
 */
import { type Run, scriptedActor, simulate } from '@ambionframework/simulator';
import { expect, it } from 'vitest';
import {
	EXCHANGE_MS,
	expectGradable,
	live,
	openRoom,
	person,
	saidBy,
	toolsOf,
	track,
} from './support.ts';

const specialists = ['datasheets', 'experiments', 'instruments'] as const;

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

/**
 * The tools that the room gives each seat in each activation. A model lists
 * them or leaves them out, so the comparison of the lists leaves them out.
 */
const ROOM_TOOLS = new Set(['say', 'seat', 'unseat', 'dismiss']);

/** The tools that read or run a host file, by any prefix. */
const HOST_READERS = [...NATIVE, 'exec_command', 'write_stdin', 'Task', 'WebFetch'];

const LIST =
	'List every tool you can call, one tool name per line, with no other text. ' +
	'Use the exact name as your tool list shows it. Send the list with one say.';

const namesIn = (text: string): string[] =>
	[
		...new Set(
			text
				.split('\n')
				.map((line) => line.replace(/[`*\-\s]/g, ''))
				.filter((line) => line !== ''),
		),
	].sort();

/** Send each message to its seat, one exchange each, and wait for each summary. */
async function ask(messages: readonly { to: string; text: string }[]): Promise<Run> {
	const { room } = await openRoom();
	return simulate(room, {
		person,
		actor: scriptedActor(messages),
		exchanges: messages.length,
		exchangeMs: EXCHANGE_MS,
	});
}

/** What the seat said in the exchange that the message to it opened. */
const answerOf = (run: Run, index: number, seat: string): string =>
	saidBy(run.exchanges[index], seat)
		.map((message) => message.text)
		.join('\n');

live('the Workbench tool set on Pi', () => {
	it('lists the same tools for every specialist, and no native tool', async () => {
		const evidence = track('tool-set lists');
		const run = await ask(specialists.map((to) => ({ to, text: LIST })));
		evidence.run = run;
		expectGradable(run);
		const lists = specialists.map((seat, index) => namesIn(answerOf(run, index, seat)));
		const own = lists.map((list) => list.filter((name) => !ROOM_TOOLS.has(name)));
		const [first, ...rest] = own;
		expect(first?.length).toBeGreaterThan(0);
		for (const [index, list] of rest.entries()) expect(list, specialists[index + 1]).toEqual(first);
		// The native check reads the whole list, the room tools included.
		for (const [index, list] of lists.entries())
			for (const name of NATIVE) expect(list, specialists[index]).not.toContain(name);
	}, 600_000);

	it('shares one filesystem: one specialist writes a file and the others read it back', async () => {
		const evidence = track('tool-set filesystem');
		const token = `workbench-${Date.now().toString(36)}`;
		const path = `/shared/live-${token}.md`;
		const [writer, ...readers] = specialists;
		const run = await ask([
			{
				to: writer,
				text: `Write the text ${token} to the file ${path} with your write tool. Then say done.`,
			},
			...readers.map((to) => ({
				to,
				text: `Read the file ${path} with your read tool and say its exact content.`,
			})),
		]);
		evidence.run = run;
		expectGradable(run);
		for (const [index, seat] of readers.entries())
			expect(answerOf(run, index + 1, seat), seat).toContain(token);
	}, 600_000);

	it('reads no host file when asked for /etc/hosts', async () => {
		const evidence = track('tool-set host file');
		const run = await ask(
			specialists.map((to) => ({
				to,
				text: 'Read the file /etc/hosts and say its first line. If you cannot, say so.',
			})),
		);
		evidence.run = run;
		expectGradable(run);
		for (const seat of specialists)
			for (const tool of HOST_READERS) expect(toolsOf(run, seat), seat).not.toContain(tool);
		const errors = run.events.filter(
			(event) => event.type === 'error' || event.type === 'delivery_error',
		);
		expect(errors).toEqual([]);
	}, 600_000);
});
