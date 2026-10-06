/** The camera widget: the Engineer shows a `frame` widget on the canvas of the host. */
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

/** The tools that a canvas adds to a seat with the widget bundle. */
const WIDGET_TOOLS = ['show', 'hide'];

/** The canvas of the host on a memory store, with the team of Workbench on top of it. */
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
		breakout: { team: [] },
		widgets: { kinds: [FRAME_KIND] },
	});
	cleanups.push(() => canvas.close());
	const built = await team(workspace, undefined, canvas.widgetTools());
	await canvas.resume({ agents: built.specialists });
	return { canvas, built };
}

const toolNames = (seat: { executor: { tools: readonly { name: string }[] } } | undefined) =>
	(seat?.executor.tools ?? []).map((tool) => tool.name);

describe('the widget tools of the team', () => {
	it('go to the Engineer, which runs the camera, and to no other specialist', async () => {
		const { built } = await setup();
		const engineer = built.specialists.find((seat) => seat.name === 'engineer');
		const researcher = built.specialists.find((seat) => seat.name === 'researcher');
		for (const name of WIDGET_TOOLS) {
			expect(toolNames(engineer)).toContain(name);
			expect(toolNames(researcher)).not.toContain(name);
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
			for (const name of WIDGET_TOOLS) expect(toolNames(seat)).not.toContain(name);
	});
});

describe('the frame widget kind', () => {
	it('takes a process source and no actions', () => {
		expect(FRAME_KIND).toEqual({
			name: 'frame',
			description: 'The newest frame that a camera process serves.',
			sources: ['process'],
			actions: false,
		});
	});

	it('lets the Engineer show a camera, and hide it', async () => {
		const script = byAgent({
			engineer: (_step, _seat, call) => {
				if (call === 1)
					return callTool('show', {
						name: 'bench',
						kind: 'frame',
						source: { type: 'process', handle: 'bash-a', path: '/camera/observe' },
						title: 'Bench camera',
					});
				if (call === 2) return callTool('hide', { name: 'bench' });
				if (call === 3) return say('Shown and hidden.');
				return quiet();
			},
		});
		const { canvas } = await setup(script);
		const room = await canvas.open({
			name: 'bench-room',
			goal: 'Show the camera.',
			seats,
			seating: false,
		});
		cleanups.push(() => room.stop());
		await (await room.visit(person)).send({ text: 'Show the camera.', to: 'engineer' });
		await settled(room);
		expect(canvas.widgets('bench-room')).toEqual([
			expect.objectContaining({
				name: 'bench',
				kind: 'frame',
				state: 'hidden',
				author: 'engineer',
				title: 'Bench camera',
				source: { type: 'process', handle: 'bash-a', path: '/camera/observe' },
				actions: [],
			}),
		]);
	});

	it('refuses an action on a frame widget, because the kind takes none', async () => {
		const script = byAgent({
			engineer: (step, _seat, call) => {
				if (call === 1)
					return callTool('show', {
						name: 'bench',
						kind: 'frame',
						source: { type: 'process', handle: 'bash-a', path: '/camera/observe' },
						actions: [{ id: 'look', label: 'Look now' }],
					});
				if (call === 2) return say(`Result: ${step.results.at(-1)?.text}`);
				return quiet();
			},
		});
		const { canvas } = await setup(script);
		const room = await canvas.open({
			name: 'bench-room',
			goal: 'Show the camera.',
			seats,
			seating: false,
		});
		cleanups.push(() => room.stop());
		await (await room.visit(person)).send({ text: 'Show the camera.', to: 'engineer' });
		await settled(room);
		expect(canvas.widgets('bench-room')).toEqual([]);
	});
});
