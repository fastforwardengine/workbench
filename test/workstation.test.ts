/**
 * The workspace on a real workstation, with scripted seats and no model.
 * The tier runs when `WORKBENCH_WORKSTATION` names a `workstation.json`, such
 * as the one that `workstation/setup.sh` writes for the local container:
 *
 *   WORKBENCH_WORKSTATION=.workstation/workstation.json pnpm test test/workstation.test.ts
 *
 * The repositories, the homes, and /shared persist on the workstation, so
 * each run names its files and its fork with a token of its own.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, startRoom } from '@ambionframework/ambion';
import {
	byAgent,
	callTool,
	quiet,
	type Script,
	scripted,
	settled,
	speak,
} from '@ambionframework/ambion/testing';
import { BACKGROUND_CONTEXT, openWorkspace } from '@ambionframework/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { people, team } from '../src/domain/definitions.ts';
import { openLab } from '../src/host/host.ts';
import { seedWorkspace } from '../src/host/seed.ts';
import { loadWorkstation, workstationBackends } from '../src/host/workstation.ts';

const CONFIG = process.env.WORKBENCH_WORKSTATION;
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

const person = (() => {
	const [first] = people;
	if (!first) throw new Error('Workbench has no person.');
	return first;
})();

const token = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The team over a workspace on the workstation, seeded as the host seeds it. */
async function build() {
	const workspace = openWorkspace({
		name: 'workbench',
		backend: await workstationBackends(await loadWorkstation(CONFIG ?? '')),
	});
	cleanups.push(() => workspace.dispose());
	await seedWorkspace(workspace);
	return team(workspace);
}

/** Run one room on a script until it goes quiet. */
async function runRoom(built: Awaited<ReturnType<typeof build>>, script: Script, text: string) {
	const room = await startRoom({
		name: `workstation-${token()}`,
		goal: text,
		agents: built.specialists,
		assistant: built.assistant,
		runtime: createRuntime(),
		execution: scripted(script),
		seats: { datasheets: 'named', experiments: 'named', instruments: 'named' },
	});
	cleanups.push(() => room.stop());
	await (await room.visit(person)).send({ text });
	await settled(room, { timeout: 60_000 });
	return room;
}

describe.skipIf(!CONFIG)('the workspace on a workstation', () => {
	it('opens the host on the workstation, seeds the library, and lists the shared folders', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'workbench-workstation-'));
		cleanups.push(() => rm(directory, { recursive: true, force: true }));
		const lab = await openLab({ directory, workstation: CONFIG, env: {} });
		cleanups.push(() => lab.close());
		expect((await lab.rooms()).map((room) => room.name)).toEqual(['led-sweep']);
		const paths = (await lab.files()).map((file) => file.path);
		expect(paths).toEqual(expect.arrayContaining(['/library/README.md', '/shared/kit.md']));
		// The panel lists the shared folders, and no home.
		expect(paths.some((path) => path.startsWith('/home/'))).toBe(false);
		expect((await lab.file('/shared/kit.md')).text).toContain('LED parameter sweep');
	}, 60_000);

	it('lets one seat write a file in /shared that another seat reads back', async () => {
		const built = await build();
		const path = `/shared/handoff-${token()}.md`;
		const marker = `LED limit ${token()}`;
		const script = byAgent({
			assistant: (_step, _seat, call) => (call === 1 ? speak('Write it.', 'datasheets') : quiet()),
			datasheets: (_step, _seat, call) => {
				if (call === 1) return callTool('write', { path, content: marker });
				if (call === 2) return speak('Written.', 'experiments');
				return quiet();
			},
			experiments: (step, _seat, call) => {
				if (call === 1) return callTool('read', { path });
				if (call === 2) return speak(`Read back: ${step.results.at(-1)?.text}`, 'assistant');
				return quiet();
			},
		});
		const room = await runRoom(built, script, 'Share a file.');
		const said = (await room.read()).messages.filter((message) => message.kind === 'said');
		expect(
			said.some((message) => message.from === 'experiments' && message.text.includes(marker)),
		).toBe(true);
		await built.workspace.use({ name: 'datasheets' }, async (env) => {
			await env.remove(path, { recursive: false }, BACKGROUND_CONTEXT);
		});
	}, 120_000);

	it('lets Experiments fork the test-plan template, and push a branch through the git account', async () => {
		const built = await build();
		const name = `plan-${token()}`;
		const script = byAgent({
			assistant: (_step, _seat, call) => (call === 1 ? speak('Plan it.', 'experiments') : quiet()),
			experiments: (step, _seat, call) => {
				if (call === 1)
					return callTool('fork', { source: 'templates/test-plan', name, clone: `~/${name}` });
				if (call === 2)
					return callTool('bash', {
						command: `cd ~/${name} && git switch -c led && sed -i 's/^# Test plan: TBD/# Test plan: LED sweep/' plan.md && git -c user.name=experiments -c user.email=experiments@workbench commit -qam 'Name the plan' && git push -q origin led && echo pushed`,
						wait: 60,
					});
				if (call === 3) return speak(`Pushed: ${step.results.at(-1)?.text}`, 'assistant');
				return quiet();
			},
		});
		const room = await runRoom(built, script, 'Plan a test.');
		const fork = await built.workspace.git?.use({ name: 'experiments' }, (env) =>
			env.get(`experiments/${name}`),
		);
		expect(fork?.source).toBe('templates/test-plan');
		expect(Object.keys(fork?.branches ?? {}).sort()).toEqual(['led', 'main']);
		expect(fork?.branches.led).not.toBe(fork?.branches.main);
		const said = (await room.read()).messages.flatMap((message) =>
			message.kind === 'said' && message.from === 'experiments' ? [message.text] : [],
		);
		expect(said.at(-1)).toContain('pushed');
	}, 120_000);

	it('runs a background process as its seat, and the host reads its output', async () => {
		const built = await build();
		const marker = `hello ${token()}`;
		// The process table persists on the workstation, so each run names its process.
		const name = `probe-${token()}`;
		const script = byAgent({
			assistant: (_step, _seat, call) => (call === 1 ? speak('Run it.', 'instruments') : quiet()),
			instruments: (_step, _seat, call) =>
				call === 1
					? callTool('bash', { command: `whoami; echo ${marker}`, name, wait: 30 })
					: quiet(),
		});
		await runRoom(built, script, 'Run a probe.');
		const [probe] = (await built.workspace.processes.list({ agent: 'instruments' })).filter(
			(process) => process.name === name,
		);
		expect(probe).toMatchObject({ agent: 'instruments', state: 'exited', exitCode: 0 });
		const output = await built.workspace.use({ name: 'instruments' }, async (env) => {
			const read = await env.readTextFile(probe?.output ?? '', BACKGROUND_CONTEXT);
			return read.ok ? read.value : '';
		});
		expect(output).toBe(`instruments\n${marker}\n`);
	}, 120_000);
});
