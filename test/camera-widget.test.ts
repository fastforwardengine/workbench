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
import { frameActions } from '../src/host/actions.ts';
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

describe('the actions of a frame widget', () => {
	const base = {
		room: 'build',
		revision: 'r1',
		rev: 1,
		state: 'shown',
		kind: 'frame',
		author: 'engineer',
		actions: [{ id: 'look', label: 'Look now' }],
	} as const;

	it('keeps a shown frame widget with a single-press action, with its answer', () => {
		const answers = new Map([['r1', { seq: 3, by: 'priya' }]]);
		expect(frameActions([{ ...base, name: 'bench' }], answers)).toEqual([
			{
				room: 'build',
				name: 'bench',
				revision: 'r1',
				rev: 1,
				actions: [{ id: 'look', label: 'Look now' }],
				answered: { seq: 3, by: 'priya' },
			},
		]);
	});

	it('drops a hidden widget, another kind, an action with a form, and a widget with no action', () => {
		const form = {
			id: 'set',
			label: 'Set',
			fields: [{ name: 'n', label: 'N', type: 'text' }],
		} as const;
		expect(
			frameActions(
				[
					{ ...base, name: 'hidden', state: 'hidden' },
					{ ...base, name: 'table', kind: 'table' },
					{ ...base, name: 'form', actions: [form] },
					{ ...base, name: 'plain', actions: [] },
				],
				new Map(),
			),
		).toEqual([]);
	});
});

describe('the frame widget kind', () => {
	it('takes a process source and actions', () => {
		expect(FRAME_KIND).toEqual({
			name: 'frame',
			description: 'The newest frame that a camera process serves.',
			sources: ['process'],
			actions: true,
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

	it('accepts the look action in the show of the Engineer, and keeps it on the revision', async () => {
		const script = byAgent({
			engineer: (_step, _seat, call) => {
				if (call === 1)
					return callTool('show', {
						name: 'bench',
						kind: 'frame',
						source: { type: 'process', handle: 'bash-a', path: '/camera/observe' },
						title: 'Bench camera',
						actions: [{ id: 'look', label: 'Look now' }],
					});
				if (call === 2) return say('Shown.');
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
		const [shown] = canvas.widgets('bench-room');
		expect(shown).toMatchObject({ name: 'bench', state: 'shown' });
		expect(shown?.actions).toEqual([{ id: 'look', label: 'Look now' }]);
		expect(frameActions(canvas.widgets('bench-room'), new Map())).toEqual([
			expect.objectContaining({
				name: 'bench',
				room: 'bench-room',
				actions: [{ id: 'look', label: 'Look now' }],
			}),
		]);
	});

	it('sends the press of a person to the Engineer as a message that starts with the widget name', async () => {
		const texts: string[] = [];
		const script = byAgent({
			engineer: (step, _seat, call) => {
				if (call === 1)
					return callTool('show', {
						name: 'bench',
						kind: 'frame',
						source: { type: 'process', handle: 'bash-a', path: '/camera/observe' },
						title: 'Bench camera',
						actions: [{ id: 'look', label: 'Look now' }],
					});
				if (call === 2) return say('Shown.');
				// Every later request reads the room, so one of them holds the press.
				texts.push(JSON.stringify(step));
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
		const [shown] = canvas.widgets('bench-room');
		if (!shown) throw new Error('No widget.');
		const result = await canvas.act(person, {
			room: 'bench-room',
			widget: 'bench',
			revision: shown.revision,
			action: 'look',
			press: 'press-1',
		});
		expect(result.kind).toBe('sent');
		await settled(room);
		expect(texts.join('')).toContain('bench, rev 1');
		expect(texts.join('')).toContain('Look now [look]');
	});
});
