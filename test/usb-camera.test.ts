import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { templatesDirectory } from '../src/domain/templates.ts';

const directory = join(templatesDirectory, 'usb-camera');
const python = (() => {
	try {
		execFileSync('python3', ['--version']);
		return true;
	} catch {
		return false;
	}
})();

describe.skipIf(!python)('the USB camera template without hardware', () => {
	it('checks capture, protocol errors, persisted evidence, and launch source metadata', () => {
		const result = execFileSync('python3', ['-B', '-m', 'unittest', '-v', 'test_camera.py'], {
			cwd: directory,
			encoding: 'utf8',
			timeout: 20000,
			stdio: 'pipe',
		});
		expect(result).toBe('');
	});
});
