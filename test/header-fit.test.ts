import { describe, expect, it } from 'vitest';
import { fitHeader } from '../src/terminal/widgets/header-fit.ts';
import { APART } from '../src/terminal/widgets/space.ts';

const GOAL =
	'Discharge-test the 18650 cell through a load resistor. Choose a value and confirm it.';
const base = {
	name: 'characterization',
	goal: GOAL,
	identity: 'as priya, hardware lead',
	people: 44,
	pattern: 'Datasheet check → design decision',
};

describe('fitHeader', () => {
	it('keeps a goal that fits, and the pattern beside the participants', () => {
		const fit = fitHeader({ ...base, width: 200 });
		expect(fit.goal).toBe(GOAL);
		expect(fit.pattern).toBe(base.pattern);
	});

	it('ends a long goal with an ellipsis inside what the name and identity leave', () => {
		const width = 70;
		const fit = fitHeader({ ...base, width });
		expect(fit.goal.endsWith('…')).toBe(true);
		const row = base.name.length + APART + fit.goal.length + APART + base.identity.length;
		expect(row).toBeLessThanOrEqual(width);
	});

	it('gives the goal the identity cells when there is no identity', () => {
		const withWho = fitHeader({ ...base, width: 70 }).goal.length;
		const without = fitHeader({ ...base, identity: '', width: 70 }).goal.length;
		expect(without).toBeGreaterThan(withWho);
	});

	it('drops the pattern when it does not fit beside the participants', () => {
		const need = base.people + APART + base.pattern.length;
		expect(fitHeader({ ...base, width: need }).pattern).toBe(base.pattern);
		expect(fitHeader({ ...base, width: need - 1 }).pattern).toBe('');
	});

	it('shows no goal and no pattern when the row is too narrow', () => {
		const fit = fitHeader({ ...base, width: 20 });
		expect(fit.goal).toBe('');
		expect(fit.pattern).toBe('');
	});

	it('handles a room with no goal and no pattern', () => {
		const fit = fitHeader({ ...base, goal: '', pattern: '', width: 100 });
		expect(fit).toEqual({ goal: '', pattern: '' });
	});

	it('counts the path of a breakout room as the name', () => {
		const width = 70;
		const path = 'build › datasheets';
		const fit = fitHeader({ ...base, name: path, width });
		const row = path.length + APART + fit.goal.length + APART + base.identity.length;
		expect(row).toBeLessThanOrEqual(width);
		const longer = fitHeader({ ...base, name: `${path} › more`, width }).goal.length;
		expect(longer).toBeLessThan(fit.goal.length);
	});

	it('drops the state of a breakout room when it does not fit beside the participants', () => {
		const state = '✓ done';
		const need = base.people + APART + state.length;
		expect(fitHeader({ ...base, pattern: state, width: need }).pattern).toBe(state);
		expect(fitHeader({ ...base, pattern: state, width: need - 1 }).pattern).toBe('');
	});
});
