import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { team } from '../src/domain/definitions.ts';
import { loadWorkstation } from '../src/host/workstation.ts';

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

/** Write a `workstation.json` with one field changed, and return its path. */
async function config(change: Record<string, unknown> = {}): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'workbench-config-'));
	directories.push(directory);
	const path = join(directory, 'workstation.json');
	const base = {
		host: '127.0.0.1',
		port: 2222,
		hostKey: 'SHA256:abc',
		keys: 'keys',
		gitAccount: 'workbench-git',
		layout: { audit: '/srv/workbench/audit/audit.jsonl', rooms: '/srv/workbench/rooms' },
		roots: ['/library', '/shared'],
	};
	await writeFile(path, JSON.stringify({ ...base, ...change }));
	return path;
}

describe('the workstation config', () => {
	it('reads workstation.json, and resolves the key folder against its folder', async () => {
		const path = await config();
		const loaded = await loadWorkstation(path);
		expect(loaded).toMatchObject({ host: '127.0.0.1', port: 2222, gitAccount: 'workbench-git' });
		expect(loaded.keys).toBe(join(path, '..', 'keys'));
		expect(loaded.roots).toEqual(['/library', '/shared']);
	});

	it.each([
		[{ host: '' }, /set host/],
		[{ port: '2222' }, /port/],
		[{ hostKey: undefined }, /set hostKey/],
		[{ gitAccount: '../root' }, /not an account name/],
		[{ layout: { audit: '/a' } }, /layout.rooms/],
		[{ roots: [] }, /roots/],
	])('refuses %o', async (change, error) => {
		await expect(loadWorkstation(await config(change))).rejects.toThrow(error);
	});

	it('holds an account for each specialist and for the host, in workstation/accounts', () => {
		const accounts = readFileSync(new URL('../workstation/accounts', import.meta.url), 'utf8')
			.split('\n')
			.filter((line) => line !== '' && !line.startsWith('#'));
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		const built = team(workspace);
		expect(accounts.sort()).toEqual(
			[...built.specialists.map((seat) => seat.name), workspace.host.name].sort(),
		);
	});
});
