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
	background: '',
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
		expect(fit).toEqual({ goal: '', background: '', pattern: '' });
	});

	describe('the background chip', () => {
		const chip = '⇉ 2 in background';
		const withChip = { ...base, background: chip };

		it('shows beside the participants, and shows no chip when none runs', () => {
			expect(fitHeader({ ...withChip, width: 200 }).background).toBe(chip);
			expect(fitHeader({ ...base, width: 200 }).background).toBe('');
		});

		it('drops when it does not fit after the participants', () => {
			const need = withChip.people + APART + chip.length;
			expect(fitHeader({ ...withChip, pattern: '', width: need }).background).toBe(chip);
			expect(fitHeader({ ...withChip, pattern: '', width: need - 1 }).background).toBe('');
		});

		it('drops the pattern before it drops the chip', () => {
			const chipEnd = withChip.people + APART + chip.length;
			const need = chipEnd + APART + base.pattern.length;
			const roomy = fitHeader({ ...withChip, width: need });
			expect([roomy.background, roomy.pattern]).toEqual([chip, base.pattern]);
			const tight = fitHeader({ ...withChip, width: need - 1 });
			expect([tight.background, tight.pattern]).toEqual([chip, '']);
		});

		it('drops before the participants lose a cell', () => {
			const fit = fitHeader({ ...withChip, width: withChip.people });
			expect(fit.background).toBe('');
			expect(fit.pattern).toBe('');
		});
	});
});
