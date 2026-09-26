import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { WorkspaceLayout } from '@ambionframework/workspace';
import type { WorkspaceAgent } from '@ambionframework/workspace/resource';
import { workstationBackend, workstationGitBackend } from '@ambionframework/workstation';
import { templateRegistrations } from './repositories.ts';

/**
 * A workstation, as `workstation/setup.sh` writes it to `workstation.json`.
 * The bash backend and the git backend of the workspace run on it. The
 * journals stay in the SQLite file of the host.
 */
export interface WorkstationConfig {
	readonly host: string;
	readonly port: number;
	/** The SHA-256 fingerprint of the host key, as `ssh-keygen -lf` prints it. */
	readonly hostKey: string;
	/** The folder of the private keys, one file for each account, named after it. */
	readonly keys: string;
	/** The account that owns every repository. */
	readonly gitAccount: string;
	/** The audit log and the room mirror on the server. */
	readonly layout: WorkspaceLayout;
	/** The folders that the files panel lists. Each home has mode 0700, so the panel lists none. */
	readonly roots: readonly string[];
}

/** An account name that is safe as a file name in the key folder. */
const ACCOUNT = /^[a-z][a-z0-9-]{0,31}$/;

function text(value: unknown, field: string): string {
	if (typeof value !== 'string' || value === '') throw new Error(`workstation.json: set ${field}.`);
	return value;
}

function paths(value: unknown): string[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		!value.every((path) => typeof path === 'string')
	)
		throw new Error('workstation.json: set roots to a list of absolute paths.');
	return value;
}

/**
 * Read `workstation.json`. The key folder resolves against the folder of the
 * file, so the whole state folder can move.
 */
export async function loadWorkstation(path: string): Promise<WorkstationConfig> {
	const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
	const layout = (raw.layout ?? {}) as Record<string, unknown>;
	const port = raw.port ?? 22;
	if (typeof port !== 'number' || !Number.isInteger(port))
		throw new Error('workstation.json: set port to a whole number.');
	const gitAccount = text(raw.gitAccount, 'gitAccount');
	if (!ACCOUNT.test(gitAccount))
		throw new Error(`workstation.json: ${gitAccount} is not an account name.`);
	return {
		host: text(raw.host, 'host'),
		port,
		hostKey: text(raw.hostKey, 'hostKey'),
		keys: resolve(dirname(path), text(raw.keys, 'keys')),
		gitAccount,
		layout: {
			audit: text(layout.audit, 'layout.audit'),
			rooms: text(layout.rooms, 'layout.rooms'),
		},
		roots: paths(raw.roots),
	};
}

/** The private key of one account, from the key folder. */
async function keyOf(config: WorkstationConfig, name: string): Promise<string> {
	if (!ACCOUNT.test(name)) throw new Error(`The workstation has no account named ${name}.`);
	const path = resolve(config.keys, name);
	try {
		return await readFile(path, 'utf8');
	} catch {
		throw new Error(
			`The workstation has no key for ${name} at ${path}. Add the account to workstation/accounts, then run workstation/setup.sh and rebuild the image.`,
		);
	}
}

/**
 * The bash backend and the git backend over one workstation. Each agent logs
 * in with its own account and key. The git account holds the templates of
 * the lab, and each agent reaches it over SSH on the server itself.
 */
export async function workstationBackends(config: WorkstationConfig) {
	const server = { host: config.host, port: config.port, hostKey: config.hostKey };
	const gitKey = await keyOf(config, config.gitAccount);
	return {
		bash: workstationBackend({
			...server,
			layout: config.layout,
			credentialFor: async (agent: WorkspaceAgent) => ({
				username: agent.name,
				privateKey: await keyOf(config, agent.name),
			}),
		}),
		git: workstationGitBackend({
			...server,
			account: { username: config.gitAccount, privateKey: gitKey },
			templates: templateRegistrations(),
		}),
	};
}
