/**
 * One tool set and one filesystem, on the real Pi executor, driven by the
 * simulator. Each case sends one message to each specialist in turn, and
 * checks in code decide the result. Three claims:
 *
 * - No specialist lists a native tool: Pi holds only the tools it receives.
 *   A model lists its tools with gaps, so the scripted tier checks the tool
 *   set of each seat.
 * - One specialist writes a file with the workspace tool, and the others
 *   read it back.
 * - A request to read `/etc/hosts` reaches no tool that reads a host file.
 */
import { type Simulation, scriptedActor, simulate } from '@ambionframework/simulator';
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

const specialists = ['researcher', 'engineer'] as const;

/**
 * Native tool names a harness might add. Pi holds none of them by design. The
 * list omits the native `wait` and `apply_patch` of Codex: the workspace tools
 * have the same names.
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

const namesIn = (text: string): string[] =>
	[
		...new Set(
			text
				.split('\n')
				.map((line) => line.replace(/[`*\-\s]/g, '').replace(/^functions\./, ''))
				.filter((line) => line !== ''),
		),
	].sort();

/** Send each message to its seat, and wait for each exchange to close. */
async function ask(messages: readonly { to: string; text: string }[]): Promise<Simulation> {
	const { room } = await openRoom();
	return simulate(room, {
		person,
		actor: scriptedActor(messages),
		messages: messages.length,
		exchangeMs: EXCHANGE_MS,
	});
}

/** What the seat said in the exchange that the message to it opened. */
const answerOf = (run: Simulation, index: number, seat: string): string =>
	saidBy(run.exchanges[index], seat)
		.map((message) => message.text)
		.join('\n');

live('the Workbench tool set on Pi', () => {
	it('lists no native tool for any specialist', async () => {
		const evidence = track('tool-set lists');
		const run = await ask(specialists.map((to) => ({ to, text: LIST })));
		evidence.run = run;
		expectGradable(run);
		const lists = specialists.map((seat, index) => namesIn(answerOf(run, index, seat)));
		for (const [index, list] of lists.entries()) {
			expect(list, specialists[index]).toContain('read');
			for (const name of NATIVE) expect(list, specialists[index]).not.toContain(name);
		}
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
			(event) => event.type === 'error' || event.type === 'port_error',
		);
		expect(errors).toEqual([]);
	}, 600_000);
});
