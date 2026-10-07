import type { Exchange, Message } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import type { LiveActivation } from '../src/view/live.ts';
import { type Block, buildTimeline } from '../src/view/timeline.ts';

const AT = '2026-01-01T00:00:00Z';
const said = (seq: number, from: string, to?: string): Message =>
	({ seq, kind: 'said', from, to, text: `${from} ${seq}`, at: AT }) as Message;
const arrived = (seq: number): Message =>
	({ seq, kind: 'arrived', subject: 'noor', at: AT }) as Message;
const closedExchange = (from: number, through: number, extra: object = {}): Exchange =>
	({
		from,
		through,
		status: 'closed',
		activations: [],
		outcome: { kind: 'complete' },
		person: 'noor',
		at: AT,
		summary: { kind: 'silent' },
		...extra,
	}) as Exchange;

const humans = new Set(['noor', 'priya']);
const build = (
	messages: Message[],
	exchanges: Exchange[],
	extra: Partial<Parameters<typeof buildTimeline>[0]> = {},
) =>
	buildTimeline({
		messages,
		exchanges,
		humans,
		...extra,
	});

const shape = (blocks: Block[]) =>
	blocks.map((block) =>
		block.type === 'message' ? `${block.role}:${block.message.seq}` : block.type,
	);

// The cycling room's exchange: a person answers a specialist inside the exchange.
const thread = [
	said(98, 'noor'),
	said(102, 'engineer', 'researcher'),
	said(121, 'researcher', 'noor'),
	said(125, 'noor'),
	said(128, 'engineer', 'researcher'),
	said(134, 'researcher'),
];
const closed = closedExchange(98, 134);

describe('buildTimeline', () => {
	it('shows every message of a closed exchange in the open, in order', () => {
		const blocks = build(thread, [closed]);
		expect(shape(blocks)).toEqual([
			'question:98',
			'said:102',
			'said:121',
			'question:125',
			'said:128',
			'said:134',
		]);
	});

	it('shows one reply of a closed exchange with no note', () => {
		const messages = [said(59, 'priya'), said(61, 'engineer', 'priya')];
		expect(shape(build(messages, [closedExchange(59, 61, { person: 'priya' })]))).toEqual([
			'question:59',
			'said:61',
		]);
	});

	it('shows a returned say as the opening of its own exchange, and the answer after it', () => {
		const scheduled = { ...said(61, 'agent', 'agent'), delaySeconds: 600 } as Message;
		const returned = {
			seq: 70,
			kind: 'posted',
			to: 'agent',
			returns: 61,
			text: 'Check the build.',
			at: AT,
		} as Message;
		const messages = [said(59, 'noor'), scheduled, returned, said(72, 'agent', 'noor')];
		const exchanges = [closedExchange(59, 61), closedExchange(70, 72)];
		expect(shape(build(messages, exchanges))).toEqual([
			'question:59',
			'said:61',
			'posted:70',
			'said:72',
		]);
	});

	it('marks a scheduled say that a dismissal names', () => {
		const scheduled = { ...said(61, 'agent', 'agent'), delaySeconds: 600 } as Message;
		const dismissed = { seq: 62, kind: 'dismissed', message: 61, at: AT } as Message;
		const blocks = build(
			[said(59, 'noor'), scheduled, dismissed, said(63, 'agent')],
			[closedExchange(59, 63)],
		);
		expect(blocks.map((block) => block.type === 'message' && block.dismissed)).toEqual([
			undefined,
			true,
			undefined,
		]);
	});

	it('adds no note to a closed exchange that ended without a reply', () => {
		const blocks = build([said(75, 'noor')], [closedExchange(75, 75, { person: 'noor' })]);
		expect(shape(blocks)).toEqual(['question:75']);
	});

	it('adds no note to a closed exchange that a person cancelled', () => {
		const blocks = build(
			[said(4, 'priya'), said(9, 'priya')],
			[closedExchange(4, 9, { outcome: { kind: 'cancelled' } })],
		);
		expect(shape(blocks)).toEqual(['question:4', 'question:9']);
	});

	describe('a failed activation', () => {
		const attempt = (
			id: string,
			purpose: string,
			status: string,
			cause: string,
			attempt = 1,
		): object => ({ id, seat: 'engineer', purpose, attempt, outcome: { kind: status, cause } });
		const limit = '400 invalid_request_error: You have reached your specified API usage limits.';
		const failures = new Map([['m1', limit]]);
		const exhausted = (activations: object[]) =>
			closedExchange(75, 75, { person: 'theo', outcome: { kind: 'exhausted' }, activations });

		it.each([
			[
				'names the seat the room gave up on, that it does not retry, and why',
				exhausted([
					attempt('m1', 'respond', 'failed', 'permanent'),
					attempt('m2', 'respond', 'abandoned', 'permanent', 2),
				]),
				failures,
				`Closed, engineer failed, the room does not retry this: ${limit}`,
			],
			[
				'counts the attempts of a transient failure',
				exhausted([attempt('m3', 'respond', 'failed', 'transient', 3)]),
				failures,
				'Closed, engineer failed, after 3 attempts',
			],
			[
				'keeps the plain line when this process heard no reason',
				exhausted([attempt('m1', 'respond', 'failed', 'permanent')]),
				undefined,
				'Closed, engineer failed, the room does not retry this',
			],
		])('%s', (_what, exchange, known, text) => {
			const blocks = build([said(75, 'theo')], [exchange], { failures: known });
			expect(blocks[1]).toMatchObject({ type: 'note', text });
		});

		it('puts the note after the last message of the exchange, and before the next one', () => {
			const exchange = exhausted([attempt('m1', 'respond', 'failed', 'permanent')]);
			const messages = [said(75, 'noor'), said(80, 'noor')];
			expect(shape(build(messages, [{ ...exchange, through: 78 } as Exchange]))).toEqual([
				'question:75',
				'note',
				'question:80',
			]);
		});
	});

	it('keeps the open exchange in the open, and ends with a live block', () => {
		const live: LiveActivation[] = [
			{ id: 'a1', state: 'running', title: 'engineer · respond', calls: [], earlier: 0 },
		];
		const messages = [said(4, 'priya'), said(6, 'engineer', 'researcher'), said(9, 'priya')];
		const open: Exchange = {
			from: 4,
			status: 'open',
			person: 'priya',
			at: AT,
			activations: [],
		};
		const blocks = build(messages, [open], {
			open: { person: 'priya' },
			live,
		});
		expect(shape(blocks)).toEqual(['question:4', 'said:6', 'question:9', 'live']);
		expect(blocks.at(-1)).toEqual({
			type: 'live',
			text: 'Working on priya’s question',
			activations: live,
			detail: undefined,
		});
	});

	it('words the live block for the room when the exchange has no person', () => {
		const open: Exchange = { from: 4, status: 'open', at: AT, activations: [] } as Exchange;
		const blocks = build([said(4, 'priya')], [open], { open: {} });
		expect(blocks.at(-1)).toMatchObject({ text: 'Working on the room’s work', activations: [] });
	});

	it('ignores presence entries', () => {
		expect(shape(build([arrived(1), said(2, 'priya'), arrived(3)], []))).toEqual(['question:2']);
	});

	it('shows an earlier exchange in the open beside a newer open one', () => {
		const later: Exchange = {
			from: 150,
			status: 'open',
			person: 'priya',
			at: AT,
			activations: [],
		};
		const blocks = build([...thread, said(150, 'priya')], [closed, later], {
			open: { person: 'priya' },
		});
		expect(shape(blocks)).toEqual([
			'question:98',
			'said:102',
			'said:121',
			'question:125',
			'said:128',
			'said:134',
			'question:150',
			'live',
		]);
	});
});

describe('awaiting', () => {
	const usage = { input: 9000, output: 3300, cacheRead: 0, cacheWrite: 0 };
	const awaiting = (extra: object = {}): Exchange =>
		closedExchange(98, 134, { outcome: { kind: 'awaiting', person: 'noor' }, ...extra });

	it('notes that an awaiting exchange waits on the person, after its last message', () => {
		const blocks = build(thread, [awaiting()]);
		expect(blocks.at(-1)).toEqual({ type: 'note', text: 'Waiting on noor' });
		expect(shape(blocks).filter((kind) => kind === 'note')).toHaveLength(1);
	});

	it('adds the cost to the note', () => {
		const note = build(thread, [awaiting({ usage: { ...usage, cost: 0.5 } })]).at(-1);
		expect(note).toEqual({ type: 'note', text: 'Waiting on noor · $0.5000' });
	});

	it('falls back to tokens when the usage has no cost', () => {
		expect(build(thread, [awaiting({ usage })]).at(-1)).toEqual({
			type: 'note',
			text: 'Waiting on noor · 12.3k tokens',
		});
	});

	it('places the tail blocks after the messages and before the live block', () => {
		const later: Exchange = {
			from: 150,
			status: 'open',
			person: 'priya',
			at: AT,
			activations: [],
		};
		const blocks = build([...thread, said(150, 'priya')], [closed, later], {
			open: { person: 'priya' },
			tail: [{ type: 'note', text: 'Waiting.' }],
		});
		expect(shape(blocks).slice(-2)).toEqual(['note', 'live']);
	});
});
