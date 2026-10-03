import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { atLeast, pythonFloor } from '../scripts/check.ts';

/**
 * True when python3 runs and has the version of the floor or a newer one. The floor is the
 * `target-version` of `pyproject.toml`, the same floor that `pnpm check` reads. A test that needs
 * python3 skips when this is false. The python stage of `pnpm check` reports the old Python.
 */
export const python: boolean = (() => {
	try {
		const floor = pythonFloor(readFileSync(new URL('../pyproject.toml', import.meta.url), 'utf8'));
		const found = /(\d+\.\d+(?:\.\d+)?)/.exec(
			execFileSync('python3', ['--version'], { encoding: 'utf8' }),
		);
		return found?.[1] !== undefined && atLeast(found[1], floor);
	} catch {
		return false;
	}
})();
