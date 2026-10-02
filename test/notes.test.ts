import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directoryBackend, memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace, type Workspace } from '@ambionframework/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { sharedRegistrations } from '../src/domain/notes.ts';
import { labRepositories } from '../src/host/repositories.ts';
import { loadWorkstation, workstationBackends } from '../src/host/workstation.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function shell(workspace: Workspace, seat: string, command: string, code = 0) {
	return workspace.use({ name: seat }, async (env) => {
		let output = '';
		const result = await env.exec(command, {
			onUpdate: (view) => {
				output = view.text;
			},
		});
		if (!result.ok) throw result.error;
		expect(result.value.exitCode, output).toBe(code);
		return output;
	});
}

async function clone(workspace: Workspace, seat: string, path = '~/notes') {
	const repository = await workspace.git?.use({ name: seat }, (env) => env.get('shared/notes'));
	if (!repository) throw new Error('The notes are missing.');
	await shell(
		workspace,
		seat,
		`git clone ${repository.url} ${path} && cd ${path} && git config user.name ${seat} && git config user.email ${seat}@ambion.invalid`,
	);
}

async function collaboration(workspace: Workspace) {
	const path = `~/notes-test-${crypto.randomUUID()}`;
	await clone(workspace, 'datasheets', path);
	await clone(workspace, 'experiments', path);
	const file = `questions/test-${crypto.randomUUID()}.md`;
	await shell(
		workspace,
		'datasheets',
		`cd ${path} && echo 'first evidence' > ${file} && git add . && git commit -m 'questions: first evidence' && git push origin main`,
	);
	await shell(
		workspace,
		'experiments',
		`cd ${path} && echo 'independent evidence' > ${file}.other && git add . && git commit -m 'questions: independent evidence' && git push origin main`,
		1,
	);
	await shell(workspace, 'experiments', `cd ${path} && git pull --rebase && git push origin main`);
	await shell(workspace, 'experiments', `cd ${path} && git pull --rebase && cat ${file}`).then(
		(output) => expect(output).toContain('first evidence'),
	);
	await shell(
		workspace,
		'experiments',
		`cd ${path} && echo 'second evidence' >> ${file} && git commit -am 'questions: second evidence' && git push origin main`,
	);
	await shell(workspace, 'datasheets', `cd ${path} && git pull --rebase && cat ${file}`).then(
		(output) => expect(output).toContain('second evidence'),
	);
	const branch = `dispute/test-${crypto.randomUUID()}`;
	await shell(
		workspace,
		'datasheets',
		`cd ${path} && git switch -c ${branch} && echo 'disputed evidence' >> ${file} && git commit -am 'questions: dispute' && git push origin ${branch}`,
	);
	await shell(
		workspace,
		'experiments',
		`cd ${path} && git fetch && git switch -c ${branch} origin/${branch} && echo 'additional evidence' >> ${file} && git commit -am 'questions: add evidence' && git push origin ${branch}`,
	);
	await shell(workspace, 'experiments', `cd ${path} && git push origin --delete main`, 1);
	return file;
}

describe('the shared notes', () => {
	it('lets two specialists clone, push, and add evidence to a dispute', async () => {
		const workspace = openWorkspace({
			name: 'notes-test',
			backend: { bash: memoryBackend({ git: labRepositories(':memory:') }) },
		});
		cleanups.push(() => workspace.dispose());
		await collaboration(workspace);
	}, 20_000);

	it('keeps team edits after restart when the package seed changes', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'workbench-notes-'));
		cleanups.push(() => rm(directory, { recursive: true, force: true }));
		const notes = sharedRegistrations();
		const open = () =>
			openWorkspace({
				name: 'notes-test',
				backend: {
					bash: directoryBackend(join(directory, 'workspace'), {
						git: labRepositories(join(directory, 'git.db'), notes),
					}),
				},
			});
		const workspace = open();
		await clone(workspace, 'builder');
		await shell(
			workspace,
			'builder',
			"cd ~/notes && echo 'team decision' > decisions/test.md && git add . && git commit -m 'decisions: keep team state' && git push origin main",
		);
		const tip = await workspace.git?.use({ name: 'builder' }, (env) =>
			env.resolve('shared/notes', { branch: 'main' }),
		);
		await workspace.dispose();
		notes.notes.source['decisions/test.md'] = 'package replacement';
		const restarted = open();
		cleanups.push(() => restarted.dispose());
		expect(
			await restarted.git?.use({ name: 'builder' }, (env) =>
				env.resolve('shared/notes', { branch: 'main' }),
			),
		).toBe(tip);
		await clone(restarted, 'instruments');
		await shell(restarted, 'instruments', 'cd ~/notes && cat decisions/test.md').then((output) =>
			expect(output).toBe('team decision\n'),
		);
	}, 20_000);
});

const workstation = process.env.WORKBENCH_WORKSTATION;
it.skipIf(!workstation)(
	'shares the notes on a workstation',
	async () => {
		const workspace = openWorkspace({
			name: 'notes-test',
			backend: await workstationBackends(await loadWorkstation(workstation ?? '')),
		});
		cleanups.push(() => workspace.dispose());
		await collaboration(workspace);
	},
	60_000,
);
