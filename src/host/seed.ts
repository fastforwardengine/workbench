import type { Workspace } from '@ambionframework/workspace';
import { type SeedContent, seedFiles } from '../domain/scenarios.ts';

/** The environment of one workspace operation. */
type Env = Parameters<Parameters<Workspace['use']>[1]>[0];

const LIBRARY = '/library/';

/**
 * Write one file. A file of `/library` is written every time, because the
 * package owns the library and a newer package brings newer documents. Any
 * other file is written only when the workspace does not hold it yet.
 */
async function writeSeed(env: Env, path: string, content: SeedContent): Promise<void> {
	if (!path.startsWith(LIBRARY)) {
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
 * An existing file outside `/library` always remains.
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
