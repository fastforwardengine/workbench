/**
 * The snapshots on the object store of a real workstation, with no model. The
 * tier runs when `WORKBENCH_WORKSTATION` names a `workstation.json` with an
 * `objects` block, as `workstation/setup.sh` writes it. It needs the store
 * and its init job, which `make workstation` starts, and it needs no SSH:
 *
 *   WORKBENCH_WORKSTATION=.workstation/workstation.json pnpm test test/objects.test.ts
 *
 * The bucket persists, so each run names its files with a token of its own.
 */
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { s3ObjectBackend } from '@ambionframework/workspace/s3';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkstation } from '../src/host/workstation.ts';

const CONFIG = process.env.WORKBENCH_WORKSTATION;
const objects = CONFIG ? (await loadWorkstation(CONFIG)).objects : undefined;
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

describe.skipIf(!objects)('the object store of the workstation', () => {
	function open(change: Partial<NonNullable<typeof objects>> = {}) {
		if (!objects) throw new Error('No object store.');
		const workspace = openWorkspace({
			name: 'workbench',
			backend: { bash: memoryBackend(), objects: s3ObjectBackend({ ...objects, ...change }) },
		});
		cleanups.push(() => workspace.dispose());
		return workspace;
	}

	const token = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

	it('keeps the bytes of a snapshot after the file changes, and off the bash filesystem', async () => {
		const workspace = open();
		const path = `/shared/readings-${token()}.csv`;
		await workspace.use(workspace.mirrorAgent, (env) =>
			env.writeFile(path, 'volts,amps\n3.30,0.020\n'),
		);
		const [ref = ''] = await workspace.snapshot([path]);
		await workspace.use(workspace.mirrorAgent, (env) => env.writeFile(path, 'changed\n'));
		expect(new TextDecoder().decode(await workspace.readSnapshot(ref))).toBe(
			'volts,amps\n3.30,0.020\n',
		);
		const shelf = await workspace.use(workspace.mirrorAgent, (env) => env.exists('/snapshots'));
		expect(shelf.ok && shelf.value).toBe(false);
	});

	it('refuses a credential that the store does not know', async () => {
		const workspace = open({ secretAccessKey: 'not-the-secret' });
		const path = `/shared/refused-${token()}.txt`;
		await workspace.use(workspace.mirrorAgent, (env) => env.writeFile(path, 'x'));
		await expect(workspace.snapshot([path])).rejects.toThrow(/SignatureDoesNotMatch|403/);
	});
});
