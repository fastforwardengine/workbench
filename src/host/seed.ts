import { BACKGROUND_CONTEXT, type Workspace } from '@ambionframework/workspace';
import { seedFiles } from '../domain/scenarios.ts';

/** The environment of one workspace operation. */
type Env = Parameters<Parameters<Workspace['use']>[1]>[0];

/** Write one file when the workspace does not hold it yet. */
async function writeIfAbsent(env: Env, path: string, content: string): Promise<void> {
	const found = await env.exists(path, BACKGROUND_CONTEXT);
	if (!found.ok) throw found.error;
	if (found.value) return;
	const written = await env.writeFile(path, content, BACKGROUND_CONTEXT);
	if (!written.ok) throw written.error;
}

/**
 * Write each seed file that the workspace does not hold yet, as the host
 * account. The seed goes through the workspace, so a local directory and a
 * workstation get it the same way. An existing file always remains.
 */
export async function seedWorkspace(workspace: Workspace): Promise<void> {
	await workspace.use(workspace.host, async (env) => {
		for (const [path, content] of Object.entries(seedFiles()))
			await writeIfAbsent(env, path, content);
	});
}
