import { describe, expect, it } from 'vitest';
import { brief, clock, ellipsize, firstLine, render } from '../src/view/text.ts';

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
