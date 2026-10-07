import { describe, expect, it } from 'vitest';
import { brief, clock, ellipsize, ellipsizeMiddle, firstLine, render } from '../src/view/text.ts';

describe('ellipsize', () => {
	it('returns text that already fits, with its spaces collapsed', () => {
		expect(ellipsize('Choose a load resistor', 40)).toBe('Choose a load resistor');
		expect(ellipsize('  Choose \n a \tresistor  ', 40)).toBe('Choose a resistor');
	});

	it('keeps text that is exactly as wide as the line', () => {
		expect(ellipsize('abcde', 5)).toBe('abcde');
	});

	it('ends at a word edge when one is near the cut', () => {
		expect(ellipsize('Choose a load resistor and confirm the current', 30)).toBe(
			'Choose a load resistor and…',
		);
	});

	it('never exceeds the width', () => {
		const text = 'Discharge-test the 18650 cell through a load resistor. Choose a resistor value.';
		for (let width = 1; width < text.length; width += 1)
			expect(ellipsize(text, width).length).toBeLessThanOrEqual(width);
	});

	it('cuts inside a long word when no word edge is near', () => {
		expect(ellipsize('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 10)).toBe('aaaaaaaaa…');
		expect(ellipsize('ab cdefghijklmnopqrstuvwxyzabcdefghijkl', 30)).toBe(
			'ab cdefghijklmnopqrstuvwxyzab…',
		);
	});

	it('returns only the ellipsis for a one-cell line, and nothing for no cells', () => {
		expect(ellipsize('goal', 1)).toBe('…');
		expect(ellipsize('goal', 0)).toBe('');
		expect(ellipsize('goal', -3)).toBe('');
	});
});

describe('brief', () => {
	it('keeps the first line, trimmed, and cuts a long one with an ellipsis', () => {
		expect(brief('  one  \ntwo')).toBe('one');
		expect(brief('x'.repeat(100))).toBe('x'.repeat(100));
		expect(brief('x'.repeat(101))).toBe(`${'x'.repeat(99)}…`);
	});
});

describe('firstLine', () => {
	it('skips the lines that hold no character', () => {
		expect(firstLine('\n  \nvalue\nnext')).toBe('value');
		expect(firstLine(' \n')).toBe('');
	});
});

describe('render', () => {
	it('shows a string as it is and any other value as JSON', () => {
		expect(render('a\nb')).toBe('a');
		expect(render({ a: 1 })).toBe('{"a":1}');
		expect(render(undefined)).toBe('');
	});
});

describe('clock', () => {
	it.each([
		[0, '0:00'],
		[42_000, '0:42'],
		[125_000, '2:05'],
		[3_725_000, '1:02:05'],
		[-5, '0:00'],
	])('shows %i ms as %s', (ms, text) => {
		expect(clock(ms)).toBe(text);
	});
});

describe('ellipsizeMiddle', () => {
	it('leaves a path that fits', () => {
		expect(ellipsizeMiddle('/shared/kit.md', 14)).toBe('/shared/kit.md');
	});

	it('keeps the file name and the leading folders that fit', () => {
		expect(ellipsizeMiddle('/shared/rf/ldo-compare.md', 24)).toBe('/shared/…/ldo-compare.md');
		expect(ellipsizeMiddle('/shared/rf/ldo-compare.md', 20)).toBe('/sha…/ldo-compare.md');
	});

	it('cuts the middle of a name that is too long, or of a text with no folder', () => {
		expect(ellipsizeMiddle('/a/ldo-compare-long-name.md', 10)).toBe('/a/ld…e.md');
		expect(ellipsizeMiddle('sweep-rig main 7c1e2a9', 12)).toBe('sweep-…1e2a9');
		expect(ellipsizeMiddle('abc', 0)).toBe('');
	});

	it('never returns more than the width', () => {
		for (const width of [1, 2, 5, 9, 17, 30])
			expect(
				ellipsizeMiddle('/attachments/2026/scope-capture-0042.png', width).length,
			).toBeLessThanOrEqual(width);
	});
});
