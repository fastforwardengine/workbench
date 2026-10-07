import type { Workspace } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import { readFile } from '../src/host/files.ts';

type Kind = 'file' | 'directory' | 'symlink';

/**
 * A workspace that answers like the SFTP backend of a Mac workstation. Each
 * path has one kind, as lstat gives it: `/shared` is a link to a folder, as a
 * root is on a Mac, and `/shared/loop` is a link below that root.
 */
function macWorkspace(): Workspace {
	const kinds: Record<string, Kind> = {
		'/shared': 'symlink',
		'/shared/kit.md': 'file',
		'/shared/inner': 'directory',
		'/shared/inner/note.md': 'file',
		'/shared/loop': 'symlink',
		'/shared/loop/note.md': 'file',
	};
	const texts: Record<string, string> = {
		'/shared/kit.md': 'FM radio kit',
		'/shared/inner/note.md': 'inner note',
		'/shared/loop/note.md': 'looped note',
	};
	const env = {
		async fileInfo(path: string) {
			const kind = kinds[path];
			return kind ? { ok: true, value: { kind, size: 12 } } : { ok: false };
		},
		async readTextFile(path: string) {
			const text = texts[path];
			return text === undefined
				? { ok: false, error: { message: 'No such file.' } }
				: { ok: true, value: text };
		},
	};
	return {
		mirrorAgent: 'mirror',
		use: async (_agent: string, run: (env: unknown) => Promise<unknown>) => run(env),
	} as unknown as Workspace;
}

describe('readFile with a root that is a link', () => {
	it('opens a file below a root that is a link, when the host configures that root', async () => {
		const workspace = macWorkspace();
		expect((await readFile(workspace, ['/shared'], '/shared/kit.md')).text).toBe('FM radio kit');
		expect((await readFile(workspace, ['/shared'], '/shared/inner/note.md')).text).toBe(
			'inner note',
		);
	});

	it('refuses a link below the root', async () => {
		await expect(readFile(macWorkspace(), ['/shared'], '/shared/loop/note.md')).rejects.toThrow(
			/symbolic links/,
		);
	});

	it('refuses a link that is not a configured root', async () => {
		const workspace = macWorkspace();
		await expect(readFile(workspace, ['/other'], '/shared/kit.md')).rejects.toThrow(
			/symbolic links/,
		);
		await expect(readFile(workspace, ['/'], '/shared/kit.md')).rejects.toThrow(/symbolic links/);
	});
});
