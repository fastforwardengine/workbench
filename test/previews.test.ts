import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { readCommitFile, readSnapshotFile } from '../src/host/previews.ts';
import { labRepositories } from '../src/host/repositories.ts';
import { WORKSPACE } from '../src/view/refs.ts';
import { PNG } from './png.ts';

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

function open() {
	const workspace = openWorkspace({
		name: WORKSPACE,
		backend: { bash: memoryBackend({ git: labRepositories(':memory:') }) },
	});
	cleanups.push(() => workspace.dispose());
	return workspace;
}

describe('the preview of a snapshot ref', () => {
	it('shows the bytes that the file held at the snapshot, after the file changes', async () => {
		const workspace = open();
		await workspace.use(workspace.mirrorAgent, (env) =>
			env.writeFile('/shared/readings.csv', 'volts,amps\n3.30,0.020\n'),
		);
		const [ref = ''] = await workspace.snapshot(['/shared/readings.csv']);
		await workspace.use(workspace.mirrorAgent, (env) =>
			env.writeFile('/shared/readings.csv', 'volts,amps\n3.30,0.999\n'),
		);
		const file = await readSnapshotFile(workspace, ref);
		expect(file).toEqual({ path: ref, text: 'volts,amps\n3.30,0.020\n', truncated: false });
	});

	it('gives a note for binary bytes, and refuses a ref that no store holds', async () => {
		const workspace = open();
		await workspace.use(workspace.mirrorAgent, (env) => env.writeFile('/shared/blob.bin', 'a\0b'));
		const [ref = ''] = await workspace.snapshot(['/shared/blob.bin']);
		expect((await readSnapshotFile(workspace, ref)).text).toMatch(/^A binary file of 3 bytes/);
		const missing = ref.replace(/snapshot\/[0-9a-f]{64}\//, `snapshot/${'0'.repeat(64)}/`);
		await expect(readSnapshotFile(workspace, missing)).rejects.toThrow();
	});
});

describe('the preview of what a fetch of a sensor retains', () => {
	/** Write the two bodies that `fetch` keeps for one read of a camera, and snapshot them. */
	async function retain(workspace: ReturnType<typeof open>, observation: string) {
		const paths = [
			'/shared/.fetch/camera/0a1b2c3d4e5f.json',
			'/shared/.fetch/camera/6a7b8c9d0e1f.png',
		];
		await workspace.use(workspace.mirrorAgent, async (env) => {
			await env.writeFile(paths[0] ?? '', observation);
			await env.writeFile(paths[1] ?? '', PNG);
		});
		return workspace.snapshot(paths);
	}

	it('shows an observation as its JSON text', async () => {
		const workspace = open();
		const observation = JSON.stringify({
			api: 2,
			observations: [
				{
					at: '2026-10-03T10:00:00.000Z',
					parts: [{ kind: 'frame', file: '0'.repeat(64), mediaType: 'image/png' }],
				},
			],
		});
		const [ref = ''] = await retain(workspace, observation);
		expect(await readSnapshotFile(workspace, ref)).toEqual({
			path: ref,
			text: observation,
			truncated: false,
		});
	});

	it('shows a frame as a picture', async () => {
		const workspace = open();
		const [, ref = ''] = await retain(workspace, '{}');
		const file = await readSnapshotFile(workspace, ref);
		expect(file.text).toBe('');
		expect(file.image?.mimeType).toBe('image/png');
		expect(file.image?.data.byteLength).toBe(PNG.byteLength);
	});
});

describe('the preview of a commit ref', () => {
	it('shows the commit of a template with its message, its changes, and its branch', async () => {
		const workspace = open();
		await workspace.git?.use(workspace.mirrorAgent, (env) => env.list());
		const ref = await workspace.commitRef('templates/device-scan', { branch: 'main' });
		const file = await readCommitFile(workspace, ref);
		expect(file.path).toBe(ref);
		expect(file.text).toContain('templates/device-scan, branch main');
		expect(file.text).toContain('inventory.md');
		expect(file.text).toContain('The branch main still names this commit.');
	});

	it('refuses a string that is not a commit ref', async () => {
		await expect(readCommitFile(open(), 'file:///library/a.md')).rejects.toThrow(
			/not a commit ref/,
		);
	});
});
