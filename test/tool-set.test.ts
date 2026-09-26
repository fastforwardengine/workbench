import { createRuntime, startRoom } from '@ambionframework/ambion';
import {
	byAgent,
	callTool,
	quiet,
	scripted,
	settled,
	speak,
} from '@ambionframework/ambion/testing';
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { people, team } from '../src/domain/definitions.ts';
import { labRepositories } from '../src/host/repositories.ts';

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

function build() {
	const workspace = openWorkspace({
		name: 'workbench',
		backend: { bash: memoryBackend(), git: labRepositories(':memory:') },
	});
	cleanups.push(() => workspace.dispose());
	return team(workspace);
}

/** The name and the schema of each tool an executor carries, in order. */
const shapeOf = (tools: readonly { name: string; parameters: unknown }[]) =>
	tools.map(({ name, parameters }) => ({ name, parameters: JSON.stringify(parameters) }));

/** The tools of the workspace: files, processes, and the git server. */
const WORKSPACE_TOOLS = [
	'read',
	'write',
	'edit',
	'bash',
	'ps',
	'status',
	'wait',
	'cancel',
	'repos',
	'fork',
];

describe('the Workbench tool set', () => {
	it('puts every seat on the Pi executor', () => {
		const built = build();
		expect(built.agents.map((seat) => [seat.name, seat.executor.kind])).toEqual([
			['assistant', 'pi'],
			['datasheets', 'pi'],
			['experiments', 'pi'],
			['instruments', 'pi'],
		]);
	});

	it('gives every specialist the workspace tools alone, with the same schemas and guidance', () => {
		const [first, ...rest] = build().specialists;
		const expected = shapeOf(first?.executor.tools ?? []);
		expect(expected.map((tool) => tool.name).sort()).toEqual([...WORKSPACE_TOOLS].sort());
		for (const agent of rest) {
			expect(shapeOf(agent.executor.tools), agent.name).toEqual(expected);
			expect(agent.executor.guidance, agent.name).toEqual(first?.executor.guidance);
		}
	});

	it('gives the assistant no tool of its own', () => {
		expect(build().assistant.executor.tools).toEqual([]);
	});
});

describe('the Workbench filesystem', () => {
	it('lets one seat write a file that another seat reads back', async () => {
		const built = build();
		const person = people[0];
		if (!person) throw new Error('No person.');
		const marker = 'LED limit 20 mA';
		const script = byAgent({
			assistant: (_step, _seat, call) =>
				call === 1 ? speak('Please state the limit.', 'datasheets') : quiet(),
			datasheets: (_step, _seat, call) => {
				if (call === 1) return callTool('write', { path: '/shared/handoff.md', content: marker });
				if (call === 2) return speak('Written.', 'experiments');
				return quiet();
			},
			experiments: (step, _seat, call) => {
				if (call === 1) return callTool('read', { path: '/shared/handoff.md' });
				if (call === 2) return speak(`Read back: ${step.results.at(-1)?.text}`, 'assistant');
				return quiet();
			},
		});
		const room = await startRoom({
			name: 'toolset',
			goal: 'Share a file.',
			agents: built.specialists,
			assistant: built.assistant,
			runtime: createRuntime(),
			execution: scripted(script),
			seats: { datasheets: 'named', experiments: 'named' },
		});
		cleanups.push(() => room.stop());
		await (await room.visit(person)).send({ text: 'Share a file.' });
		await settled(room);
		const read = await room.read();
		const said = read.messages.filter((message) => message.kind === 'said');
		expect(
			said.some((message) => message.from === 'experiments' && message.text.includes(marker)),
		).toBe(true);
	});
});

describe('the Workbench repositories', () => {
	it('lets the Experiments seat fork the test-plan template and push a branch', async () => {
		const built = build();
		const person = people[0];
		if (!person) throw new Error('No person.');
		const script = byAgent({
			assistant: (_step, _seat, call) => (call === 1 ? speak('Plan it.', 'experiments') : quiet()),
			experiments: (step, _seat, call) => {
				if (call === 1)
					return callTool('fork', { source: 'templates/test-plan', name: 'plan', clone: '~/plan' });
				if (call === 2)
					return callTool('bash', {
						command:
							"cd ~/plan && git switch -c led && sed -i 's/^# Test plan: TBD/# Test plan: LED sweep/' plan.md && git commit -am 'Name the plan' && git push origin led",
					});
				if (call === 3) return speak(`Pushed: ${step.results.at(-1)?.text}`, 'assistant');
				return quiet();
			},
		});
		const room = await startRoom({
			name: 'plan',
			goal: 'Plan a test.',
			agents: built.specialists,
			assistant: built.assistant,
			runtime: createRuntime(),
			execution: scripted(script),
			seats: { experiments: 'named' },
		});
		cleanups.push(() => room.stop());
		await (await room.visit(person)).send({ text: 'Plan a test.' });
		await settled(room);
		const fork = await built.workspace.git?.use({ name: 'experiments' }, (env) =>
			env.get('experiments/plan'),
		);
		expect(fork?.source).toBe('templates/test-plan');
		expect(Object.keys(fork?.branches ?? {}).sort()).toEqual(['led', 'main']);
		expect(fork?.branches.led).not.toBe(fork?.branches.main);
	}, 20_000);
});
