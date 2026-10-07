/** The breakout rooms: the Engineer opens one and seats itself, reports there, and archives the room. */
import { createRuntime } from '@ambionframework/ambion';
import {
	byAgent,
	callTool,
	quiet,
	type Reply,
	type Script,
	type ScriptStep,
	say,
	scripted,
	settled,
} from '@ambionframework/ambion/testing';
import { memoryCanvas, openCanvas } from '@ambionframework/canvas';
import { memoryJournals } from '@ambionframework/journal';
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { people, team } from '../src/domain/definitions.ts';
import { seats } from '../src/domain/room.ts';
import { labRepositories } from '../src/host/repositories.ts';
import { FRAME_KIND } from '../src/host/viewfinder.ts';

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

const person = people[0];
if (!person) throw new Error('No person.');

/** The canvas of the host on a memory store, with the team of Workbench. */
async function setup(script: Script = byAgent({})) {
	const workspace = openWorkspace({
		name: 'workbench',
		backend: { bash: memoryBackend({ git: labRepositories(':memory:') }) },
	});
	cleanups.push(() => workspace.dispose());
	const runtime = createRuntime({ storage: memoryJournals(), execution: scripted(script) });
	const canvas = openCanvas({
		name: 'workbench',
		runtime,
		store: memoryCanvas(),
		workspace,
		widgets: { kinds: [FRAME_KIND] },
	});
	cleanups.push(() => canvas.close());
	const built = await team(workspace, undefined, {
		widgets: canvas.widgetTools(),
		canvas: canvas.tools(),
	});
	await canvas.resume({ agents: built.specialists });
	return { canvas, built };
}

const toolNames = (seat: { executor: { tools: readonly { name: string }[] } } | undefined) =>
	(seat?.executor.tools ?? []).map((tool) => tool.name);

const instructionsOf = (seat: { executor: unknown } | undefined): string =>
	(seat?.executor as { instructions?: string } | undefined)?.instructions ?? '';

const CANVAS_TOOLS = ['breakout', 'tell', 'archive', 'report'];

/** The seat of a team with a name. */
const seatNamed = <T extends { name: string }>(seats: readonly T[], name: string): T | undefined =>
	seats.find((seat) => seat.name === name);

/** The rules of one group in a prompt: the lines under its header. */
const groupOf = (prompt: string, group: string): string[] =>
	(prompt.split('\n\n').find((part) => part.startsWith(`## ${group}\n`)) ?? '')
		.split('\n')
		.slice(1)
		.map((line) => line.replace(/^- /, ''));

/** The names of the specialists. */
const SPECIALISTS = ['researcher', 'engineer'];

describe('the tools of the breakout rooms', () => {
	it('go to both specialists as the one bundle of the canvas', async () => {
		const { built } = await setup();
		expect(built.specialists.map((seat) => seat.name)).toEqual(SPECIALISTS);
		for (const seat of built.specialists)
			for (const name of CANVAS_TOOLS) expect(toolNames(seat)).toContain(name);
	});

	it('keep the widget tools with the Engineer', async () => {
		const { built } = await setup();
		for (const name of ['show', 'hide']) {
			expect(toolNames(seatNamed(built.specialists, 'researcher'))).not.toContain(name);
			expect(toolNames(seatNamed(built.specialists, 'engineer'))).toContain(name);
		}
	});

	it('are absent when the host passes no bundle', async () => {
		const workspace = openWorkspace({
			name: 'workbench',
			backend: { bash: memoryBackend({ git: labRepositories(':memory:') }) },
		});
		cleanups.push(() => workspace.dispose());
		const built = await team(workspace);
		for (const seat of built.specialists)
			for (const name of CANVAS_TOOLS) expect(toolNames(seat)).not.toContain(name);
	});
});

describe('the seats of the rooms', () => {
	it('give the specialists the skills of their own folder, and no skill of the other', async () => {
		const { built } = await setup();
		const research = ['keep-notes', 'cite-a-limit', 'write-a-test-plan'];
		const bench = ['scan-the-bench', 'drive-the-power-supply', 'observe-the-camera'];
		const researcher = seatNamed(built.specialists, 'researcher')?.executor.guidance ?? '';
		const engineer = seatNamed(built.specialists, 'engineer')?.executor.guidance ?? '';
		for (const name of research) expect(researcher).toContain(`~/.skills/${name}/SKILL.md`);
		for (const name of bench) expect(researcher).not.toContain(`~/.skills/${name}/`);
		for (const name of ['keep-notes', ...bench]) expect(engineer).toContain(`~/.skills/${name}/`);
		for (const name of ['cite-a-limit', 'write-a-test-plan'])
			expect(engineer).not.toContain(`~/.skills/${name}/`);
	});

	it('seat the specialists in a root room', async () => {
		const { canvas } = await setup();
		const room = await canvas.open({
			name: 'bench-room',
			goal: 'Work.',
			agents: SPECIALISTS,
			seats,
			seating: false,
		});
		cleanups.push(() => room.stop());
		const read = await room.read({ messages: false });
		const names = read.participants
			.filter((seat) => seat.kind === 'agent')
			.map((seat) => seat.name);
		expect(names).toEqual(SPECIALISTS);
	});
});

describe('the prompts of the breakout rooms', () => {
	it('give the Background group to both specialists, between Constraints and Speaking', async () => {
		const { built } = await setup();
		for (const specialist of built.specialists) {
			const prompt = instructionsOf(specialist);
			expect(prompt).toContain('## Background\n- A breakout room runs one task');
			expect(prompt.indexOf('## Background')).toBeGreaterThan(prompt.indexOf('## Constraints'));
			expect(prompt.indexOf('## Background')).toBeLessThan(prompt.indexOf('## Speaking'));
			expect(prompt).not.toContain('worker');
		}
	});

	it('tell each specialist to seat itself in the breakout room, and name no other seat', async () => {
		const { built } = await setup();
		for (const specialist of built.specialists) {
			const prompt = instructionsOf(specialist);
			expect(prompt).toContain(
				`Seat yourself in it: the \`agents\` of \`breakout\` names ${specialist.name}.\n`,
			);
			const other = SPECIALISTS.find((name) => name !== specialist.name) ?? '';
			expect(groupOf(prompt, 'Background').join('\n')).not.toContain(other);
		}
	});

	it('give each specialist its own examples of a breakout task, and the shared line none', async () => {
		const { built } = await setup();
		const researcher = instructionsOf(seatNamed(built.specialists, 'researcher'));
		const engineer = instructionsOf(seatNamed(built.specialists, 'engineer'));
		const research = 'compare the datasheets of several parts, or draft a test plan.';
		const script = 'write and test a script, or read the data files of a capture.';
		expect(researcher).toContain(`Examples of a breakout task: ${research}`);
		expect(researcher).not.toContain(script);
		expect(engineer).toContain(`Examples of a breakout task: ${script}`);
		expect(engineer).not.toContain(research);
		for (const prompt of [researcher, engineer])
			expect(prompt).toContain(
				'- Open a breakout room for a self-contained task of many steps whose result this room does not need for its next step.\n',
			);
	});

	it('give both specialists the breakout rules for the device, the report, and a missing input', async () => {
		const { built } = await setup();
		for (const specialist of built.specialists) {
			const prompt = instructionsOf(specialist);
			expect(groupOf(prompt, 'Constraints')).toContain(
				'In a breakout room, no person is present and no device is yours to drive. A skill that drives a device runs there only on its simulator, when it has one. A run on a simulator needs no approval. Each command of such a skill carries its `--sim` option there, also a command that turns an output off. Cancel only a process that you started in the breakout room. Report a step that needs a device or the person to the opener.',
			);
			for (const rule of [
				'In a breakout room, send the result with `report`, once, at the end of the task. Cite in `refs` what the result relies on.',
				'In a breakout room, when the brief lacks an input that the task needs, report what is missing as the result.',
			])
				expect(groupOf(prompt, 'Speaking')).toContain(rule);
			expect(prompt).not.toContain('Do not ask the person for input');
		}
	});

	it('limit the rules for the person and the camera to the Engineer, and to the right room', async () => {
		const { built } = await setup();
		const researcher = instructionsOf(seatNamed(built.specialists, 'researcher'));
		const engineer = instructionsOf(seatNamed(built.specialists, 'engineer'));
		const constraints = groupOf(engineer, 'Constraints');
		expect(constraints).toEqual(
			expect.arrayContaining([
				'Change no setting and no output of a device outside a script from a template.',
				'In a root room, ask the person before the first run that turns on an output of a device.',
				'In a breakout room, do not call `show`. The viewfinder needs the camera of the bench.',
			]),
		);
		expect(researcher).not.toContain('turns on an output of a device');
		expect(researcher).not.toContain('`show`');
	});
});

describe('the path of a task', () => {
	it('runs from the Engineer to its own seat in a breakout room and back: breakout, report, archive', async () => {
		const room = 'bench-room-sweep';
		// The Engineer has two seats: one in the parent room, and one in the breakout room.
		// The script counts the steps of the parent room only.
		let parentSteps = 0;
		const inParent = (): Reply => {
			parentSteps += 1;
			switch (parentSteps) {
				case 1:
					return callTool('breakout', {
						name: 'sweep',
						goal: 'Write and test a script that sweeps the supply.',
						message: 'Write /scripts/sweep.py, and test it on the dry run. Answer with its path.',
						agents: ['engineer'],
					});
				case 2:
					return say('The script runs in the background.');
				case 4:
					return callTool('archive', { room, result: 'done', note: 'Reported.' });
				case 5:
					return say('The script passes its test.');
				default:
					return quiet();
			}
		};
		const inChild = (step: ScriptStep): Reply =>
			step.results.length === 0
				? callTool('report', {
						text: 'The script passes its test.',
						refs: ['file:///scripts/sweep.py'],
					})
				: quiet();
		const script = byAgent({
			engineer: (step) => (step.view.context.name === room ? inChild(step) : inParent()),
		});
		const { canvas } = await setup(script);
		const parent = await canvas.open({
			name: 'bench-room',
			goal: 'Sweep the supply.',
			agents: SPECIALISTS,
			seats,
			seating: false,
		});
		cleanups.push(() => parent.stop());
		await (await parent.visit(person)).send({ text: 'Sweep the supply.', to: 'engineer' });
		await settled(parent);
		const child = canvas.room(room);
		if (child) await settled(child);
		await settled(parent);

		const reported = (await parent.read()).messages.find(
			(message) => 'text' in message && message.text.startsWith(`breakout ${room}:`),
		);
		expect(reported).toMatchObject({
			text: `breakout ${room}: The script passes its test.`,
			to: 'engineer',
			refs: ['file:///scripts/sweep.py'],
		});
		expect(canvas.rooms().find((row) => row.name === room)).toMatchObject({
			state: 'archived',
			close: { result: 'done', note: 'Reported.' },
			start: {
				kind: 'breakout',
				parent: 'bench-room',
				opener: 'engineer',
				agents: ['engineer'],
			},
		});
		expect(canvas.room(room)).toBeUndefined();
	});
});
