import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { people, team } from '../src/domain/definitions.ts';
import { describeUnavailable, hasLogin, codexModel, seatFamilies } from '../src/domain/families.ts';
import { type Lab, openLab } from '../src/host/host.ts';
import { buildTimeline } from '../src/view/timeline.ts';

describe('Workbench executor families', () => {
	it('puts every seat on Codex', () => {
		expect(seatFamilies).toEqual({
			assistant: 'codex',
			datasheets: 'codex',
			experiments: 'codex',
			instruments: 'codex',
			builder: 'codex',
		});
	});

	it('defaults to gpt-6-luna and accepts Codex model identifiers', () => {
		expect(codexModel({})).toBe('gpt-6-luna');
		expect(codexModel({ WORKBENCH_MODEL: 'gpt-6-sol' })).toBe('gpt-6-sol');
		expect(() => codexModel({ WORKBENCH_MODEL: 'openai/gpt-6-luna' })).toThrow(/provider prefix/);
		expect(() => codexModel({ WORKBENCH_MODEL: 'anthropic' })).toThrow(/preset/);
	});

	it('accepts a Codex key and reports missing login files', () => {
		expect(describeUnavailable({ CODEX_API_KEY: 'k' })).toEqual([]);
		expect(hasLogin({ HOME: '/nonexistent-workbench-home' })).toBe(false);
		expect(describeUnavailable({ HOME: '/nonexistent-workbench-home' })).toHaveLength(5);
		expect(describeUnavailable({ HOME: '/nonexistent-workbench-home' })[0]).toContain(
			'codex login',
		);
	});

	it('finds the host login and respects the execution login options', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'workbench-login-'));
		try {
			const login = join(directory, '.codex', 'auth.json');
			await mkdir(join(directory, '.codex'));
			await writeFile(login, '{}');
			expect(hasLogin({ HOME: directory })).toBe(true);
			expect(hasLogin({ HOME: directory }, { login: false })).toBe(false);
			expect(hasLogin({ HOME: directory }, { login })).toBe(true);
			expect(hasLogin({ HOME: '/missing' }, { env: { HOME: directory } })).toBe(true);
			expect(
				hasLogin(
					{ HOME: directory, CODEX_API_KEY: 'test' },
					{ env: { CODEX_API_KEY: undefined }, login: false },
				),
			).toBe(false);
			expect(hasLogin({ HOME: '/missing', CODEX_HOME: join(directory, '.codex') })).toBe(true);
			expect(hasLogin({ HOME: directory }, { login: directory })).toBe(false);
			const home = join(directory, 'seat-home');
			await mkdir(home);
			await writeFile(join(home, 'auth.json'), '{}');
			expect(hasLogin({ HOME: '/missing' }, { home, login: false })).toBe(true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('gives every specialist the Codex executor, on the model WORKBENCH_MODEL selects', async () => {
		const workspace = { tools: () => ({ name: 'workspace', guidance: '', tools: [] }) } as never;
		const built = await team(workspace, undefined, { WORKBENCH_MODEL: 'gpt-6-luna' });
		expect(built.assistant.executor).toMatchObject({
			kind: 'codex',
			model: 'gpt-6-luna',
			modelReasoningEffort: 'low',
		});
		expect(built.assistant.executor.guidance).toContain('This is a respond activation.');
		expect(built.assistant.executor.instructions).toContain('preserve evidence');
		const executors = Object.fromEntries(
			built.specialists.map((seat) => [seat.name, seat.executor]),
		);
		for (const name of ['datasheets', 'experiments', 'instruments', 'builder']) {
			expect(executors[name], name).toMatchObject({
				kind: 'codex',
				model: 'gpt-6-luna',
				modelReasoningEffort: 'low',
			});
		}
	});
});

describe('Workbench Codex login and failures', () => {
	const opened: { lab: Lab; directory: string }[] = [];
	const person = people[0]?.name ?? '';

	afterEach(async () => {
		vi.unstubAllEnvs();
		for (const { lab, directory } of opened.splice(0)) {
			await lab.close().catch(() => undefined);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each(['snapshot', 'host'])(
		'links the host login with a %s environment and reports a catalog failure',
		async (environment) => {
			vi.stubEnv('WORKBENCH_TEST_SECRET', 'host-only');
			vi.stubEnv('WORKBENCH_MODEL', 'gpt-6-luna');
			const directory = await mkdtemp(join(tmpdir(), 'workbench-codex-offline-'));
			const hostHome = join(directory, 'host');
			const codexHome = join(directory, 'seats');
			const login = join(hostHome, '.codex', 'auth.json');
			const binary = join(directory, 'fake-codex.mjs');
			const log = join(directory, 'catalog.json');
			await mkdir(join(hostHome, '.codex'), { recursive: true });
			await writeFile(login, '{}');
			// The executable has no network code. It only serves an empty model catalog.
			await writeFile(
				binary,
				`#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME, codexHome: process.env.CODEX_HOME, secret: process.env.WORKBENCH_TEST_SECRET ?? null }));
if (process.argv.slice(2).join(' ') !== 'debug models') process.exit(1);
process.stdout.write(JSON.stringify({ models: [] }));
`,
				{ mode: 0o700 },
			);
			const lab = await openLab({
				directory: join(directory, 'run'),
				env:
					environment === 'snapshot'
						? { HOME: hostHome, WORKBENCH_MODEL: 'gpt-6-luna' }
						: undefined,
				codex: {
					codexPath: binary,
					home: codexHome,
					env: {
						HOME: hostHome,
						CODEX_HOME: undefined,
						CODEX_API_KEY: undefined,
						OPENAI_API_KEY: undefined,
					},
				},
			});
			opened.push({ lab, directory });
			expect((await lab.read('radio-kit', 0)).unavailable).toEqual([]);
			await lab.join('radio-kit', person);
			await lab.send('radio-kit', person, 'catalog-1', 'Plan a test.');
			await vi.waitFor(async () => {
				const view = await lab.read('radio-kit', 0);
				expect(
					view.activity
						.filter((item) => item.type === 'error')
						.map((item) => item.text)
						.join(' '),
				).toContain("The model 'gpt-6-luna' has no entry in the Codex catalog");
				expect(view.status).toBe('running');
			});
			expect(await readlink(join(codexHome, 'auth.json'))).toBe(login);
			expect(JSON.parse(await readFile(log, 'utf8'))).toEqual({
				args: ['debug', 'models'],
				home: join(codexHome, 'home'),
				codexHome,
				secret: null,
			});
		},
	);

	it('marks every seat, fails an activation with the missing login, and keeps the room running', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'workbench-nokey-'));
		const lab = await openLab({ directory: join(directory, 'run'), env: { HOME: directory } });
		opened.push({ lab, directory });
		expect((await lab.read('radio-kit', 0)).unavailable).toEqual([
			'assistant',
			'datasheets',
			'experiments',
			'instruments',
			'builder',
		]);
		await lab.join('radio-kit', person);
		await lab.send('radio-kit', person, 'nokey-1', 'Plan a test.');
		await vi.waitFor(async () => {
			const view = await lab.read('radio-kit', 0);
			const errors = view.activity.filter((item) => item.type === 'error');
			expect(errors.map((item) => item.text).join('\n')).toContain(
				"Seat 'assistant' cannot run: Codex needs CODEX_API_KEY",
			);
			expect(view.status).toBe('running');
		});
		// The exchange closes on the failure. The note gives the last failure and its reason.
		await vi.waitFor(async () => {
			const view = await lab.read('radio-kit', 0);
			const closed = view.exchanges.find((exchange) => exchange.status === 'closed');
			expect(closed).toMatchObject({ outcome: { kind: 'exhausted' } });
			const blocks = buildTimeline({
				messages: view.messages,
				exchanges: view.exchanges,
				humans: new Set([person]),
				working: [],
				expanded: new Set(),
				failures: view.failures,
			});
			expect(blocks).toContainEqual({
				type: 'note',
				text: expect.stringMatching(
					/^Closed, (\S+) failed, the room does not retry this: Seat '\1' cannot run: Codex needs CODEX_API_KEY/,
				),
			});
		});
	});
});
