import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Attention } from '@ambionframework/ambion';
import { packageDirectory } from './package-root.ts';

/** The seats of every room. Every specialist hears every message, at `broadcast`. */
export const seats: Record<string, Attention> = {
	datasheets: 'broadcast',
	experiments: 'broadcast',
	instruments: 'broadcast',
};

/** The room of the project. */
export const scenarios: {
	name: string;
	goal: string;
	pattern: string;
	prompt: string;
	seats: Record<string, Attention>;
}[] = [
	{
		name: 'led-sweep',
		goal:
			'Sweep the drive current of an LED with a bench power supply, and measure the light ' +
			'at each step with a camera. Keep the current within the limit of the LED datasheet.',
		pattern: 'Datasheet limits → test plan → sweep',
		prompt: 'Plan the LED current sweep, and name the limits that it must respect.',
		seats,
	},
];

const libraryDirectory = packageDirectory('library');

/** The starter files under /shared. Existing edits always remain intact. */
const sharedFiles: Record<string, string> = {
	'shared/kit.md': `# The project

**Workbench holds one bench project: an LED parameter sweep.** A power
supply drives an LED through a range of currents. A camera measures the
light at each step. The supply and the camera connect to a workstation.

## Parts

- The LED: to be named, with its maximum forward current.
- The power supply: to be named, with its interface and its ranges.
- The camera: to be named, with the controls that the sweep holds fixed.

## House rules

- Read the datasheet in /library before you state a limit. Cite the path.
- A measurement counts only when a script read it from a device. Cite the
  file that the script wrote. Every other value is a planned value.
- Record a decision in /shared/notes.md when the person permits file edits.
`,
	'shared/notes.md': `# Lab notes

Status: empty. Record decisions and test plans here.
`,
};

/**
 * The seed of a workspace: each file by its workspace path, such as
 * `/shared/kit.md`. The library comes from `library/` of the package. The
 * host writes each file that the workspace does not hold yet, so an edit
 * always remains.
 */
export function seedFiles(): Record<string, string> {
	const files: Record<string, string> = {};
	for (const entry of readdirSync(libraryDirectory, { withFileTypes: true })) {
		if (entry.isFile())
			files[`/library/${entry.name}`] = readFileSync(join(libraryDirectory, entry.name), 'utf8');
	}
	for (const [name, content] of Object.entries(sharedFiles)) files[`/${name}`] = content;
	return files;
}
