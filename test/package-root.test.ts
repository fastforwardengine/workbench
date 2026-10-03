import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isIgnored, packageFiles } from '../src/domain/package-root.ts';

describe('the package directory reader', () => {
	it('ignores the files that a tool writes, and keeps the others', () => {
		const root = mkdtempSync(join(tmpdir(), 'workbench-package-'));
		try {
			mkdirSync(join(root, '.git'));
			mkdirSync(join(root, 'a', '__pycache__'), { recursive: true });
			writeFileSync(join(root, '.git', 'x'), 'x');
			writeFileSync(join(root, '.DS_Store'), 'x');
			writeFileSync(join(root, 'a', '__pycache__', 'm.cpython.pyc'), 'x');
			writeFileSync(join(root, 'b.pyc'), 'x');
			writeFileSync(join(root, '.gitignore'), '*.pyc\n');
			writeFileSync(join(root, 'ok.md'), '# Ok\n');
			expect(packageFiles(root, { text: true })).toEqual({
				'.gitignore': '*.pyc\n',
				'ok.md': '# Ok\n',
			});
			expect(Object.keys(packageFiles(root))).toEqual(['.gitignore', 'ok.md']);
			expect(packageFiles(root)['ok.md']).toBeInstanceOf(Uint8Array);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('applies the rule to a path with either separator', () => {
		expect(isIgnored('skill/scripts/__pycache__/m.pyc')).toBe(true);
		expect(isIgnored('skill\\.git\\config')).toBe(true);
		expect(isIgnored('skill/.gitignore')).toBe(false);
	});
});
