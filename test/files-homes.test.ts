/**
 * The files of the seats. Each home has mode 0700 on a workstation, so only its seat
 * reads it. The backend here keeps the host account out of the homes, as the
 * workstation does, and records who connects.
 */
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directoryBackend } from '@ambionframework/just-bash';
import {
	type BashBackend,
	err,
	FileError,
	openWorkspace,
	type Workspace,
	type WorkspaceEnv,
} from '@ambionframework/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { listFiles, readFile } from '../src/host/files.ts';
import { labRepositories } from '../src/host/repositories.ts';
import { WORKSPACE } from '../src/view/refs.ts';

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

const SEATS = ['researcher', 'engineer', 'engineer-two'];
const READS = ['listDir', 'fileInfo', 'readTextFile', 'readBinaryFile', 'exists'];

/** The host account may not look into the home of a seat. */
function wall(env: WorkspaceEnv): WorkspaceEnv {
	const denied = (path: string) => /^\/home\/[^/]+(\/|$)/.test(path);
	return new Proxy(env, {
		get(target, name) {
			const member = Reflect.get(target, name);
			if (typeof member !== 'function') return member;
			if (typeof name === 'string' && READS.includes(name))
				return async (path: string, ...rest: unknown[]) =>
					denied(path)
						? err(new FileError('permission_denied', 'Permission denied', path))
						: member.call(target, path, ...rest);
			return member.bind(target);
		},
	});
}

/** A local directory workspace whose host account meets the wall. `used` names the accounts that connected. */
async function open() {
	const directory = await mkdtemp(join(tmpdir(), 'workbench-homes-'));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const inner = directoryBackend(join(directory, 'workspace'), {
		git: labRepositories(':memory:'),
	});
	const used: string[] = [];
	const names = { host: '' };
	const bash: BashBackend = {
		layout: inner.layout,
		git: inner.git,
		guidance: inner.guidance,
		endpoints: inner.endpoints,
		dispose: () => inner.dispose?.() ?? Promise.resolve(),
		connect: async (agent, signal) => {
			used.push(agent.name);
			if (agent.name === 'ghost') throw new Error('The workstation has no account named ghost.');
			const env = await inner.connect(agent, signal);
			return agent.name === names.host ? wall(env) : env;
		},
	};
	const workspace = openWorkspace({ name: WORKSPACE, backend: { bash } });
	names.host = workspace.mirrorAgent.name;
	cleanups.push(() => workspace.dispose());
	return { workspace, used, host: names.host, directory };
}

/** Write files as the seat that owns them. */
async function write(workspace: Workspace, seat: string, files: Record<string, string>) {
	await workspace.use({ name: seat }, async (env) => {
		for (const [path, text] of Object.entries(files)) await env.writeFile(path, text);
	});
}

async function homes(workspace: Workspace) {
	await write(workspace, 'engineer', {
		'/home/engineer/sweep.py': 'print(1)\n',
		'/home/engineer/fm-radio/firmware/main.c': 'int main(void){}\n',
		'/home/engineer/fm-radio/.git/config': '[core]\n',
		'/home/engineer/.cache/pip/x': 'x',
		'/home/engineer/.bashrc': '# rc\n',
	});
	await write(workspace, 'researcher', { '/home/researcher/notes/plan.md': '# Plan\n' });
	await write(workspace, 'engineer-two', { '/home/engineer-two/ldo-compare.md': '# LDO\n' });
	await write(workspace, 'researcher', { '/shared/kit.md': 'kit\n', '/plain.txt': 'plain\n' });
}

describe('the homes in the list of files', () => {
	it('lists each home as its seat, in a group of its own, and skips hidden files and folders', async () => {
		const { workspace } = await open();
		await homes(workspace);
		const listed = await listFiles(workspace, ['/'], SEATS);
		const home = (group: string) =>
			listed.filter((file) => file.group === group).map((file) => [file.path, file.relative]);
		expect(home('~engineer')).toEqual([
			['/home/engineer/fm-radio/firmware/main.c', 'fm-radio/firmware/main.c'],
			['/home/engineer/sweep.py', 'sweep.py'],
		]);
		expect(home('~researcher')).toEqual([['/home/researcher/notes/plan.md', 'notes/plan.md']]);
		expect(home('~engineer-two')).toEqual([
			['/home/engineer-two/ldo-compare.md', 'ldo-compare.md'],
		]);
	});

	it('puts the roots first, and names the group of a file of the root / by its top folder', async () => {
		const { workspace } = await open();
		await homes(workspace);
		const listed = await listFiles(workspace, ['/'], SEATS);
		expect(listed.map((file) => file.group)).toEqual([
			'/',
			'/shared',
			'~researcher',
			'~engineer',
			'~engineer',
			'~engineer-two',
		]);
		expect(listed[0]).toMatchObject({ path: '/plain.txt', relative: 'plain.txt' });
		expect(listed[1]).toMatchObject({ path: '/shared/kit.md', relative: 'kit.md' });
	});

	it('lists no file twice when the walk of the root / would reach a home', async () => {
		const { workspace } = await open();
		await homes(workspace);
		const paths = (await listFiles(workspace, ['/'], SEATS)).map((file) => file.path);
		expect(new Set(paths).size).toBe(paths.length);
	});

	it('keeps the groups of the roots in the order of the roots, and the path inside the root', async () => {
		const { workspace } = await open();
		await write(workspace, 'researcher', {
			'/library/a.pdf': 'a',
			'/shared/rf/b.md': 'b',
			'/attachments/c.png': 'c',
		});
		const listed = await listFiles(workspace, ['/library', '/shared', '/attachments']);
		expect(listed.map((file) => [file.group, file.relative])).toEqual([
			['/library', 'a.pdf'],
			['/shared', 'rf/b.md'],
			['/attachments', 'c.png'],
		]);
	});

	it('takes up to 200 files from a home', async () => {
		const { workspace } = await open();
		const many: Record<string, string> = {};
		for (let at = 0; at < 250; at += 1)
			many[`/home/engineer/run/f${String(at).padStart(3, '0')}.txt`] = 'x';
		await write(workspace, 'engineer', many);
		const listed = await listFiles(workspace, ['/'], ['engineer']);
		expect(listed).toHaveLength(200);
		expect(listed.every((file) => file.group === '~engineer')).toBe(true);
	});

	it('gives an empty group for a home that fails to list, and lists the others', async () => {
		const { workspace } = await open();
		await homes(workspace);
		const listed = await listFiles(workspace, ['/'], ['ghost', 'researcher']);
		expect(listed.filter((file) => file.group === '~ghost')).toEqual([]);
		expect(listed.filter((file) => file.group === '~researcher')).toHaveLength(1);
	});

	it('fails when a root does not list', async () => {
		const { workspace } = await open();
		await expect(listFiles(workspace, ['/home/engineer'], [])).rejects.toThrow();
	});
});

describe('the files of the homes', () => {
	it('reads a file of a home as the seat that owns it', async () => {
		const { workspace, used } = await open();
		await homes(workspace);
		used.length = 0;
		expect((await readFile(workspace, '/home/engineer/sweep.py', SEATS)).text).toBe('print(1)\n');
		expect(used).toEqual(['engineer']);
	});

	it('routes a read by the whole name of the home: engineer-two is not engineer', async () => {
		const { workspace, used } = await open();
		await homes(workspace);
		used.length = 0;
		expect((await readFile(workspace, '/home/engineer-two/ldo-compare.md', SEATS)).text).toBe(
			'# LDO\n',
		);
		expect(used).toEqual(['engineer-two']);
	});

	it('reads any other path as the host account', async () => {
		const { workspace, used, host } = await open();
		await homes(workspace);
		used.length = 0;
		expect((await readFile(workspace, '/shared/kit.md', SEATS)).text).toBe('kit\n');
		expect(used).toEqual([host]);
	});

	it('cannot read a home as the host account, as on a workstation', async () => {
		const { workspace } = await open();
		await homes(workspace);
		await expect(readFile(workspace, '/home/engineer/sweep.py')).rejects.toThrow(/File not found/);
	});

	it('refuses a path that leaves the home, and a path that is not absolute', async () => {
		const { workspace } = await open();
		await homes(workspace);
		await expect(
			readFile(workspace, '/home/engineer/../researcher/notes/plan.md', SEATS),
		).rejects.toThrow(/absolute workspace file path/);
		await expect(readFile(workspace, 'home/engineer/sweep.py', SEATS)).rejects.toThrow(
			/absolute workspace file path/,
		);
	});
});

describe('the hidden files and the links of a home', () => {
	it('refuses a hidden file or folder of a home, and still reads the same name outside a home', async () => {
		const { workspace } = await open();
		await write(workspace, 'engineer', {
			'/home/engineer/.ssh/id_ed25519': 'secret',
			'/home/engineer/work/.env': 'secret',
		});
		await write(workspace, 'researcher', { '/shared/.fetch/a.json': '{}' });
		for (const path of ['/home/engineer/.ssh/id_ed25519', '/home/engineer/work/.env'])
			await expect(readFile(workspace, path, SEATS)).rejects.toThrow(/hidden files in a home/);
		expect((await readFile(workspace, '/shared/.fetch/a.json', SEATS)).text).toBe('{}');
	});

	it('skips a symbolic link in the walk, and refuses to read it', async () => {
		const { workspace, directory } = await open();
		await homes(workspace);
		await symlink('/shared/kit.md', join(directory, 'workspace/home/engineer/link.md'));
		const listed = await listFiles(workspace, ['/'], SEATS);
		expect(listed.map((file) => file.path)).not.toContain('/home/engineer/link.md');
		await expect(readFile(workspace, '/home/engineer/link.md', SEATS)).rejects.toThrow(
			/symbolic links/,
		);
	});
});
