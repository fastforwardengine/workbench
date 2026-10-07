import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import { buildRoom } from '../src/domain/room.ts';
import { seedFiles, seedWorkspace } from '../src/host/seed.ts';

describe('the seed of the workspace', () => {
	it('holds the kit file, and points at the notes and the library', () => {
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
});

describe('the seed of a workspace', () => {
	it('writes no file over an edit', async () => {
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		try {
			await seedWorkspace(workspace);
			await workspace.use(workspace.mirrorAgent, async (env) => {
				const written = await env.writeFile('/shared/kit.md', 'the edited kit');
				expect(written.ok).toBe(true);
			});
			await seedWorkspace(workspace);
			await workspace.use(workspace.mirrorAgent, async (env) => {
				const kit = await env.readTextFile('/shared/kit.md');
				expect(kit.ok && kit.value).toBe('the edited kit');
				const index = await env.readTextFile('/library/README.md');
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
