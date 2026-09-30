import { describe, expect, it } from 'vitest';
import { planRows } from '../src/terminal/widgets/row-diff.ts';

const rows = (text: string) => [...text];

/** Apply a plan: the list that the kept rows and the new rows make. */
function apply(old: string[], wanted: string[]) {
	const plan = planRows(old, wanted);
	const result = old.slice(0, plan.start);
	let built = 0;
	for (let at = plan.start; at < plan.newEnd; at += 1) {
		const from = plan.kept.get(at);
		if (from === undefined) {
			built += 1;
			result.push(wanted[at] ?? '');
		} else result.push(old[from] ?? '');
	}
	result.push(...old.slice(plan.oldEnd));
	return { plan, result, built };
}

describe('planRows', () => {
	it('keeps every row of two equal lists, and builds none', () => {
		const { plan, built } = apply(rows('abcd'), rows('abcd'));
		expect(plan).toMatchObject({ start: 4, oldEnd: 4, newEnd: 4 });
		expect(built).toBe(0);
	});

	it('builds the rows that a list gains at the end, at the top, or in the middle', () => {
		expect(apply(rows('abc'), rows('abcde')).built).toBe(2);
		expect(apply(rows('abc'), rows('xabc')).built).toBe(1);
		expect(apply(rows('abcd'), rows('abxcd')).built).toBe(1);
	});

	it('builds nothing when a list loses rows', () => {
		expect(apply(rows('abcde'), rows('ab')).built).toBe(0);
		expect(apply(rows('abcde'), rows('ace')).built).toBe(0);
	});

	it('builds one row for one change', () => {
		expect(apply(rows('abcde'), rows('abXde')).built).toBe(1);
		expect(apply(rows('abcde'), rows('Xbcde')).built).toBe(1);
		expect(apply(rows('abcde'), rows('abcdX')).built).toBe(1);
	});

	it('builds two rows for two changes far apart, and keeps the rows between them', () => {
		const { built, plan } = apply(rows('aBcdefgHi'), rows('abcdefghi'));
		expect(built).toBe(2);
		expect(plan.kept.size).toBe(5);
	});

	it('keeps a row only once when the list holds equal rows', () => {
		const { result, built } = apply(rows('aabb'), rows('abab'));
		expect(result).toEqual(rows('abab'));
		expect(built).toBeGreaterThan(0);
	});

	it('leaves out a pair that would cross another, so no kept row moves', () => {
		const { plan, result } = apply(rows('abc'), rows('cab'));
		expect(result).toEqual(rows('cab'));
		const olds = [...plan.kept.values()];
		expect(olds).toEqual([...olds].sort((a, b) => a - b));
	});

	it('does not let the top and the bottom overlap when a list repeats a row', () => {
		for (const [from, to] of [
			['a', 'aa'],
			['aa', 'a'],
			['aaa', 'a'],
			['a', 'aaa'],
			['aba', 'a'],
			['ab', 'aba'],
		] as const) {
			const { plan, result } = apply(rows(from), rows(to));
			expect(result, `${from} -> ${to}`).toEqual(rows(to));
			expect(plan.start, `${from} -> ${to}`).toBeLessThanOrEqual(plan.oldEnd);
			expect(plan.start, `${from} -> ${to}`).toBeLessThanOrEqual(plan.newEnd);
		}
	});

	it('plans a long list of equal rows in linear time', () => {
		const old = ['top', ...Array.from({ length: 20_000 }, () => 'same'), 'bottom'];
		const wanted = ['TOP', ...Array.from({ length: 20_000 }, () => 'same'), 'BOTTOM'];
		const began = performance.now();
		const { built, result } = apply(old, wanted);
		expect(performance.now() - began).toBeLessThan(150);
		expect(result).toEqual(wanted);
		expect(built).toBe(2);
	});

	it('plans an empty list from any list, and any list from an empty one', () => {
		expect(apply(rows('abc'), []).result).toEqual([]);
		expect(apply([], rows('abc')).built).toBe(3);
		expect(apply([], []).result).toEqual([]);
	});
});

/** A small seeded generator, so a failing list can be run again. */
function random(seed: number) {
	let state = seed;
	return (below: number) => {
		state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
		return Math.floor((state / 4_294_967_296) * below);
	};
}

describe('planRows, over random lists', () => {
	it('reproduces the wanted list, and keeps the kept rows in their order', () => {
		const next = random(7);
		for (let round = 0; round < 500; round += 1) {
			const make = () => Array.from({ length: next(12) }, () => 'abcd'[next(4)] ?? 'a');
			const old = make();
			const wanted = make();
			const { plan, result, built } = apply(old, wanted);
			const label = `${old.join('')} -> ${wanted.join('')}`;
			expect(result, label).toEqual(wanted);
			const olds = [...plan.kept.values()];
			const news = [...plan.kept.keys()];
			expect(olds, label).toEqual([...olds].sort((a, b) => a - b));
			expect(new Set(olds).size, label).toBe(olds.length);
			expect(
				news.every((at) => at >= plan.start && at < plan.newEnd),
				label,
			).toBe(true);
			expect(
				olds.every((at) => at >= plan.start && at < plan.oldEnd),
				label,
			).toBe(true);
			expect(built + plan.kept.size, label).toBe(plan.newEnd - plan.start);
		}
	});
});
