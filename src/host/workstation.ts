import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Workspace, WorkspaceLayout } from '@ambionframework/workspace';
import type { WorkspaceAgent } from '@ambionframework/workspace/resource';
import { s3ObjectBackend } from '@ambionframework/workspace/s3';
import { workstationBackend, workstationGitBackend } from '@ambionframework/workstation';
import { sharedRegistrations } from '../domain/notes.ts';
import { templateRegistrations } from './repositories.ts';

/** The object store for the snapshots: an S3 API, and the credential of the host. */
interface ObjectsConfig {
	readonly endpoint: string;
	readonly region: string;
	readonly bucket: string;
	/** The key prefix of this workspace in the bucket. Empty means the bucket root. */
	readonly prefix: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
}

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
	/** The object store for the snapshots. Without it, the workstation keeps them in `layout.snapshots`. */
	readonly objects?: ObjectsConfig;
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

/** The value of one variable in the text of an env file, or undefined when it has none. */
function variable(source: string, name: string): string | undefined {
	for (const line of source.split('\n')) {
		const [key, ...rest] = line.split('=');
		if (key?.trim() === name) return rest.join('=').trim();
	}
	return undefined;
}

/**
 * Read the `objects` block of `workstation.json`. `credentials` names an env
 * file beside it, with `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. The file
 * stays out of `workstation.json`, which holds no secret.
 */
async function loadObjects(raw: unknown, folder: string): Promise<ObjectsConfig | undefined> {
	if (raw === undefined) return undefined;
	const block = (raw ?? {}) as Record<string, unknown>;
	const path = resolve(folder, text(block.credentials, 'objects.credentials'));
	const source = await readFile(path, 'utf8').catch(() => {
		throw new Error(
			`workstation.json: cannot read objects.credentials at ${path}. Run workstation/setup.sh.`,
		);
	});
	const prefix = block.prefix ?? '';
	if (typeof prefix !== 'string') throw new Error('workstation.json: set objects.prefix to text.');
	return {
		endpoint: text(block.endpoint, 'objects.endpoint'),
		region: text(block.region ?? 'us-east-1', 'objects.region'),
		bucket: text(block.bucket, 'objects.bucket'),
		prefix,
		accessKeyId: text(
			variable(source, 'S3_ACCESS_KEY_ID'),
			'S3_ACCESS_KEY_ID in objects.credentials',
		),
		secretAccessKey: text(
			variable(source, 'S3_SECRET_ACCESS_KEY'),
			'S3_SECRET_ACCESS_KEY in objects.credentials',
		),
	};
}

/** The message of a caught value. */
function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The parsed text of `workstation.json`. A failure names the path. */
async function readConfig(path: string): Promise<Record<string, unknown>> {
	let source: string;
	try {
		source = await readFile(path, 'utf8');
	} catch (error) {
		throw new Error(
			`Workbench cannot read workstation.json at ${path}: ${reason(error)}. Run make, or run workstation/setup.sh, to write it.`,
			{ cause: error },
		);
	}
	try {
		return JSON.parse(source) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`workstation.json at ${path} is not JSON: ${reason(error)}`, {
			cause: error,
		});
	}
}

/**
 * Read `workstation.json`. The key folder resolves against the folder of the
 * file, so the whole state folder can move.
 */
export async function loadWorkstation(path: string): Promise<WorkstationConfig> {
	const raw = await readConfig(path);
	const layout = (raw.layout ?? {}) as Record<string, unknown>;
	const port = raw.port ?? 22;
	if (typeof port !== 'number' || !Number.isInteger(port))
		throw new Error('workstation.json: set port to a whole number.');
	const gitAccount = text(raw.gitAccount, 'gitAccount');
	if (!ACCOUNT.test(gitAccount))
		throw new Error(`workstation.json: ${gitAccount} is not an account name.`);
	const objects = await loadObjects(raw.objects, dirname(path));
	return {
		host: text(raw.host, 'host'),
		port,
		hostKey: text(raw.hostKey, 'hostKey'),
		keys: resolve(dirname(path), text(raw.keys, 'keys')),
		gitAccount,
		layout: {
			audit: text(layout.audit, 'layout.audit'),
			rooms: text(layout.rooms, 'layout.rooms'),
			snapshots: text(layout.snapshots, 'layout.snapshots'),
		},
		...(objects ? { objects } : {}),
		roots: paths(raw.roots),
	};
}

/** The file of the private key of one account, in the key folder. */
function keyPath(config: WorkstationConfig, name: string): string {
	if (!ACCOUNT.test(name)) throw new Error(`The workstation has no account named ${name}.`);
	return resolve(config.keys, name);
}

/** The private key of one account, from the key folder. */
async function keyOf(config: WorkstationConfig, name: string): Promise<string> {
	const path = keyPath(config, name);
	try {
		return await readFile(path, 'utf8');
	} catch {
		throw new Error(
			`The workstation has no key for ${name} at ${path}. Add the account to workstation/accounts, then run workstation/setup.sh and rebuild the image.`,
		);
	}
}

/**
 * The bash backend and the git backend over one workstation, and the object
 * backend when the config names an object store. Each agent logs in with its
 * own account and key. The git account holds the templates of the lab, and
 * each agent reaches it over SSH on the server itself. Only the host holds
 * the credential of the object store.
 */
export async function workstationBackends(
	config: WorkstationConfig,
	shared: ReturnType<typeof sharedRegistrations> = sharedRegistrations(),
) {
	const server = { server: config.host, port: config.port, hostKey: config.hostKey };
	const gitKey = await keyOf(config, config.gitAccount);
	const git = workstationGitBackend({
		...server,
		account: { username: config.gitAccount, privateKey: gitKey },
		templates: templateRegistrations(),
		shared,
	});
	return {
		bash: workstationBackend({
			git,
			...server,
			layout: config.layout,
			credentialFor: async (agent: WorkspaceAgent) => ({
				username: agent.name,
				privateKey: await keyOf(config, agent.name),
			}),
		}),
		...(config.objects ? { objects: s3ObjectBackend(config.objects) } : {}),
	};
}

/**
 * Check that the host reaches the workstation. The first operation of the
 * host account opens two SSH sessions: one as the host account, and one as
 * the git account, which registers the templates. A failure in either names
 * the server and both accounts with their keys. Without the check, an SSH
 * failure surfaces at the first workspace operation with none of them.
 * Ambion has no workstation check yet. When it gets one, remove this probe.
 */
export async function probeWorkstation(
	workspace: Pick<Workspace, 'use' | 'mirrorAgent'>,
	config: WorkstationConfig,
): Promise<void> {
	const account = workspace.mirrorAgent.name;
	try {
		const found = await workspace.use(workspace.mirrorAgent, (env) => env.exists('/'));
		if (!found.ok) throw found.error;
	} catch (error) {
		throw new Error(
			`Workbench cannot open the workstation at ${config.host}:${config.port}. The host account is ${account} with the key ${keyPath(config, account)}. The git account is ${config.gitAccount} with the key ${keyPath(config, config.gitAccount)}. ${reason(error)}`,
			{ cause: error },
		);
	}
}
