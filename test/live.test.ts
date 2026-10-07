import type { ExchangeActivation, Usage } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { liveActivations } from '../src/view/live.ts';
import type { ActivationSteps } from '../src/view/steps.ts';

const usage = (extra: Partial<Usage> = {}): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	...extra,
});

const activation = (
	id: string,
	outcome: Record<string, unknown> = { kind: 'running' },
	extra: Record<string, unknown> = {},
): ExchangeActivation =>
	({
		id,
		seat: 'engineer',
		attempt: 1,
		purpose: 'respond',
		outcome,
		...extra,
	}) as ExchangeActivation;

const call = (id: string, name: string, input: unknown, parent?: string) => ({
	type: 'tool_call',
	call: id,
	name,
	input,
	...(parent ? { parent } : {}),
});
const result = (id: string, output: unknown, error?: string, parent?: string) => ({
	type: 'tool_result',
	call: id,
	output,
	...(error ? { error } : {}),
	...(parent ? { parent } : {}),
});
const text = (value: string) => ({ content: [{ type: 'text', text: value }] });

/** One read with one pass for each list of steps. */
const read = (...passes: Record<string, unknown>[][]): ReadonlyMap<string, ActivationSteps> =>
	new Map([
		[
			'a1',
			{
				activation: 'a1',
				passes: passes.map((steps, at) => ({
					pass: at + 1,
					input: 'view',
					through: 4,
					steps: [{ type: 'pass', pass: at + 1, input: 'view', through: 4 }, ...steps],
				})),
			} as unknown as ActivationSteps,
		],
	]);

const running = (reads: ReadonlyMap<string, ActivationSteps>) =>
	liveActivations([activation('a1')], reads)[0];

describe('liveActivations of a running activation', () => {
	it('pairs each call with its result, across passes', () => {
		const first = running(
			read(
				[call('c1', 'read', { path: '/a' }), result('c1', 'ok')],
				[call('c2', 'camera', { shot: 1, fast: true })],
			),
		);
		expect(first).toMatchObject({ id: 'a1', state: 'running', title: 'engineer · respond' });
		expect(first?.calls).toEqual([
			{ state: 'done', text: 'read /a', result: 'ok' },
			{ state: 'running', text: 'camera {"shot":1,"fast":true}', result: '' },
		]);
		expect(first?.earlier).toBe(0);
	});

	it('pairs a result that arrives in a later pass than its call', () => {
		const live = running(
			read([call('c1', 'bash', { command: 'sleep 1' })], [result('c1', text('done'))]),
		);
		expect(live?.calls).toEqual([{ state: 'done', text: 'bash sleep 1', result: 'done' }]);
	});

	it('keeps the last five calls and counts the earlier ones', () => {
		const steps = Array.from({ length: 8 }, (_, at) =>
			call(`c${at}`, 'bash', { command: `n${at}` }),
		);
		const live = running(read(steps));
		expect(live?.calls.map((one) => one.text)).toEqual([
			'bash n3',
			'bash n4',
			'bash n5',
			'bash n6',
			'bash n7',
		]);
		expect(live?.earlier).toBe(3);
	});

	it('shows the one string of an object input, and JSON for any other input', () => {
		const live = running(
			read([
				call('c1', 'bash', { command: 'psu status', timeout: 5 }),
				call('c2', 'write', { path: '/a', content: 'b' }),
				call('c3', 'list', {}),
				call('c4', 'echo', 'plain'),
			]),
		);
		expect(live?.calls.map((one) => one.text)).toEqual([
			'bash psu status',
			'write {"path":"/a","content":"b"}',
			'list {}',
			'echo plain',
		]);
	});

	it('marks a nested call', () => {
		const live = running(
			read([
				call('c1', 'compose', { script: 'x' }),
				call('c2', 'bash', { command: 'ls' }, 'c1'),
				result('c2', text('a.txt'), undefined, 'c1'),
			]),
		);
		expect(live?.calls[1]).toEqual({ state: 'done', text: '↳ bash ls', result: 'a.txt' });
	});

	it('shows the first non-empty line of the first text item of a result', () => {
		const output = { content: [{ type: 'image' }, { type: 'text', text: '\n  \n0.00 V\nline 2' }] };
		const live = running(read([call('c1', 'bash', { command: 'x' }), result('c1', output)]));
		expect(live?.calls[0]?.result).toBe('0.00 V');
	});

	it('falls back to the render of an output without text items', () => {
		const live = running(read([call('c1', 'read', {}), result('c1', { value: 3 })]));
		expect(live?.calls[0]?.result).toBe('{"value":3}');
	});

	it('shows an error as a failed call', () => {
		const live = running(
			read([call('c1', 'bash', { command: 'x' }), result('c1', null, 'port busy\nmore')]),
		);
		expect(live?.calls).toEqual([{ state: 'failed', text: 'bash x', result: 'failed: port busy' }]);
	});

	it('shows no calls for an activation that has no read yet', () => {
		expect(liveActivations([activation('a1')], new Map())).toEqual([
			{ id: 'a1', state: 'running', title: 'engineer · respond', calls: [], earlier: 0 },
		]);
	});

	it('adds the attempt after the first', () => {
		const [live] = liveActivations([activation('a1', undefined, { attempt: 2 })], new Map());
		expect(live?.title).toBe('engineer · respond · attempt 2');
	});
});

describe('liveActivations of an ended activation', () => {
	it('folds to a title with the cost', () => {
		const ended = activation('a1', { kind: 'released' }, { usage: usage({ cost: 0.0012 }) });
		const [live] = liveActivations([ended], read([call('c1', 'bash', { command: 'x' })]));
		expect(live).toEqual({
			id: 'a1',
			state: 'done',
			title: 'engineer · respond · $0.0012',
			calls: [],
			earlier: 0,
		});
	});

	it('counts a cancelled activation as done', () => {
		const ended = activation('a1', { kind: 'released', cancelled: true });
		expect(liveActivations([ended], new Map())[0]).toMatchObject({ state: 'done' });
	});

	it('fails with the reason when the failures hold one', () => {
		const failed = activation('a1', { kind: 'failed', cause: 'transient' }, { attempt: 2 });
		const abandoned = activation('a2', { kind: 'abandoned', cause: 'permanent' });
		const live = liveActivations([failed, abandoned], new Map(), new Map([['a1', 'rate limit']]));
		expect(live.map(({ state, title }) => ({ state, title }))).toEqual([
			{ state: 'failed', title: 'engineer · respond · attempt 2: rate limit' },
			{ state: 'failed', title: 'engineer · respond' },
		]);
	});

	it('keeps every running activation and the last three ended ones, in order', () => {
		const list = [
			activation('e1', { kind: 'released' }),
			activation('e2', { kind: 'released' }),
			activation('r1'),
			activation('e3', { kind: 'released' }),
			activation('e4', { kind: 'released' }),
			activation('r2'),
		];
		expect(liveActivations(list, new Map()).map((one) => one.id)).toEqual([
			'e2',
			'r1',
			'e3',
			'e4',
			'r2',
		]);
	});
});
