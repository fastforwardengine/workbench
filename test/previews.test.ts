import { parseSnapshotUri } from '@ambionframework/ambion';
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('the preview of a sensor manifest ref', () => {
	async function retain(
		workspace: ReturnType<typeof open>,
		manifest: (refs: readonly string[]) => unknown,
	) {
		const paths = ['/shared/a.png', '/shared/b.png'];
		await workspace.use(workspace.mirrorAgent, async (env) => {
			await env.writeFile(paths[0] ?? '', PNG);
			await env.writeFile(paths[1] ?? '', Buffer.concat([PNG, Buffer.from([0])]));
		});
		const refs = await workspace.snapshot(paths);
		const json = JSON.stringify(manifest(refs));
		await workspace.use(workspace.mirrorAgent, (env) =>
			env.writeFile('/shared/manifest.json', json),
		);
		const [ref = ''] = await workspace.snapshot(['/shared/manifest.json']);
		return { ref, refs, json };
	}

	const frame = (ref: string, at: string) => ({
		at,
		parts: [{ kind: 'frame', file: parseSnapshotUri(ref)?.digest, mediaType: 'image/png' }],
	});

	it('shows each frame with its caption, and keeps the JSON as text', async () => {
		const workspace = open();
		const { ref, json } = await retain(workspace, ([a = '', b = '']) => ({
			api: 1,
			sensor: 'bench-camera/camera',
			observations: [frame(a, '2026-10-03T10:00:00Z'), frame(b, '2026-10-03T10:00:05Z')],
			files: [a, b].map((one) => ({ digest: parseSnapshotUri(one)?.digest, ref: one })),
		}));
		const file = await readSnapshotFile(workspace, ref);
		expect(file.text).toBe(json);
		expect(file.frames?.map((one) => one.caption)).toEqual([
			'bench-camera/camera · 2026-10-03T10:00:00Z',
			'bench-camera/camera · 2026-10-03T10:00:05Z',
		]);
		expect(file.frames?.map((one) => one.image.data.byteLength)).toEqual([
			PNG.byteLength,
			PNG.byteLength + 1,
		]);
		expect(file.frames?.[0]?.image.mimeType).toBe('image/png');
	});

	it('reads a ref that repeats once', async () => {
		const workspace = open();
		const { ref } = await retain(workspace, ([a = '']) => ({
			api: 1,
			sensor: 'bench-camera/camera',
			observations: [frame(a, '2026-10-03T10:00:00Z'), frame(a, '2026-10-03T10:00:05Z')],
			files: [{ digest: parseSnapshotUri(a)?.digest, ref: a }],
		}));
		const read = vi.fn((one: string) => workspace.readSnapshot(one));
		const file = await readSnapshotFile({ ...workspace, readSnapshot: read }, ref);
		expect(file.frames).toHaveLength(2);
		expect(read).toHaveBeenCalledTimes(2);
	});

	it('keeps the text of a manifest that holds no frame', async () => {
		const workspace = open();
		const { ref, json } = await retain(workspace, () => ({
			api: 1,
			sensor: 'bench-camera/camera',
			observations: [],
			files: [],
		}));
		expect(await readSnapshotFile(workspace, ref)).toEqual({
			path: ref,
			text: json,
			truncated: false,
		});
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
