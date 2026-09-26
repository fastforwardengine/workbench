import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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
- No real equipment is connected yet. Every measurement is a planned value.
- Record a decision in /shared/notes.md when the person permits file edits.
`,
	'shared/notes.md': `# Lab notes

Status: empty. Record decisions and test plans here.
`,
};

async function copyLibrary(path: string): Promise<void> {
	const entries = await readdir(libraryDirectory, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const source = resolve(libraryDirectory, entry.name);
		const target = resolve(path, 'library', entry.name);
		await mkdir(dirname(target), { recursive: true });
		await writeIfAbsent(target, await readFile(source, 'utf8'));
	}
}

async function writeIfAbsent(target: string, content: string): Promise<void> {
	try {
		await writeFile(target, content, { flag: 'wx' });
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
	}
}

/** Add missing datasheets and starter files. Existing edits always remain. */
export async function seedWorkspace(path: string): Promise<void> {
	await copyLibrary(path);
	for (const [name, content] of Object.entries(sharedFiles)) {
		const target = resolve(path, name);
		await mkdir(dirname(target), { recursive: true });
		await writeIfAbsent(target, content);
	}
}
