/** The config log that the host writes at each start. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AmbionTool, DEFAULT_RESPOND_POLICY, defineAgent } from '@ambionframework/ambion';
import { pi } from '@ambionframework/pi';
import { describe, expect, it } from 'vitest';
import { people } from '../src/domain/definitions.ts';
import {
	type ConfigInput,
	configHash,
	configSnapshot,
	plain,
	writeConfig,
} from '../src/host/config.ts';
import { openLab } from '../src/host/host.ts';

type Line = {
	at: string;
	hash: string;
	versions: { workbench: string; ambion: Record<string, string> };
	model: { login: string };
	workstation: unknown;
	limits: { setBy: string; values: Record<string, unknown> };
	people: { name: string; identity: string }[];
	specialists: {
		name: string;
		identity: string;
		trace: unknown;
		executor: {
			kind: string;
			model: string;
			thinking: string;
			instructions: string;
			respondPolicy: string;
			respondPolicySource: string;
			tools: { name: string; description: string; parameters: unknown }[];
		};
	}[];
};

const stream = () => {
	throw new Error('No model call.');
};

/** Open a lab on a fresh directory, close it, and run the check. */
async function withDirectory(check: (directory: string) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), 'workbench-config-'));
	try {
		const lab = await openLab({ directory, stream });
		await lab.close();
		await check(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** The parsed lines of `configs.jsonl`. */
async function lines(directory: string): Promise<Line[]> {
	const text = await readFile(join(directory, 'configs.jsonl'), 'utf8');
	return text
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => JSON.parse(line) as Line);
}

/** Every key of a JSON value, at any depth. */
function keys(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(keys);
	if (value === null || typeof value !== 'object') return [];
	return Object.entries(value).flatMap(([key, field]) => [key, ...keys(field)]);
}

const input: ConfigInput = {
	specialists: [],
	people: people,
	limits: { call: { attempts: 3, timeout: Number.POSITIVE_INFINITY }, backoff: () => 1 },
	login: false,
};

describe('configs.jsonl in the data directory', () => {
	it('writes one line with the config of each seat at the first start', async () => {
		await withDirectory(async (directory) => {
			const [line, ...rest] = await lines(directory);
			expect(rest).toEqual([]);
			expect(line?.at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
			expect(line?.hash).toMatch(/^[0-9a-f]{64}$/);
			expect(line?.versions.workbench).toMatch(/^\d+\.\d+\.\d+/);
			expect(Object.keys(line?.versions.ambion ?? {})).toContain('@ambionframework/ambion');
			expect(line?.model.login).toMatch(/^(present|missing)$/);
			expect(line?.workstation).toBeNull();
			expect(line?.limits.values).toHaveProperty('lease');
			expect(line?.people.map(({ name }) => name)).toEqual(people.map(({ name }) => name));
			expect(line?.specialists.map(({ name }) => name)).toEqual(['researcher', 'engineer']);
			for (const { executor } of line?.specialists ?? []) {
				expect(executor.kind).toBe('pi');
				expect(executor.model).toMatch(/\//);
				expect(executor.thinking).toBeTruthy();
				expect(executor.instructions.length).toBeGreaterThan(100);
				expect(executor.respondPolicySource).toBe('definition');
				expect(executor.respondPolicy).not.toBe(DEFAULT_RESPOND_POLICY);
				expect(executor.tools.length).toBeGreaterThan(0);
				for (const tool of executor.tools) {
					expect(tool.name).toBeTruthy();
					expect(tool.description).toBeTruthy();
					expect(tool.parameters).toBeTypeOf('object');
				}
			}
		});
	});

	it('holds no function field and no credential', async () => {
		await withDirectory(async (directory) => {
			const text = await readFile(join(directory, 'configs.jsonl'), 'utf8');
			expect(text).not.toMatch(/apiKey|api_key|"token"|"secret|password|access_token|refresh/i);
			const found = new Set(keys(JSON.parse(text)));
			for (const name of ['invoke', 'execute', 'prepareArguments', 'remind', 'backoff'])
				expect(found.has(name)).toBe(false);
		});
	});

	it('holds the source of no function', async () => {
		const secret = () => 'SOURCE-MARKER-9f2c';
		const ping: AmbionTool = {
			name: 'ping',
			label: 'Ping',
			description: 'Ping.',
			parameters: { type: 'object', properties: { target: { type: 'string' } } } as never,
			invoke: secret,
		};
		const specialist = defineAgent({
			name: 'probe',
			identity: 'A probe.',
			executor: pi({
				instructions: 'Probe.',
				model: 'anthropic/claude-sonnet-4-5',
				bundles: [{ tools: [ping], remind: secret }],
			}),
		});
		const snapshot = await configSnapshot({ ...input, specialists: [specialist] });
		const text = JSON.stringify(snapshot);
		expect(text).not.toContain('SOURCE-MARKER');
		expect(text).toContain('"target"');
		const [probe] = snapshot.specialists as { executor: { reminderCount: number } }[];
		expect(probe?.executor.reminderCount).toBe(1);
	});

	it('adds no line at a restart with the same definitions', async () => {
		await withDirectory(async (directory) => {
			const [first] = await lines(directory);
			const lab = await openLab({ directory, stream });
			await lab.close();
			const all = await lines(directory);
			expect(all).toHaveLength(1);
			expect(all[0]).toEqual(first);
		});
	});

	it('appends a line when the snapshot changes, and when the last line is bad', async () => {
		await withDirectory(async (directory) => {
			const [first] = await lines(directory);
			const changed = { ...input, login: true };
			expect(await writeConfig(directory, changed, new Date('2030-01-01T00:00:00Z'))).toBe(true);
			expect(await writeConfig(directory, changed)).toBe(false);
			const all = await lines(directory);
			expect(all).toHaveLength(2);
			expect(all[1]?.at).toBe('2030-01-01T00:00:00.000Z');
			expect(all[1]?.hash).not.toBe(first?.hash);
			expect(all[1]?.model.login).toBe('present');
			const { at, hash, ...snapshot } = all[1] as Line;
			expect(at).toBeTruthy();
			expect(configHash(snapshot as never)).toBe(hash);
			expect(all[1]?.limits.values).toEqual({ call: { attempts: 3, timeout: 'Infinity' } });
			await writeFile(join(directory, 'configs.jsonl'), '{"hash":');
			expect(await writeConfig(directory, changed)).toBe(true);
		});
	});

	it('starts the file when it is missing', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'workbench-config-'));
		try {
			expect(await writeConfig(directory, input)).toBe(true);
			expect(await lines(directory)).toHaveLength(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe('plain', () => {
	it('drops functions and marks a cycle', () => {
		const loop: Record<string, unknown> = { name: 'a', run: () => 1 };
		loop.self = loop;
		expect(plain({ loop, list: [() => 1, 2], big: 1n, symbol: Symbol('x') })).toEqual({
			loop: { name: 'a', self: '[cycle]' },
			list: [null, 2],
			big: '1',
		});
	});
});
