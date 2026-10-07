import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { people, team } from '../src/domain/definitions.ts';
import {
	keyVariable,
	missingLogin,
	modelHasLogin,
	piCredentialsPath,
	piModel,
} from '../src/domain/model.ts';
import { type Lab, openLab } from '../src/host/host.ts';
import { buildTimeline } from '../src/view/timeline.ts';

/** An environment whose credential file does not exist, so no test reads the real home. */
const none = { HOME: '/nonexistent', WORKBENCH_PI_CREDENTIALS: '/nonexistent/credentials.json' };

describe('Workbench model', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('switches the model between the anthropic, openai, chatgpt, and luna presets', () => {
		expect(piModel({ ...none })).toBe('anthropic/claude-sonnet-4-5');
		expect(piModel({ ...none, WORKBENCH_MODEL: 'anthropic' })).toBe('anthropic/claude-sonnet-4-5');
		expect(piModel({ ...none, WORKBENCH_MODEL: 'openai' })).toBe('openai/gpt-6.1-sol');
		expect(piModel({ ...none, WORKBENCH_MODEL: 'chatgpt' })).toBe('openai-codex/gpt-6.1-sol');
		expect(piModel({ ...none, WORKBENCH_MODEL: 'luna' })).toBe('openai-codex/gpt-6-luna');
		// Any other value passes through as a full Pi model id.
		expect(piModel({ ...none, WORKBENCH_MODEL: 'openai-codex/gpt-5' })).toBe('openai-codex/gpt-5');
	});

	it('names the key of the model WORKBENCH_MODEL selects', () => {
		expect(keyVariable(none)).toBe('ANTHROPIC_API_KEY');
		expect(keyVariable({ ...none, WORKBENCH_MODEL: 'openai' })).toBe('OPENAI_API_KEY');
		expect(keyVariable({ ...none, WORKBENCH_MODEL: 'openai-codex/gpt-5' })).toBe(
			'OPENAI_CODEX_API_KEY',
		);
	});

	it('gives the reason and the fix when the model has no login', () => {
		expect(missingLogin({ ...none, ANTHROPIC_API_KEY: 'k' })).toBeUndefined();
		expect(
			missingLogin({ ...none, WORKBENCH_MODEL: 'openai', OPENAI_API_KEY: 'k' }),
		).toBeUndefined();
		expect(missingLogin(none)).toBe(
			'The model anthropic/claude-sonnet-4-5 has no login. Set ANTHROPIC_API_KEY in the environment or in .env, or run `workbench login` for ChatGPT.',
		);
		expect(missingLogin({ ...none, WORKBENCH_MODEL: 'chatgpt' })).toBe(
			'The model openai-codex/gpt-6.1-sol has no login. Run `workbench login`.',
		);
	});

	it('defaults the credential file to a path under the home directory', () => {
		expect(piCredentialsPath({ HOME: '/home/someone' })).toBe(
			'/home/someone/.ambion/pi/credentials.json',
		);
		expect(
			piCredentialsPath({ HOME: '/home/someone', WORKBENCH_PI_CREDENTIALS: '/x/c.json' }),
		).toBe('/x/c.json');
	});

	describe('with a credential file', () => {
		let directory = '';
		const envWith = async (content: string | undefined, extra: Record<string, string> = {}) => {
			const path = join(directory, 'credentials.json');
			if (content !== undefined) await writeFile(path, content);
			return { HOME: directory, WORKBENCH_PI_CREDENTIALS: path, ...extra };
		};

		beforeEach(async () => {
			directory = await mkdtemp(join(tmpdir(), 'workbench-credentials-'));
		});
		afterEach(() => rm(directory, { recursive: true, force: true }));

		it('defaults to the chatgpt model after a ChatGPT sign-in', async () => {
			const env = await envWith(JSON.stringify({ 'openai-codex': { type: 'oauth' } }));
			expect(piModel(env)).toBe('openai-codex/gpt-6.1-sol');
			expect(modelHasLogin(piModel(env), env)).toBe(true);
			expect(missingLogin(env)).toBeUndefined();
		});

		it('lets WORKBENCH_MODEL win over the sign-in', async () => {
			const env = await envWith(JSON.stringify({ 'openai-codex': { type: 'oauth' } }), {
				WORKBENCH_MODEL: 'anthropic',
			});
			expect(piModel(env)).toBe('anthropic/claude-sonnet-4-5');
			expect(modelHasLogin(piModel(env), env)).toBe(false);
		});

		it('keeps the anthropic default when the file holds another provider', async () => {
			const env = await envWith(JSON.stringify({ anthropic: { type: 'oauth' } }));
			expect(piModel(env)).toBe('anthropic/claude-sonnet-4-5');
			expect(modelHasLogin(piModel(env), env)).toBe(true);
		});

		it('counts a sign-in for the provider of an explicit model as a login', async () => {
			const env = await envWith(JSON.stringify({ openai: { type: 'oauth' } }), {
				WORKBENCH_MODEL: 'openai',
			});
			expect(modelHasLogin(piModel(env), env)).toBe(true);
		});

		it.each([
			['a missing file', undefined],
			['invalid JSON', '{not json'],
			['a JSON array', '[]'],
			['a JSON null', 'null'],
			['an empty entry', JSON.stringify({ 'openai-codex': null })],
		])('treats %s as no sign-in, and does not throw', async (_name, content) => {
			const env = await envWith(content);
			expect(piModel(env)).toBe('anthropic/claude-sonnet-4-5');
			expect(modelHasLogin(piModel(env), env)).toBe(false);
		});
	});

	it('gives every specialist and the worker the Pi executor, on the model WORKBENCH_MODEL selects', async () => {
		vi.stubEnv('WORKBENCH_PI_CREDENTIALS', none.WORKBENCH_PI_CREDENTIALS);
		const workspace = { tools: () => ({ name: 'workspace', guidance: '', tools: [] }) } as never;
		const built = await team(workspace);
		const executors = Object.fromEntries(
			[...built.specialists, built.worker].map((seat) => [seat.name, seat.executor]),
		);
		for (const name of ['researcher', 'engineer', 'worker']) {
			expect(executors[name], name).toMatchObject({
				kind: 'pi',
				model: piModel(),
				thinking: 'low',
			});
		}
	});
});

describe('Workbench with no login', () => {
	const opened: { lab: Lab; directory: string }[] = [];
	const person = people[0]?.name ?? '';

	afterEach(async () => {
		for (const { lab, directory } of opened.splice(0)) {
			await lab.close().catch(() => undefined);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('marks every seat, fails an activation with the missing login, and keeps the room running', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'workbench-nologin-'));
		const lab = await openLab({ directory: join(directory, 'run'), env: none });
		opened.push({ lab, directory });
		expect((await lab.read('build', 0)).unavailable).toEqual(['researcher', 'engineer', 'worker']);
		await lab.join('build', person);
		await lab.send('build', person, 'nologin-1', 'Plan a test.');
		await vi.waitFor(async () => {
			const view = await lab.read('build', 0);
			const errors = view.activity.filter((item) => item.type === 'error');
			expect(errors.map((item) => item.text).join('\n')).toContain(
				"Seat 'engineer' cannot run: The model anthropic/claude-sonnet-4-5 has no login",
			);
			expect(view.status).toBe('running');
		});
		// The exchange closes on the failure, and the note names the seat that failed, with its reason.
		await vi.waitFor(async () => {
			const view = await lab.read('build', 0);
			const closed = view.exchanges.find((exchange) => exchange.status === 'closed');
			expect(closed).toMatchObject({ outcome: { kind: 'exhausted' } });
			const blocks = buildTimeline({
				messages: view.messages,
				exchanges: view.exchanges,
				humans: new Set([person]),
				failures: view.failures,
			});
			expect(blocks).toContainEqual({
				type: 'note',
				text: expect.stringMatching(
					/^Closed, (\S+) failed, the room does not retry this: Seat '\1' cannot run: The model \S+ has no login/,
				),
			});
		});
	});
});
