/** The breakout rooms: the Engineer opens one for the worker, the worker reports, and the Engineer archives it. */
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
import { people, team, WORKER, WORKER_TEAM } from '../src/domain/definitions.ts';
import { seats } from '../src/domain/room.ts';
import { labRepositories } from '../src/host/repositories.ts';
import { FRAME_KIND } from '../src/host/viewfinder.ts';

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

const person = people[0];
if (!person) throw new Error('No person.');

/** The canvas of the host on a memory store, with the team of Workbench and its worker. */
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
		breakout: { team: WORKER_TEAM },
		widgets: { kinds: [FRAME_KIND] },
	});
	cleanups.push(() => canvas.close());
	const built = await team(workspace, undefined, {
		widgets: canvas.widgetTools(),
		opener: canvas.tools(),
		worker: canvas.workerTools(),
	});
	await canvas.resume({ agents: [...built.specialists, built.worker] });
	return { canvas, built };
}

const toolNames = (seat: { executor: { tools: readonly { name: string }[] } } | undefined) =>
	(seat?.executor.tools ?? []).map((tool) => tool.name);

const instructionsOf = (seat: { executor: unknown } | undefined): string =>
	(seat?.executor as { instructions?: string } | undefined)?.instructions ?? '';

const OPENER_TOOLS = ['breakout', 'tell', 'archive'];

describe('the tools of the breakout rooms', () => {
	it('go to both specialists as the opener bundle, and to the worker as the report tool', async () => {
		const { built } = await setup();
		for (const specialist of built.specialists) {
			for (const name of OPENER_TOOLS) expect(toolNames(specialist)).toContain(name);
			expect(toolNames(specialist)).not.toContain('report');
		}
		expect(toolNames(built.worker)).toContain('report');
		for (const name of OPENER_TOOLS) expect(toolNames(built.worker)).not.toContain(name);
	});

	it('give the worker no widget tool, and keep the widgets with the Engineer', async () => {
		const { built } = await setup();
		for (const name of ['show', 'hide']) expect(toolNames(built.worker)).not.toContain(name);
		const engineer = built.specialists.find((seat) => seat.name === 'engineer');
		expect(toolNames(engineer)).toContain('show');
	});

	it('are absent when the host passes no bundle', async () => {
		const workspace = openWorkspace({
			name: 'workbench',
			backend: { bash: memoryBackend({ git: labRepositories(':memory:') }) },
		});
		cleanups.push(() => workspace.dispose());
		const built = await team(workspace);
		for (const seat of [...built.specialists, built.worker])
			for (const name of [...OPENER_TOOLS, 'report']) expect(toolNames(seat)).not.toContain(name);
	});
});

describe('the worker', () => {
	it('is one definition outside the specialists, named in the worker team', async () => {
		const { built } = await setup();
		expect(WORKER_TEAM).toEqual([WORKER]);
		expect(built.worker.name).toBe(WORKER);
		expect(built.specialists.map((seat) => seat.name)).not.toContain(WORKER);
	});

	it('receives the shared skills and the skills of the Researcher, and no skill of the Engineer', async () => {
		const { built } = await setup();
		const guidance = built.worker.executor.guidance ?? '';
		for (const name of ['keep-notes', 'cite-a-limit', 'write-a-test-plan'])
			expect(guidance).toContain(`~/.skills/${name}/SKILL.md`);
		for (const name of ['scan-the-bench', 'drive-the-power-supply', 'observe-the-camera'])
			expect(guidance).not.toContain(`~/.skills/${name}/`);
	});

	it('is seated in no root room', async () => {
		const { canvas } = await setup();
		const room = await canvas.open({ name: 'bench-room', goal: 'Work.', seats, seating: false });
		cleanups.push(() => room.stop());
		const read = await room.read({ messages: false });
		expect(read.participants.map((seat) => seat.name)).not.toContain(WORKER);
	});
});

describe('the prompts of the breakout rooms', () => {
	it('give the Background group to both specialists, before Speaking, and not to the worker', async () => {
		const { built } = await setup();
		for (const specialist of built.specialists) {
			const prompt = instructionsOf(specialist);
			expect(prompt).toContain('## Background\n- A breakout room runs one task');
			expect(prompt.indexOf('## Background')).toBeGreaterThan(prompt.indexOf('## Constraints'));
			expect(prompt.indexOf('## Background')).toBeLessThan(prompt.indexOf('## Speaking'));
		}
		const worker = instructionsOf(built.worker);
		expect(worker).not.toContain('## Background');
		expect(worker).not.toContain('A breakout room runs one task');
	});

	it('give the worker the shared rules, the research skills, and its own rules', async () => {
		const { built } = await setup();
		const worker = instructionsOf(built.worker);
		expect(worker.split('\n\n').map((part) => part.split('\n')[0])).toEqual([
			expect.stringContaining('Workbench'),
			'## Project',
			'## Evidence',
			'## Constraints',
			'## Speaking',
		]);
		for (const rule of [
			'Cite the exact datasheet path when you state a specification.',
			'Follow the cite-a-limit skill for a limit',
			'Your breakout room has no access to the devices of the bench.',
			'Send your result with `report`, once, at the end of the task.',
			'The specialist answers with `tell`.',
		])
			expect(worker).toContain(rule);
		expect(worker).not.toContain('Say a result with no `to`.');
	});
});

describe('the path of a task', () => {
	it('runs from the Engineer to the worker and back: breakout, report, archive', async () => {
		const room = 'bench-room-datasheets';
		const script = byAgent({
			engineer: (_step, _seat, call) => {
				if (call === 1)
					return callTool('breakout', {
						name: 'datasheets',
						goal: 'Compare the datasheets of two tuners in one table.',
						message: 'Compare /library/rda5807fp.md with another tuner. Answer with a table.',
						agents: [WORKER],
					});
				if (call === 2) return say('The comparison runs in the background.');
				if (call === 3) return callTool('archive', { room, result: 'done', note: 'Reported.' });
				if (call === 4) return say('The RDA5807FP wins.');
				return quiet();
			},
			worker: (_step, _seat, call) => {
				if (call === 1)
					return callTool('report', {
						text: 'The RDA5807FP wins.',
						refs: ['file:///library/rda5807fp.md'],
					});
				return quiet();
			},
		});
		const { canvas } = await setup(script);
		const parent = await canvas.open({
			name: 'bench-room',
			goal: 'Choose a tuner.',
			seats,
			seating: false,
		});
		cleanups.push(() => parent.stop());
		await (await parent.visit(person)).send({ text: 'Choose a tuner.', to: 'engineer' });
		await settled(parent);
		const child = canvas.room(room);
		if (child) await settled(child);
		await settled(parent);

		const reported = (await parent.read()).messages.find(
			(message) => 'text' in message && message.text.startsWith(`breakout ${room}:`),
		);
		expect(reported).toMatchObject({
			text: `breakout ${room}: The RDA5807FP wins.`,
			to: 'engineer',
			refs: ['file:///library/rda5807fp.md'],
		});
		expect(canvas.rooms().find((row) => row.name === room)).toMatchObject({
			state: 'archived',
			close: { result: 'done', note: 'Reported.' },
			start: { kind: 'breakout', parent: 'bench-room', opener: 'engineer', agents: [WORKER] },
		});
		expect(canvas.room(room)).toBeUndefined();
	});
});
