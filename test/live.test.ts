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
			{ state: 'done', text: '→ read /a', result: '1 line' },
			{ state: 'running', text: 'camera {"shot":1,"fast":true}', result: '' },
		]);
		expect(first?.earlier).toBe(0);
	});

	it('pairs a result that arrives in a later pass than its call', () => {
		const live = running(
			read([call('c1', 'bash', { command: 'sleep 1' })], [result('c1', text('done'))]),
		);
		expect(live?.calls).toEqual([{ state: 'done', text: '$ sleep 1', result: 'done' }]);
	});

	it('keeps the last five calls and counts the earlier ones', () => {
		const steps = Array.from({ length: 8 }, (_, at) =>
			call(`c${at}`, 'bash', { command: `n${at}` }),
		);
		const live = running(read(steps));
		expect(live?.calls.map((one) => one.text)).toEqual(['$ n3', '$ n4', '$ n5', '$ n6', '$ n7']);
		expect(live?.earlier).toBe(3);
	});

	it('shows a tool phrase, the one string of an object input, and JSON for any other input', () => {
		const live = running(
			read([
				call('c1', 'bash', { command: 'psu status', timeout: 5 }),
				call('c2', 'write', { path: '/a', content: 'b' }),
				call('c3', 'list', {}),
				call('c4', 'echo', 'plain'),
			]),
		);
		expect(live?.calls.map((one) => one.text)).toEqual([
			'$ psu status',
			'✎ write /a',
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
		expect(live?.calls[1]).toEqual({ state: 'done', text: '↳ $ ls', result: 'a.txt' });
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
		expect(live?.calls).toEqual([{ state: 'failed', text: '$ x', result: 'failed: port busy' }]);
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

describe('liveActivations with processes', () => {
	const lines = new Map([
		['engineer', [{ name: 'scan', runs: '0:42', line: 'step 2' }]],
		['researcher', [{ name: 'other', runs: '1:00', line: '' }]],
	]);

	it('gives a running activation the lines of the processes of its seat', () => {
		const [live] = liveActivations([activation('a1')], new Map(), undefined, lines);
		expect(live?.processes).toEqual([{ name: 'scan', runs: '0:42', line: 'step 2' }]);
	});

	it('gives an ended activation none, and omits the field when the seat has none', () => {
		const [ended, quiet] = liveActivations(
			[activation('a1', { kind: 'released' }), activation('a2', undefined, { seat: 'design' })],
			new Map(),
			undefined,
			lines,
		);
		expect(ended).not.toHaveProperty('processes');
		expect(quiet).not.toHaveProperty('processes');
	});
});

describe('liveActivations header of a running activation', () => {
	const said = (type: 'thinking' | 'text', value: string) => ({ type, text: value, final: true });

	it('shows the phrase of the call that has no result', () => {
		const live = running(
			read([
				call('c1', 'read', { path: '/a' }),
				result('c1', text('x')),
				call('c2', 'bash', { command: 'psu set 3.3 0.05\nsecond' }),
			]),
		);
		expect(live?.step).toBe('$ psu set 3.3 0.05');
		expect(live?.title).toBe('engineer · respond');
	});

	it('prefers the newest call that has no result, across passes', () => {
		const live = running(
			read(
				[call('c1', 'sql', { sql: 'select 1' }), said('thinking', 'later')],
				[call('c2', 'fetch', { process: 'bench', path: '/t' })],
			),
		);
		expect(live?.step).toBe('⇄ fetch bench /t');
	});

	it('shows the first line of the newest thinking or text when every call has a result', () => {
		const live = running(
			read([
				said('thinking', 'Consider the load.\nSecond line.'),
				call('c1', 'read', { path: '/a' }),
				result('c1', text('x')),
				said('thinking', 'Check the supply limit.\nMore.'),
			]),
		);
		expect(live?.step).toBe('Check the supply limit.');
		const spoken = running(
			read([said('thinking', 'idea'), said('text', '\n  Setting 3.3 V\nthen more')]),
		);
		expect(spoken?.step).toBe('Setting 3.3 V');
	});

	it('cuts a long step, and leaves the step out before the first one', () => {
		expect(running(read([said('text', 'x'.repeat(300))]))?.step).toHaveLength(100);
		expect(running(read([said('thinking', '  \n ')]))).not.toHaveProperty('step');
		expect(running(read([]))).not.toHaveProperty('step');
		expect(liveActivations([activation('a1')], new Map())[0]).not.toHaveProperty('step');
	});

	it('shows no step on an ended activation', () => {
		const ended = activation('a1', { kind: 'released' });
		const [live] = liveActivations([ended], read([said('text', 'done')]));
		expect(live).not.toHaveProperty('step');
	});
});

describe('liveActivations of an ended activation', () => {
	const at = (step: Record<string, unknown>, time: string) => ({ ...step, at: time });
	const stamped = (...times: [Record<string, unknown>, string][]) =>
		read(...times.map(([step, time]) => [at(step, time)]));
	const released = (extra: Record<string, unknown> = {}) =>
		activation('a1', { kind: 'released' }, extra);

	it('folds to a title with the calls, the duration, and the cost', () => {
		const reads = stamped(
			[call('c1', 'bash', { command: 'x' }), '2026-01-01T00:00:00Z'],
			[result('c1', text('ok')), '2026-01-01T00:00:05Z'],
			[call('c2', 'read', { path: '/a' }), '2026-01-01T00:00:30Z'],
			[call('c3', 'read', { path: '/b' }), '2026-01-01T00:00:31Z'],
			[{ type: 'end', stop: 'stopped' }, '2026-01-01T00:00:42Z'],
		);
		const [live] = liveActivations([released({ usage: usage({ cost: 0.0123 }) })], reads);
		expect(live).toEqual({
			id: 'a1',
			state: 'done',
			title: 'engineer · respond · 3 calls · 0:42 · $0.0123',
			calls: [],
			earlier: 0,
		});
	});

	it('puts the attempt before the counts, and the reason after them', () => {
		const reads = stamped(
			[call('c1', 'bash', { command: 'x' }), '2026-01-01T00:00:00Z'],
			[{ type: 'end', stop: 'cut' }, '2026-01-01T01:02:03Z'],
		);
		const failed = activation('a1', { kind: 'failed', cause: 'transient' }, { attempt: 2 });
		const [live] = liveActivations([failed], reads, new Map([['a1', 'rate limit']]));
		expect(live).toMatchObject({
			state: 'failed',
			title: 'engineer · respond · attempt 2 · 1 call · 1:02:03: rate limit',
		});
	});

	it('leaves out the parts that are zero or unknown', () => {
		const quick = stamped(
			[call('c1', 'bash', { command: 'x' }), '2026-01-01T00:00:00.000Z'],
			[{ type: 'end', stop: 'stopped' }, '2026-01-01T00:00:00.900Z'],
		);
		expect(liveActivations([released()], quick)[0]?.title).toBe('engineer · respond · 1 call');
		const none = stamped([{ type: 'end', stop: 'stopped' }, '2026-01-01T00:00:00Z']);
		expect(liveActivations([released()], none)[0]?.title).toBe('engineer · respond');
		expect(liveActivations([released()], read([]))[0]?.title).toBe('engineer · respond');
		const noTime = read([call('c1', 'bash', { command: 'x' })]);
		expect(liveActivations([released()], noTime)[0]?.title).toBe('engineer · respond · 1 call');
		expect(liveActivations([released()], new Map())[0]?.title).toBe('engineer · respond');
	});

	it('shows the tokens when the usage holds no cost', () => {
		const [live] = liveActivations([released({ usage: usage({ input: 9000 }) })], new Map());
		expect(live?.title).toBe('engineer · respond · 9.0k tokens');
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
