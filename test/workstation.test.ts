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
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, startRoom } from '@ambionframework/ambion';
import {
	byAgent,
	callTool,
	quiet,
	type Script,
	say,
	scripted,
	settled,
} from '@ambionframework/ambion/testing';
import { openWorkspace } from '@ambionframework/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { people, team } from '../src/domain/definitions.ts';
import { attachFile } from '../src/host/files.ts';
import { openLab } from '../src/host/host.ts';
import { seedWorkspace } from '../src/host/seed.ts';
import { loadWorkstation, workstationBackends } from '../src/host/workstation.ts';
import { PNG } from './png.ts';

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
		seats: { researcher: 'named', engineer: 'named' },
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
		expect((await lab.rooms()).map((room) => room.name)).toEqual(['build']);
		const paths = (await lab.files()).map((file) => file.path);
		expect(paths).toEqual(expect.arrayContaining(['/library/README.md', '/shared/kit.md']));
		// The panel lists the shared folders, and no home.
		expect(paths.some((path) => path.startsWith('/home/'))).toBe(false);
		expect((await lab.file('/shared/kit.md')).text).toContain('FM radio kit');
	}, 60_000);

	it('lets one seat write a file in /shared that another seat reads back', async () => {
		const built = await build();
		const path = `/shared/handoff-${token()}.md`;
		const marker = `LED limit ${token()}`;
		const script = byAgent({
			assistant: (_step, _seat, call) => (call === 1 ? say('Write it.', 'researcher') : quiet()),
			researcher: (_step, _seat, call) => {
				if (call === 1) return callTool('write', { path, content: marker });
				if (call === 2) return say('Written.', 'engineer');
				return quiet();
			},
			engineer: (step, _seat, call) => {
				if (call === 1) return callTool('read', { path });
				if (call === 2) return say(`Read back: ${step.results.at(-1)?.text}`, 'assistant');
				return quiet();
			},
		});
		const room = await runRoom(built, script, 'Share a file.');
		const said = (await room.read()).messages.filter((message) => message.kind === 'said');
		expect(
			said.some((message) => message.from === 'engineer' && message.text.includes(marker)),
		).toBe(true);
		await built.workspace.use({ name: 'researcher' }, async (env) => {
			await env.remove(path, { recursive: false });
		});
	}, 120_000);

	it('lets a seat read a picture that the person attached, with the host as the only writer', async () => {
		const built = await build();
		const directory = await mkdtemp(join(tmpdir(), 'workbench-attach-'));
		cleanups.push(() => rm(directory, { recursive: true, force: true }));
		await writeFile(join(directory, `bench-${token()}.png`), PNG);
		const [name = ''] = await readdir(directory);
		const attached = await attachFile(built.workspace, join(directory, name));
		const script = byAgent({
			assistant: (_step, _seat, call) =>
				call === 1 ? say('Look at the picture.', 'engineer') : quiet(),
			engineer: (step, _seat, call) => {
				if (call === 1) return callTool('read', { path: attached.path });
				if (call === 2) return say(`Saw: ${step.results.at(-1)?.text}`, 'assistant');
				return quiet();
			},
		});
		const room = await runRoom(built, script, 'What is on the bench?');
		const said = (await room.read()).messages.filter((message) => message.kind === 'said');
		expect(
			said.some(
				(message) =>
					message.from === 'engineer' && message.text.includes('Read image file [image/png]'),
			),
		).toBe(true);
		expect(Buffer.from(await built.workspace.readSnapshot(attached.ref))).toEqual(PNG);
		// A seat cannot write there: the folder belongs to the host account.
		const write = await built.workspace.use({ name: 'engineer' }, (env) =>
			env.writeFile('/attachments/intruder.txt', 'x'),
		);
		expect(write.ok).toBe(false);
	}, 120_000);

	it('keeps the uid of each specialist, and gives each one the home with its uid', async () => {
		const built = await build();
		// The image assigns uids by position in workstation/accounts. Run `make reset` after an account moves.
		const uids: Record<string, number> = {
			researcher: 1000,
			engineer: 1001,
		};
		expect(built.specialists.map((seat) => seat.name).sort()).toEqual(Object.keys(uids).sort());
		for (const [seat, uid] of Object.entries(uids)) {
			const script = byAgent({
				assistant: (_step, _seat, call) => (call === 1 ? say('Report.', seat) : quiet()),
				[seat]: (step, _seat, call) => {
					if (call === 1)
						return callTool('bash', { command: 'echo "$(id -u) $(stat -c %u ~)"', wait: 30 });
					if (call === 2) return say(`ids ${step.results.at(-1)?.text}`, 'assistant');
					return quiet();
				},
			});
			const room = await runRoom(built, script, `Report your ids, ${seat}.`);
			const said = (await room.read()).messages.filter((message) => message.kind === 'said');
			const report = said.find((message) => message.from === seat)?.text ?? '';
			expect(report, seat).toContain(`ids ${uid} ${uid}`);
		}
	}, 240_000);

	it('copies the skills of a seat into its home, and runs a script of a skill as that seat', async () => {
		const built = await build();
		const script = byAgent({
			assistant: (_step, _seat, call) =>
				call === 1 ? say('Read your skill.', 'engineer') : quiet(),
			engineer: (step, _seat, call) => {
				if (call === 1) return callTool('read', { path: '~/.skills/scan-the-bench/SKILL.md' });
				if (call === 2)
					return callTool('bash', {
						command: 'ls -ld ~/.skills ~/.skills/.manifest; id -un',
						wait: 30,
					});
				if (call === 3)
					return say(
						`Skill: ${step.results.at(-2)?.text}\nShell: ${step.results.at(-1)?.text}`,
						'assistant',
					);
				return quiet();
			},
		});
		const room = await runRoom(built, script, 'Read a skill.');
		const said = (await room.read()).messages.filter((message) => message.kind === 'said');
		const report = said.find((message) => message.from === 'engineer')?.text ?? '';
		expect(report).toContain('device-scan');
		expect(report).toMatch(/\.skills/);
		expect(report).toContain('engineer');
	}, 120_000);

	it('lets the Researcher fork the test-plan template, and push a branch through the git account', async () => {
		const built = await build();
		const name = `plan-${token()}`;
		const script = byAgent({
			assistant: (_step, _seat, call) => (call === 1 ? say('Plan it.', 'researcher') : quiet()),
			researcher: (step, _seat, call) => {
				if (call === 1)
					return callTool('fork', { source: 'templates/test-plan', name, clone: `~/${name}` });
				if (call === 2)
					return callTool('bash', {
						command: `cd ~/${name} && git switch -c led && sed -i 's/^# Test plan: TBD/# Test plan: LED sweep/' plan.md && git -c user.name=researcher -c user.email=researcher@workbench commit -qam 'Name the plan' && git push -q origin led && echo pushed`,
						wait: 60,
					});
				if (call === 3) return say(`Pushed: ${step.results.at(-1)?.text}`, 'assistant');
				return quiet();
			},
		});
		const room = await runRoom(built, script, 'Plan a test.');
		const fork = await built.workspace.git?.use({ name: 'researcher' }, (env) =>
			env.get(`researcher/${name}`),
		);
		expect(fork?.source).toBe('templates/test-plan');
		expect(Object.keys(fork?.branches ?? {}).sort()).toEqual(['led', 'main']);
		expect(fork?.branches.led).not.toBe(fork?.branches.main);
		const said = (await room.read()).messages.flatMap((message) =>
			message.kind === 'said' && message.from === 'researcher' ? [message.text] : [],
		);
		expect(said.at(-1)).toContain('pushed');
	}, 120_000);

	it('runs a background process as its seat, and the host reads its output', async () => {
		const built = await build();
		const marker = `hello ${token()}`;
		// The process table persists on the workstation, so each run names its process.
		const name = `probe-${token()}`;
		const script = byAgent({
			assistant: (_step, _seat, call) => (call === 1 ? say('Run it.', 'engineer') : quiet()),
			engineer: (_step, _seat, call) =>
				call === 1
					? callTool('bash', { command: `whoami; echo ${marker}`, name, wait: 30 })
					: quiet(),
		});
		await runRoom(built, script, 'Run a probe.');
		const [probe] = (await built.workspace.processes.list({ agent: 'engineer' })).filter(
			(process) => process.name === name,
		);
		expect(probe).toMatchObject({ agent: 'engineer', state: 'exited', exitCode: 0 });
		const output = await built.workspace.use({ name: 'engineer' }, async (env) => {
			const read = await env.readTextFile(probe?.output ?? '');
			return read.ok ? read.value : '';
		});
		expect(output).toBe(`engineer\n${marker}\n`);
	}, 120_000);

	it('lets the Engineer fork the device-scan template, scan the workstation, and push the report', async () => {
		const built = await build();
		const name = `scan-${token()}`;
		const script = byAgent({
			assistant: (_step, _seat, call) => (call === 1 ? say('Scan.', 'engineer') : quiet()),
			engineer: (step, _seat, call) => {
				if (call === 1)
					return callTool('fork', { source: 'templates/device-scan', name, clone: `~/${name}` });
				if (call === 2)
					return callTool('bash', {
						command: `cd ~/${name} && git switch -qc scan && python3 scan/scan.py > /dev/null && git add scans && git -c user.name=engineer -c user.email=engineer@workbench commit -qm 'Scan the workstation' && git push -q origin scan && ls scans`,
						wait: 60,
					});
				if (call === 3) return say(`Scanned: ${step.results.at(-1)?.text}`, 'assistant');
				return quiet();
			},
		});
		const room = await runRoom(built, script, 'Scan the devices.');
		const fork = await built.workspace.git?.use({ name: 'engineer' }, (env) =>
			env.get(`engineer/${name}`),
		);
		expect(fork?.source).toBe('templates/device-scan');
		expect(Object.keys(fork?.branches ?? {}).sort()).toEqual(['main', 'scan']);
		const said = (await room.read()).messages.flatMap((message) =>
			message.kind === 'said' && message.from === 'engineer' ? [message.text] : [],
		);
		// The report pairs: one JSON file and one Markdown file.
		expect(said.at(-1)).toMatch(/\.json[\s\S]*\.md/);
	}, 120_000);
});
