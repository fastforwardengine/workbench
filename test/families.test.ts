import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { team } from '../src/domain/definitions.ts';
import { describeUnavailable, keyVariable, piModel, seatFamilies } from '../src/domain/families.ts';
import { type Lab, openLab } from '../src/host/host.ts';

describe('Workbench executor families', () => {
	it('puts every seat on Pi', () => {
		expect(seatFamilies).toEqual({
			assistant: 'pi',
			datasheets: 'pi',
			design: 'pi',
			experiments: 'pi',
			instruments: 'pi',
			'data-analysis': 'pi',
		});
	});

	it('switches the model between the anthropic and openai presets', () => {
		expect(piModel({})).toBe('anthropic/claude-sonnet-5');
		expect(piModel({ WORKBENCH_MODEL: 'anthropic' })).toBe('anthropic/claude-sonnet-5');
		expect(piModel({ WORKBENCH_MODEL: 'openai' })).toBe('openai/gpt-5.6-luna');
		// Any other value passes through as a full Pi model id.
		expect(piModel({ WORKBENCH_MODEL: 'openai-codex/gpt-5' })).toBe('openai-codex/gpt-5');
	});

	it('names the key of the model WORKBENCH_MODEL selects', () => {
		expect(keyVariable('pi', {})).toBe('ANTHROPIC_API_KEY');
		expect(keyVariable('pi', { WORKBENCH_MODEL: 'openai' })).toBe('OPENAI_API_KEY');
		expect(keyVariable('pi', { WORKBENCH_MODEL: 'openai-codex/gpt-5' })).toBe(
			'OPENAI_CODEX_API_KEY',
		);
	});

	it('says which seat cannot run and why, and lists only the seats without a key', () => {
		expect(describeUnavailable({ ANTHROPIC_API_KEY: 'k' })).toEqual([]);
		expect(describeUnavailable({ WORKBENCH_MODEL: 'openai', OPENAI_API_KEY: 'k' })).toEqual([]);
		expect(describeUnavailable({})).toHaveLength(6);
		expect(describeUnavailable({})[0]).toBe(
			"Seat 'assistant' cannot run: ANTHROPIC_API_KEY is not set, and the pi family needs it.",
		);
	});

	it('gives every specialist the Pi executor, on the model WORKBENCH_MODEL selects', () => {
		const bundle = (name: string) =>
			({ tools: () => ({ name, guidance: '', tools: [] }) }) as never;
		const built = team(bundle('workspace'), bundle('lab'), bundle('instrument'));
		expect(built.assistant.executor).toMatchObject({ kind: 'pi', model: piModel() });
		const executors = Object.fromEntries(
			built.specialists.map((seat) => [seat.name, seat.executor]),
		);
		for (const name of ['datasheets', 'design', 'experiments', 'instruments', 'data-analysis']) {
			expect(executors[name], name).toMatchObject({ kind: 'pi', model: piModel() });
		}
	});
});

describe('Workbench with no key', () => {
	const opened: { lab: Lab; directory: string }[] = [];

	afterEach(async () => {
		for (const { lab, directory } of opened.splice(0)) {
			await lab.close().catch(() => undefined);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('marks every seat, fails an activation with the missing key, and keeps the room running', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'workbench-nokey-'));
		const lab = await openLab({ directory: join(directory, 'run'), env: {} });
		opened.push({ lab, directory });
		expect((await lab.read('cycling', 0)).unavailable).toEqual([
			'assistant',
			'datasheets',
			'design',
			'experiments',
			'instruments',
			'data-analysis',
		]);
		await lab.join('cycling', 'noor');
		await lab.send('cycling', 'noor', 'nokey-1', 'Plan a test.');
		await vi.waitFor(async () => {
			const view = await lab.read('cycling', 0);
			const errors = view.activity.filter((item) => item.type === 'error');
			expect(errors.map((item) => item.text).join('\n')).toContain(
				"Seat 'assistant' cannot run: ANTHROPIC_API_KEY is not set",
			);
			expect(view.status).toBe('running');
		});
	});
});
