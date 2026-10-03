import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { memoryBackend } from '@ambionframework/just-bash';
import type { Workspace } from '@ambionframework/workspace';
import { openWorkspace } from '@ambionframework/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { team } from '../src/domain/definitions.ts';
import { loadWorkstation, probeWorkstation } from '../src/host/workstation.ts';

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
		layout: {
			audit: '/srv/workbench/audit/audit.jsonl',
			rooms: '/srv/workbench/rooms',
			snapshots: '/srv/workbench/snapshots',
		},
		roots: ['/library', '/shared', '/attachments'],
	};
	await writeFile(path, JSON.stringify({ ...base, ...change }));
	return path;
}

const OBJECTS = {
	endpoint: 'http://127.0.0.1:9000',
	bucket: 'workbench-snapshots',
	prefix: 'workbench/',
	credentials: 'objects.env',
};

describe('the workstation config', () => {
	it('reads workstation.json, and resolves the key folder against its folder', async () => {
		const path = await config();
		const loaded = await loadWorkstation(path);
		expect(loaded).toMatchObject({ host: '127.0.0.1', port: 2222, gitAccount: 'workbench-git' });
		expect(loaded.keys).toBe(join(path, '..', 'keys'));
		expect(loaded.roots).toEqual(['/library', '/shared', '/attachments']);
	});

	it('reads no object store from a config without one', async () => {
		expect((await loadWorkstation(await config())).objects).toBeUndefined();
	});

	it('reads the object store, and the credential from the env file beside the config', async () => {
		const path = await config({ objects: OBJECTS });
		await writeFile(
			join(dirname(path), 'objects.env'),
			'MINIO_ROOT_USER=root\nS3_ACCESS_KEY_ID=host\nS3_SECRET_ACCESS_KEY=a=b=c\n',
		);
		expect((await loadWorkstation(path)).objects).toEqual({
			endpoint: 'http://127.0.0.1:9000',
			region: 'us-east-1',
			bucket: 'workbench-snapshots',
			prefix: 'workbench/',
			accessKeyId: 'host',
			secretAccessKey: 'a=b=c',
		});
	});

	it.each([
		['the env file is missing', undefined, /cannot read objects.credentials/],
		['the access key is missing', 'S3_SECRET_ACCESS_KEY=x\n', /S3_ACCESS_KEY_ID/],
		['the secret is missing', 'S3_ACCESS_KEY_ID=x\n', /S3_SECRET_ACCESS_KEY/],
	])('refuses an object store when %s', async (_name, source, error) => {
		const path = await config({ objects: OBJECTS });
		if (source !== undefined) await writeFile(join(dirname(path), 'objects.env'), source);
		await expect(loadWorkstation(path)).rejects.toThrow(error);
	});

	it.each([
		[{ host: '' }, /set host/],
		[{ port: '2222' }, /port/],
		[{ hostKey: undefined }, /set hostKey/],
		[{ gitAccount: '../root' }, /not an account name/],
		[{ layout: { audit: '/a' } }, /layout.rooms/],
		[{ layout: { audit: '/a', rooms: '/r' } }, /layout.snapshots/],
		[{ roots: [] }, /roots/],
	])('refuses %o', async (change, error) => {
		await expect(loadWorkstation(await config(change))).rejects.toThrow(error);
	});

	it('names the path when the file is not JSON', async () => {
		const path = await config();
		await writeFile(path, '{ "host": ');
		const error = await loadWorkstation(path).catch((caught: unknown) => caught);
		expect((error as Error).message).toContain(`workstation.json at ${path} is not JSON: `);
	});

	it('names the path and the step when the file is missing', async () => {
		const path = join(tmpdir(), 'workbench-absent', 'workstation.json');
		const error = await loadWorkstation(path).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(`cannot read workstation.json at ${path}`);
		expect((error as Error).message).toContain('workstation/setup.sh');
		expect((error as Error).cause).toBeDefined();
	});

	it('holds an account for each specialist and for the host, in workstation/accounts', async () => {
		const accounts = readFileSync(new URL('../workstation/accounts', import.meta.url), 'utf8')
			.split('\n')
			.filter((line) => line !== '' && !line.startsWith('#'));
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		const built = await team(workspace);
		expect(accounts.sort()).toEqual(
			[...built.specialists.map((seat) => seat.name), workspace.mirrorAgent.name].sort(),
		);
	});
});

describe('the workstation probe', () => {
	const mirrorAgent = { name: 'workbench-host' };

	async function loaded() {
		return loadWorkstation(await config());
	}

	function fake(use: Workspace['use']): Pick<Workspace, 'use' | 'mirrorAgent'> {
		return { use, mirrorAgent };
	}

	it('names the server, both accounts with their keys, and the cause when SSH fails', async () => {
		const cause = new Error('connection refused');
		const settings = await loaded();
		const error = await probeWorkstation(
			fake(() => Promise.reject(cause)),
			settings,
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(
			`Workbench cannot open the workstation at 127.0.0.1:2222. The host account is workbench-host with the key ${join(settings.keys, 'workbench-host')}. The git account is ${settings.gitAccount} with the key ${join(settings.keys, settings.gitAccount)}. connection refused`,
		);
		expect((error as Error).cause).toBe(cause);
	});

	it('names the failure that a file result carries', async () => {
		const use = (async (_agent: unknown, operation: (env: unknown) => unknown) =>
			operation({
				exists: async () => ({ ok: false, error: new Error('no route') }),
			})) as unknown as Workspace['use'];
		await expect(probeWorkstation(fake(use), await loaded())).rejects.toThrow(
			/127\.0\.0\.1:2222.*no route/,
		);
	});

	it('passes when the root exists', async () => {
		const use = (async (_agent: unknown, operation: (env: unknown) => unknown) =>
			operation({
				exists: async () => ({ ok: true, value: true }),
			})) as unknown as Workspace['use'];
		await expect(probeWorkstation(fake(use), await loaded())).resolves.toBeUndefined();
	});
});
