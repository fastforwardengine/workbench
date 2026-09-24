import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { openSqlResource } from '@ambionframework/workspace/sql';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { people, team } from '../src/domain/definitions.ts';
import { openInstrument } from '../src/domain/instrument.ts';
import { instruments, labSchema, labWritable } from '../src/domain/scenarios.ts';
import { labRepositories } from '../src/host/repositories.ts';

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

async function build() {
	const directory = await mkdtemp(join(tmpdir(), 'workbench-toolset-'));
	const workspace = openWorkspace({
		name: 'workbench',
		backend: {
			bash: memoryBackend(),
			sql: sqliteBackend(':memory:'),
			git: labRepositories(':memory:'),
		},
	});
	const lab = openSqlResource({
		name: 'lab',
		location: join(directory, 'lab.db'),
		schema: labSchema,
		writable: labWritable,
	});
	cleanups.push(
		() => workspace.dispose(),
		() => lab.dispose(),
		() => rm(directory, { recursive: true, force: true }),
	);
	return team(workspace, lab, openInstrument({ lab, instruments }));
}

/** The name and the schema of each tool an executor carries, in order. */
const shapeOf = (tools: readonly { name: string; parameters: unknown }[]) =>
	tools.map(({ name, parameters }) => ({ name, parameters: JSON.stringify(parameters) }));

describe('the Workbench tool set', () => {
	it('puts every seat on the Pi executor', async () => {
		const built = await build();
		expect(built.specialists.map((seat) => seat.executor.kind)).toEqual([
			'pi',
			'pi',
			'pi',
			'pi',
			'pi',
		]);
	});

	it('gives every full specialist the same tools, with the same schemas and guidance', async () => {
		const built = await build();
		const full = built.agents.filter(
			(agent) => agent.name !== 'instruments' && agent.name !== 'data-analysis',
		);
		const [first, ...rest] = full;
		const expected = shapeOf(first?.executor.tools ?? []);
		expect(expected.map((tool) => tool.name)).toEqual(
			expect.arrayContaining([
				'read',
				'write',
				'edit',
				'bash',
				'sql',
				'repos',
				'fork',
				'query',
				'record',
				'operate',
			]),
		);
		for (const agent of rest) expect(shapeOf(agent.executor.tools), agent.name).toEqual(expected);
		const [firstFull, ...otherFull] = full.filter((agent) => agent.name !== 'assistant');
		for (const agent of otherFull) {
			expect(agent.executor.guidance, agent.name).toEqual(firstFull?.executor.guidance);
		}
	});

	it('gives the instruments and data-analysis stubs only the workspace tools', async () => {
		const built = await build();
		for (const name of ['instruments', 'data-analysis']) {
			const agent = built.specialists.find((candidate) => candidate.name === name);
			const names = (agent?.executor.tools ?? []).map((tool) => tool.name);
			expect(names, name).toEqual(
				expect.arrayContaining(['read', 'write', 'edit', 'bash', 'repos', 'fork']),
			);
			expect(names, name).not.toContain('operate');
			expect(names, name).not.toContain('record');
		}
	});
});

describe('the Workbench filesystem', () => {
	it('lets one seat write a file that another seat reads back', async () => {
		const built = await build();
		const priya = people[0];
		if (!priya) throw new Error('No person.');
		const marker = 'load resistor 4.7 ohm';
		const script = byAgent({
			assistant: (_step, _seat, call) => (call === 1 ? speak('Please plan.', 'design') : quiet()),
			design: (_step, _seat, call) => {
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
			seats: { design: 'named', experiments: 'named' },
		});
		cleanups.push(() => room.stop());
		await (await room.visit(priya)).send({ text: 'Share a file.' });
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
		const built = await build();
		const priya = people[0];
		if (!priya) throw new Error('No person.');
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
		await (await room.visit(priya)).send({ text: 'Plan a test.' });
		await settled(room);
		const fork = await built.workspace.git?.use({ name: 'experiments' }, (env) =>
			env.get('experiments/plan'),
		);
		expect(fork?.source).toBe('templates/test-plan');
		expect(Object.keys(fork?.branches ?? {}).sort()).toEqual(['led', 'main']);
		expect(fork?.branches.led).not.toBe(fork?.branches.main);
	}, 20_000);
});
