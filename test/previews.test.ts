import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { readCommitFile, readSnapshotFile } from '../src/host/previews.ts';
import { labRepositories } from '../src/host/repositories.ts';
import { WORKSPACE } from '../src/view/refs.ts';

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

describe('the preview of a commit ref', () => {
	it('shows the commit of a template with its message, its changes, and its branch', async () => {
		const workspace = open();
		await workspace.git?.use(workspace.mirrorAgent, (env) => env.list());
		const ref = await workspace.commitRef('templates/test-plan', { branch: 'main' });
		const file = await readCommitFile(workspace, ref);
		expect(file.path).toBe(ref);
		expect(file.text).toContain('templates/test-plan, branch main');
		expect(file.text).toContain('plan.md');
		expect(file.text).toContain('The branch main still names this commit.');
	});

	it('refuses a string that is not a commit ref', async () => {
		await expect(readCommitFile(open(), 'file:///library/a.md')).rejects.toThrow(
			/not a commit ref/,
		);
	});
});
