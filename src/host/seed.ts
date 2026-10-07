import type { Workspace } from '@ambionframework/workspace';
import { packageDirectory, packageFiles } from '../domain/package-root.ts';

/** The environment of one workspace operation. */
type Env = Parameters<Parameters<Workspace['use']>[1]>[0];

const DATASHEETS = '/datasheets/';

/** The content of a seed file: text for Markdown, bytes for a figure. */
type SeedContent = string | Uint8Array;

/**
 * The files under one directory of the package, by workspace path. A
 * Markdown file is text. Every other file, such as a figure, is bytes. The
 * ignore rule of `packageFiles` applies: `.DS_Store`, `.git`, `__pycache__`,
 * and `.pyc` files stay out. The seed keeps another dot file.
 */
function directoryFiles(directory: string, prefix: string): Record<string, SeedContent> {
	return Object.fromEntries(
		Object.entries(packageFiles(packageDirectory(directory))).map(([name, bytes]) => [
			`${prefix}${name}`,
			name.endsWith('.md') ? Buffer.from(bytes).toString('utf8') : bytes,
		]),
	);
}

/**
 * The seed of a workspace: each file by its workspace path. `datasheets/` of
 * the package gives `/datasheets/...`. `seed/` of the package gives every other
 * file, so `seed/shared/kit.md` becomes `/shared/kit.md`. The host writes
 * each file of `/datasheets` at every start, because the package owns them. It
 * writes every other file only when the workspace does not hold it, so an
 * edit always remains. `overrides` replaces files of the seed by path, as an
 * eval of another project does.
 */
export function seedFiles(overrides: Record<string, string> = {}): Record<string, SeedContent> {
	return {
		...directoryFiles('datasheets', '/datasheets/'),
		...directoryFiles('seed', '/'),
		...overrides,
	};
}

/**
 * Write one file. A file of `/datasheets` is written every time, because the
 * package owns the datasheets and a newer package brings newer documents. Any
 * other file is written only when the workspace does not hold it yet.
 */
async function writeSeed(env: Env, path: string, content: SeedContent): Promise<void> {
	if (!path.startsWith(DATASHEETS)) {
		const found = await env.exists(path);
		if (!found.ok) throw found.error;
		if (found.value) return;
	}
	const written = await env.writeFile(path, content);
	if (!written.ok) throw written.error;
}

/**
 * Write the seed files as the host account. The seed goes through the
 * workspace, so a local directory and a workstation get it the same way.
 * An existing file outside `/datasheets` always remains.
 */
export async function seedWorkspace(
	workspace: Workspace,
	overrides: Record<string, string> = {},
): Promise<void> {
	await workspace.use(workspace.mirrorAgent, async (env) => {
		for (const [path, content] of Object.entries(seedFiles(overrides)))
			await writeSeed(env, path, content);
	});
}
