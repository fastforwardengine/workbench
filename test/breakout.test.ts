/** The breakout rooms: the Engineer opens one for its twin, the twin reports, and the Engineer archives it. */
import { createRuntime } from '@ambionframework/ambion';
import {
	byAgent,
	callTool,
	quiet,
	type Script,
	say,
	scripted,
	settled,
} from '@ambionframework/ambion/testing';
import { memoryCanvas, openCanvas } from '@ambionframework/canvas';
import { memoryJournals } from '@ambionframework/journal';
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { BREAKOUT_TEAM, people, team, twinOf } from '../src/domain/definitions.ts';
import { seats } from '../src/domain/room.ts';
import { labRepositories } from '../src/host/repositories.ts';
import { FRAME_KIND } from '../src/host/viewfinder.ts';

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

const person = people[0];
if (!person) throw new Error('No person.');

/** The canvas of the host on a memory store, with the team of Workbench and its twins. */
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
		breakout: { team: BREAKOUT_TEAM },
		widgets: { kinds: [FRAME_KIND] },
	});
	cleanups.push(() => canvas.close());
	const built = await team(workspace, undefined, {
		widgets: canvas.widgetTools(),
		opener: canvas.tools(),
		worker: canvas.workerTools(),
	});
	await canvas.resume({ agents: [...built.specialists, ...built.twins] });
	return { canvas, built };
}

const toolNames = (seat: { executor: { tools: readonly { name: string }[] } } | undefined) =>
	(seat?.executor.tools ?? []).map((tool) => tool.name);

const instructionsOf = (seat: { executor: unknown } | undefined): string =>
	(seat?.executor as { instructions?: string } | undefined)?.instructions ?? '';

const OPENER_TOOLS = ['breakout', 'tell', 'archive'];

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
	it('go to both specialists as the opener bundle, and to the twins as the report tool', async () => {
		const { built } = await setup();
		for (const specialist of built.specialists) {
			for (const name of OPENER_TOOLS) expect(toolNames(specialist)).toContain(name);
			expect(toolNames(specialist)).not.toContain('report');
		}
		expect(built.twins).toHaveLength(2);
		for (const twin of built.twins) {
			expect(toolNames(twin)).toContain('report');
			for (const name of OPENER_TOOLS) expect(toolNames(twin)).not.toContain(name);
		}
	});

	it('give the twins no widget tool, and keep the widgets with the Engineer', async () => {
		const { built } = await setup();
		for (const twin of built.twins)
			for (const name of ['show', 'hide']) expect(toolNames(twin)).not.toContain(name);
		expect(toolNames(seatNamed(built.specialists, 'engineer'))).toContain('show');
	});

	it('are absent when the host passes no bundle', async () => {
		const workspace = openWorkspace({
			name: 'workbench',
			backend: { bash: memoryBackend({ git: labRepositories(':memory:') }) },
		});
		cleanups.push(() => workspace.dispose());
		const built = await team(workspace);
		for (const seat of [...built.specialists, ...built.twins])
			for (const name of [...OPENER_TOOLS, 'report']) expect(toolNames(seat)).not.toContain(name);
	});
});

describe('the twins', () => {
	it('are named <specialist>-bg, in the breakout team and outside the specialists', async () => {
		const { built } = await setup();
		expect(twinOf('researcher')).toBe('researcher-bg');
		expect(twinOf('engineer')).toBe('engineer-bg');
		expect(BREAKOUT_TEAM).toEqual(['researcher-bg', 'engineer-bg']);
		expect(built.twins.map((seat) => seat.name)).toEqual([...BREAKOUT_TEAM]);
		expect(built.specialists.map((seat) => seat.name)).toEqual(SPECIALISTS);
	});

	it('receive the skills of their specialist, and no skill of the other', async () => {
		const { built } = await setup();
		const research = ['keep-notes', 'cite-a-limit', 'write-a-test-plan'];
		const bench = ['scan-the-bench', 'drive-the-power-supply', 'observe-the-camera'];
		const researcher = seatNamed(built.twins, 'researcher-bg')?.executor.guidance ?? '';
		const engineer = seatNamed(built.twins, 'engineer-bg')?.executor.guidance ?? '';
		for (const name of research) expect(researcher).toContain(`~/.skills/${name}/SKILL.md`);
		for (const name of bench) expect(researcher).not.toContain(`~/.skills/${name}/`);
		for (const name of ['keep-notes', ...bench]) expect(engineer).toContain(`~/.skills/${name}/`);
		for (const name of ['cite-a-limit', 'write-a-test-plan'])
			expect(engineer).not.toContain(`~/.skills/${name}/`);
	});

	it('are seated in no root room', async () => {
		const { canvas } = await setup();
		const room = await canvas.open({ name: 'bench-room', goal: 'Work.', seats, seating: false });
		cleanups.push(() => room.stop());
		const read = await room.read({ messages: false });
		const names = read.participants.map((seat) => seat.name);
		for (const twin of BREAKOUT_TEAM) expect(names).not.toContain(twin);
	});
});

describe('the prompts of the breakout rooms', () => {
	it('give the Background group to both specialists, before Speaking, and not to the twins', async () => {
		const { built } = await setup();
		for (const specialist of built.specialists) {
			const prompt = instructionsOf(specialist);
			expect(prompt).toContain('## Background\n- A breakout room runs one task');
			expect(prompt).toContain(
				'Seat the twin of the specialist whose work the task is: `researcher-bg` for research, `engineer-bg` for a script or for data.',
			);
			expect(prompt.indexOf('## Background')).toBeGreaterThan(prompt.indexOf('## Constraints'));
			expect(prompt.indexOf('## Background')).toBeLessThan(prompt.indexOf('## Speaking'));
			expect(prompt).not.toContain('worker');
		}
		for (const twin of built.twins) {
			const prompt = instructionsOf(twin);
			expect(prompt).not.toContain('## Background');
			expect(prompt).not.toContain('A breakout room runs one task');
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

	it('give each twin the identity, the Project, Evidence, and Constraints rules of its specialist, and the breakout rules', async () => {
		const { built } = await setup();
		for (const specialist of built.specialists) {
			const parent = instructionsOf(specialist);
			const twin = seatNamed(built.twins, twinOf(specialist.name));
			const prompt = instructionsOf(twin);
			expect(twin?.identity).toBe(
				`${specialist.identity} In a breakout room, does one task that a specialist hands over, and reports the result.`,
			);
			expect(prompt.split('\n\n').map((part) => part.split('\n')[0])).toEqual([
				expect.stringContaining('Workbench'),
				'## Project',
				'## Evidence',
				'## Constraints',
				'## Speaking',
			]);
			for (const group of ['Project', 'Evidence', 'Constraints'])
				for (const line of groupOf(parent, group)) expect(prompt).toContain(line);
			for (const rule of [
				'Cite the exact datasheet path when you state a specification.',
				'Your breakout room has no access to the devices of the bench.',
				'Send your result with `report`, once, at the end of the task.',
				'When the brief lacks an input that the task needs, report what is missing as your result.',
			])
				expect(prompt).toContain(rule);
			for (const rule of ['Say a result with no `to`.', 'Use `to` to ask a colleague for work.'])
				expect(prompt).not.toContain(rule);
			expect(prompt).not.toContain('`tell`');
		}
		const researcher = instructionsOf(seatNamed(built.twins, 'researcher-bg'));
		expect(researcher).toContain('Follow the cite-a-limit skill for a limit');
		expect(researcher).toContain('Never state a value without a datasheet path.');
		expect(researcher).not.toContain('Follow the scan-the-bench skill');
		const engineer = instructionsOf(seatNamed(built.twins, 'engineer-bg'));
		expect(engineer).toContain('Follow the scan-the-bench skill');
		expect(engineer).not.toContain('The Researcher hears only a directed say.');
	});
});

describe('the path of a task', () => {
	it('runs from the Engineer to its twin and back: breakout, report, archive', async () => {
		const room = 'bench-room-sweep';
		const script = byAgent({
			engineer: (_step, _seat, call) => {
				if (call === 1)
					return callTool('breakout', {
						name: 'sweep',
						goal: 'Write and test a script that sweeps the supply.',
						message: 'Write /scripts/sweep.py, and test it on the dry run. Answer with its path.',
						agents: ['engineer-bg'],
					});
				if (call === 2) return say('The script runs in the background.');
				if (call === 3) return callTool('archive', { room, result: 'done', note: 'Reported.' });
				if (call === 4) return say('The script passes its test.');
				return quiet();
			},
			'engineer-bg': (_step, _seat, call) => {
				if (call === 1)
					return callTool('report', {
						text: 'The script passes its test.',
						refs: ['file:///scripts/sweep.py'],
					});
				return quiet();
			},
		});
		const { canvas } = await setup(script);
		const parent = await canvas.open({
			name: 'bench-room',
			goal: 'Sweep the supply.',
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
				agents: ['engineer-bg'],
			},
		});
		expect(canvas.room(room)).toBeUndefined();
	});
});
