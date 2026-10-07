/** The messages that wait to be read, and the cue above the input that shows them. */
import type { ExchangeActivation, Message } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { cueLines } from '../src/terminal/state/cue.ts';
import { waitingMessages } from '../src/view/steering.ts';
import type { ActivationSteps } from '../src/view/steps.ts';

const AT = '2026-01-01T00:00:00Z';

const said = (seq: number, from: string, text: string) =>
	({ kind: 'said', seq, from, text, at: AT }) as Message;

const activation = (id: string, outcome: string = 'running', purpose: string = 'respond') =>
	({ id, seat: 'engineer', attempt: 1, purpose, outcome: { kind: outcome } }) as ExchangeActivation;

/** The steps of one activation: one pass that reads through `through`, then the extra steps. */
const trace = (id: string, through: number, ...steps: Record<string, unknown>[]) =>
	({
		activation: id,
		passes: [
			{
				pass: 1,
				input: 'view',
				through,
				steps: [{ type: 'pass', pass: 1, input: 'view', through }, ...steps],
			},
		],
	}) as unknown as ActivationSteps;

const steer = (seq: number, consumed: boolean) => ({ type: 'steer', seq, consumed });

const exchange = (...activations: ExchangeActivation[]) => ({ from: 1, activations });

const messages = [said(1, 'priya', 'Start'), said(2, 'priya', 'check the 5 V rail first')];

describe('waitingMessages', () => {
	const at = (
		extra: Partial<Parameters<typeof waitingMessages>[0]> = {},
		reads = new Map([['a1', trace('a1', 1)]]),
	) =>
		waitingMessages({
			messages,
			exchange: exchange(activation('a1')),
			person: 'priya',
			reads,
			...extra,
		});

	it('holds a message that landed after the pass began and has no steer step yet', () => {
		expect(at()).toEqual([{ seq: 2, text: 'check the 5 V rail first' }]);
	});

	it('holds a message whose steer step says the pass did not read it', () => {
		expect(at({}, new Map([['a1', trace('a1', 1, steer(2, false))]]))).toHaveLength(1);
	});

	it('drops a message when its steer step is consumed', () => {
		expect(at({}, new Map([['a1', trace('a1', 1, steer(2, true))]]))).toEqual([]);
	});

	it('drops a message that a later pass reads in its delta', () => {
		const reads = new Map([['a1', trace('a1', 2, steer(2, false))]]);
		expect(at({}, reads)).toEqual([]);
	});

	it('never holds the message that opened the exchange', () => {
		expect(at({}, new Map()).map((one) => one.seq)).toEqual([2]);
	});

	it('holds a message while one of two running seats has not read it', () => {
		const reads = new Map([
			['a1', trace('a1', 1, steer(2, true))],
			['a2', trace('a2', 1)],
		]);
		const both = exchange(activation('a1'), activation('a2'));
		expect(at({ exchange: both }, reads)).toHaveLength(1);
		reads.set('a2', trace('a2', 1, steer(2, true)));
		expect(at({ exchange: both }, reads)).toEqual([]);
	});

	it('holds a message while the running activation has no steps yet', () => {
		expect(at({}, new Map())).toHaveLength(1);
	});

	it('ignores the message of another person and a message of a seat', () => {
		const mixed = [...messages, said(3, 'noor', 'and the ripple'), said(4, 'engineer', 'on it')];
		expect(at({ messages: mixed }).map((one) => one.seq)).toEqual([2]);
	});

	it('shows nothing once the activation ends or the exchange closes', () => {
		expect(at({ exchange: exchange(activation('a1', 'complete')) })).toEqual([]);
		expect(at({ exchange: undefined })).toEqual([]);
	});

	it('shows nothing while no activation runs, and ignores a summary activation', () => {
		expect(at({ exchange: exchange() })).toEqual([]);
		expect(at({ exchange: exchange(activation('a1', 'running', 'summarize')) })).toEqual([]);
	});

	it('lists several waiting messages in order, each with its first line', () => {
		const several = [...messages, said(3, 'priya', '\nthen the ripple\nat 1 kHz')];
		expect(at({ messages: several }).map((one) => [one.seq, one.text])).toEqual([
			[2, 'check the 5 V rail first'],
			[3, 'then the ripple'],
		]);
	});

	it('shows nothing without a person', () => {
		expect(at({ person: undefined })).toEqual([]);
	});
});

describe('cueLines', () => {
	const waiting = (count: number) =>
		Array.from({ length: count }, (_, at) => ({ seq: at + 2, text: `message ${at + 1}` }));
	const staged = [{ path: '/attachments/1-one.png', ref: 'ref' }];

	it('has no line when nothing is staged or waits', () => {
		expect(cueLines([], [], 80)).toEqual([]);
	});

	it('shows one line for each waiting message, then the count of the rest', () => {
		expect(cueLines([], waiting(2), 80).map((line) => `${line.mark} ${line.text}`)).toEqual([
			'↳ steering: message 1',
			'↳ steering: message 2',
		]);
		expect(cueLines([], waiting(5), 80).map((line) => line.text)).toEqual([
			'steering: message 1',
			'steering: message 2',
			'+3 more',
		]);
	});

	it('puts the staged files first', () => {
		const lines = cueLines(staged, waiting(1), 80);
		expect(lines.map((line) => line.text)).toEqual(['1 attached: one.png', 'steering: message 1']);
		expect(lines.map((line) => line.tone)).toEqual(['muted', 'dim']);
	});

	it('ends a long message with an ellipsis so the line fits the row', () => {
		const long = [{ seq: 2, text: 'check the 5 V rail first and then the ripple at 1 kHz' }];
		for (const room of [60, 40, 30]) {
			const [line] = cueLines([], long, room);
			expect(line && line.mark.length + 1 + line.text.length).toBeLessThanOrEqual(room);
			expect(line?.text).toContain('…');
		}
	});
});
