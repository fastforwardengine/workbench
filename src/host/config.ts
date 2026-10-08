import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	type AgentDefinition,
	DEFAULT_RESPOND_POLICY,
	DEFAULT_SUMMARY_POLICY,
	type Executor,
	type JsonValue,
	type PersonDefinition,
} from '@ambionframework/ambion';
import { packageDirectory } from '../domain/package-root.ts';

/** The name of the config log, in the data directory. */
const CONFIG_LOG = 'configs.jsonl';

/** The package scope of the Ambion packages. */
const SCOPE = '@ambionframework/';

/** A JSON object. */
type JsonObject = { readonly [key: string]: JsonValue };

/** What the host knows about a start, besides the definitions. */
export interface ConfigInput {
	/** The definitions that the host seats. */
	specialists: readonly AgentDefinition[];
	/** The people, with their definitions. */
	people: readonly PersonDefinition[];
	/** The limits that the runtime runs with. */
	limits: object;
	/** The host name of the workstation. Without it, the workspace runs on this machine. */
	workstation?: string;
	/** True when the model has a key or a sign-in. The file records the state and no credential. */
	login: boolean;
}

/** One snapshot of the config: the content of a line, without `at` and `hash`. */
export type ConfigSnapshot = JsonObject;

/**
 * A plain JSON copy of a value. A function, a symbol, and an undefined value
 * leave no field. A number that JSON cannot hold, and a bigint, become text.
 * A reference back to a value that the copy is inside becomes `"[cycle]"`.
 */
export function plain(value: unknown, parents: readonly object[] = []): JsonValue | undefined {
	switch (typeof value) {
		case 'string':
		case 'boolean':
			return value;
		case 'number':
			return Number.isFinite(value) ? value : String(value);
		case 'bigint':
			return String(value);
		case 'object':
			return value === null ? null : plainObject(value, parents);
		default:
			return undefined;
	}
}

function plainObject(value: object, parents: readonly object[]): JsonValue {
	if (parents.includes(value)) return '[cycle]';
	const inside = [...parents, value];
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map((item) => plain(item, inside) ?? null);
	return plainRecord(value, inside);
}

/** The own fields of an object that hold a plain value. */
function plainRecord(value: object, parents: readonly object[]): JsonObject {
	const fields: [string, JsonValue][] = [];
	for (const [key, field] of Object.entries(value)) {
		const copy = plain(field, parents);
		if (copy !== undefined) fields.push([key, copy]);
	}
	return Object.fromEntries(fields);
}

/** The executor of a definition, with the effective value of each default. */
function executorConfig(executor: Executor): JsonObject {
	const { tools, reminders, respondPolicy, summaryPolicy, ...rest } = executor;
	return {
		...plainRecord(rest, [executor]),
		respondPolicy: respondPolicy ?? DEFAULT_RESPOND_POLICY,
		respondPolicySource: respondPolicy === undefined ? 'default' : 'definition',
		summaryPolicy: summaryPolicy ?? DEFAULT_SUMMARY_POLICY,
		summaryPolicySource: summaryPolicy === undefined ? 'default' : 'definition',
		activationTokenLimit: executor.activationTokenLimit ?? null,
		estimateTokens: executor.estimateTokens ?? 'length',
		reminderCount: reminders?.length ?? 0,
		tools: tools.map((tool) => plainRecord(tool, [tool])),
	};
}

/** One specialist, as the host seats it. */
function specialistConfig(definition: AgentDefinition): JsonObject {
	return {
		name: definition.name,
		identity: definition.identity,
		trace: plain(definition.trace) ?? null,
		executor: executorConfig(definition.executor),
	};
}

/** The installed version of a package, or undefined when the host cannot find it. */
async function installedVersion(name: string): Promise<string | undefined> {
	try {
		let directory = dirname(fileURLToPath(import.meta.resolve(name)));
		for (;;) {
			const found = await readFile(join(directory, 'package.json'), 'utf8').catch(() => '');
			const manifest = found ? (JSON.parse(found) as { name?: string; version?: string }) : {};
			if (manifest.name === name) return manifest.version;
			const parent = dirname(directory);
			if (parent === directory) return undefined;
			directory = parent;
		}
	} catch {
		return undefined;
	}
}

/** The version of Workbench, and the installed version of each Ambion dependency. */
async function versions(): Promise<JsonObject> {
	const manifest = JSON.parse(await readFile(packageDirectory('package.json'), 'utf8')) as {
		version: string;
		dependencies?: Record<string, string>;
	};
	const names = Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith(SCOPE));
	const installed = await Promise.all(
		names.map(async (name) => [name, (await installedVersion(name)) ?? 'unknown'] as const),
	);
	return { workbench: manifest.version, ambion: Object.fromEntries(installed) };
}

/**
 * The snapshot of the config for one start. It copies the live definitions
 * that the host seats, so the snapshot cannot differ from what the seats run.
 */
export async function configSnapshot(input: ConfigInput): Promise<ConfigSnapshot> {
	return {
		versions: await versions(),
		model: { login: input.login ? 'present' : 'missing' },
		workstation: input.workstation === undefined ? null : { host: input.workstation },
		limits: { setBy: 'ambion defaults', values: plain(input.limits) ?? null },
		people: input.people.map((person) => plainRecord(person, [person])),
		specialists: input.specialists.map(specialistConfig),
	};
}

/** The JSON text of a value with the keys of each object in order, so equal values give equal text. */
function canonical(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	const fields = Object.entries(value as JsonObject).sort(([a], [b]) => (a < b ? -1 : 1));
	return `{${fields.map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(',')}}`;
}

/** The SHA-256 of the canonical JSON of a snapshot, in hex. */
export function configHash(snapshot: ConfigSnapshot): string {
	return createHash('sha256').update(canonical(snapshot)).digest('hex');
}

/** The hash on the last line of the log text. An empty text and a bad last line give undefined. */
function lastHash(text: string): string | undefined {
	const line = text
		.split('\n')
		.filter((candidate) => candidate.trim() !== '')
		.at(-1);
	try {
		const hash = line === undefined ? undefined : (JSON.parse(line) as { hash?: unknown }).hash;
		return typeof hash === 'string' ? hash : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Append a line to `configs.jsonl` in `directory` when the snapshot differs
 * from the last line. Returns true when it appended a line.
 */
export async function writeConfig(
	directory: string,
	input: ConfigInput,
	now: Date = new Date(),
): Promise<boolean> {
	const path = resolve(directory, CONFIG_LOG);
	const snapshot = await configSnapshot(input);
	const hash = configHash(snapshot);
	const text = await readFile(path, 'utf8').catch(() => '');
	if (lastHash(text) === hash) return false;
	// A last line without a line break would join the new line, so end it first.
	const separator = text === '' || text.endsWith('\n') ? '' : '\n';
	await appendFile(
		path,
		`${separator}${JSON.stringify({ at: now.toISOString(), hash, ...snapshot })}\n`,
	);
	return true;
}
