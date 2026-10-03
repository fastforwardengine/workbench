import { describe, expect, it } from 'vitest';
import {
	atLeast,
	floorMessage,
	floorOf,
	report,
	type StageResult,
	stages,
} from '../scripts/check.ts';

const result = (name: string, code: number | undefined, output = ''): StageResult => {
	const stage = stages.find((candidate) => candidate.name === name);
	if (stage === undefined) throw new Error(`No stage ${name}.`);
	return { stage, ms: 1500, code, output };
};

describe('the Node floor', () => {
	it('reads the minimum of an engines range', () => {
		expect(floorOf('>=26.4.0')).toBe('26.4.0');
		expect(() => floorOf('^26.4.0')).toThrow(/not of the form/);
	});

	it('compares each part of a version as a number', () => {
		expect(atLeast('26.4.0', '26.4.0')).toBe(true);
		expect(atLeast('26.10.0', '26.4.0')).toBe(true);
		expect(atLeast('27.0.0', '26.4.0')).toBe(true);
		expect(atLeast('26.3.9', '26.4.0')).toBe(false);
		expect(atLeast('22.22.0', '26.4.0')).toBe(false);
	});

	it('names the floor, the found version, and the fix', () => {
		expect(floorMessage('26.4.1', '26.4.0')).toBeUndefined();
		expect(floorMessage('22.22.0', '26.4.0')).toBe(
			'check: Node 26.4.0 or newer is required; found 22.22.0. Run nvm use.',
		);
	});
});

describe('the report', () => {
	it('prints one line when every stage passes', () => {
		const passed = stages.map(({ name }) => result(name, 0, 'noise'));
		expect(report(passed, 21300)).toEqual({
			text: 'check: 5 stages passed in 21.3s\n',
			ok: true,
		});
	});

	it('prints each failed stage with its command and fix, and no passed stage', () => {
		const run = [
			result('format', 1, 'Code style issues found\n'),
			result('types', 0, 'types noise'),
			result('lint', 1, 'lint output\n'),
			result('knip', 0),
			result('test', 2, 'test output'),
		];
		const { text, ok } = report(run, 4000);
		expect(ok).toBe(false);
		expect(text).toContain(
			'==> format failed with code 1 in 1.5s. Run: pnpm exec prettier . --cache --check. Fix: pnpm format\nCode style issues found\n',
		);
		expect(text).toContain('==> lint failed with code 1 in 1.5s. Run: pnpm exec biome lint');
		expect(text).toContain(
			'==> test failed with code 2 in 1.5s. Run: pnpm exec vitest run.\ntest output\n',
		);
		expect(text).not.toContain('types');
		expect(text.endsWith('check: 3 of 5 stages failed (format, lint, test) in 4.0s\n')).toBe(true);
	});

	it('reports a process that did not exit with a code', () => {
		const { text } = report([result('types', undefined, 'spawn ENOENT')], 100);
		expect(text).toContain('==> types stopped in 1.5s.');
		expect(text).toContain('spawn ENOENT');
	});
});
