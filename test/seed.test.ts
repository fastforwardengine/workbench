import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import { buildRoom } from '../src/domain/room.ts';
import { seedFiles, seedWorkspace } from '../src/host/seed.ts';

describe('the seed of the workspace', () => {
	it('holds the kit file, and points at the notes and the datasheets', () => {
		const files = seedFiles();
		const kit = files['/shared/kit.md'];
		expect(kit).toContain('FM radio kit');
		expect(kit).toContain('shared/notes');
		expect(kit).toContain('STC8G1K17');
		expect(kit).toContain('The power stays off until the checks of the build pass.');
		expect(String(kit).replace(/\s+/g, ' ')).toContain(
			'goes through the HM310P, with a current limit',
		);
		expect(Object.keys(files)).not.toContain('/shared/bench.md');
		expect(Object.keys(files)).not.toContain('/shared/notes.md');
	});

	it('names the build room in the kit file', () => {
		const kit = seedFiles()['/shared/kit.md'] ?? '';
		expect(kit).toContain(`\`${buildRoom.name}\``);
	});

	it('replaces a file by path from the overrides, and keeps the others', () => {
		const files = seedFiles({ '/shared/kit.md': 'other' });
		expect(files['/shared/kit.md']).toBe('other');
		expect(files['/datasheets/README.md']).toBe(seedFiles()['/datasheets/README.md']);
	});
});

describe('the seed of a workspace', () => {
	it('writes an override in place of the radio file, and no file over an edit', async () => {
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		try {
			await seedWorkspace(workspace, { '/shared/kit.md': 'the LED kit' });
			await seedWorkspace(workspace, { '/shared/kit.md': 'a later kit' });
			await workspace.use(workspace.mirrorAgent, async (env) => {
				const kit = await env.readTextFile('/shared/kit.md');
				expect(kit.ok && kit.value).toBe('the LED kit');
				const index = await env.readTextFile('/datasheets/README.md');
				expect(index.ok && index.value).toContain('rda5807fp.md');
			});
		} finally {
			await workspace.dispose();
		}
	});

	it('writes the kit file of seed/ at /shared/kit.md', async () => {
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		try {
			await seedWorkspace(workspace);
			await workspace.use(workspace.mirrorAgent, async (env) => {
				const kit = await env.readTextFile('/shared/kit.md');
				expect(kit.ok && kit.value).toBe(seedFiles()['/shared/kit.md']);
				expect(kit.ok && kit.value).toContain('# The project');
			});
		} finally {
			await workspace.dispose();
		}
	});
});
