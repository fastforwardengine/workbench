import { describe, expect, it } from 'vitest';
import { assertAfter, countOf, releaseVersion } from '../scripts/release-version.ts';

describe('the release version', () => {
	it('joins the base, the commit count, and the short hash', () => {
		expect(releaseVersion('0.1.0', 14, '1a852f1')).toBe('0.1.14-g1a852f1');
		// A hash of digits with a leading zero stays a valid prerelease part.
		expect(releaseVersion('0.1.0', 15, '0123456')).toBe('0.1.15-g0123456');
		expect(() => releaseVersion('1', 3, 'abc1234')).toThrow(/no minor/);
	});

	it('reads the commit count of a release version and of a plain version', () => {
		expect(countOf('0.1.14-g1a852f1')).toBe(14);
		expect(countOf('0.1.0')).toBe(0);
		expect(countOf('0.1.14-beta.1')).toBeUndefined();
	});

	it('accepts only a version above the published one', () => {
		expect(() => assertAfter('0.1.14-g1a852f1', '')).not.toThrow();
		expect(() => assertAfter('0.1.15-gbbbbbbb', '0.1.14-g1a852f1')).not.toThrow();
		expect(() => assertAfter('0.1.14-gbbbbbbb', '0.1.14-g1a852f1')).toThrow(/not above/);
		expect(() => assertAfter('0.1.13-gbbbbbbb', '0.1.14-g1a852f1')).toThrow(/not above/);
		expect(() => assertAfter('0.1.15-gbbbbbbb', '2.0.0-rc.1')).toThrow(/no commit count/);
	});
});
