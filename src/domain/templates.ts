import { join } from 'node:path';
import { packageDirectory, packageFiles } from './package-root.ts';

/** The directory that holds one directory for each template. */
export const templatesDirectory = packageDirectory('templates');

/**
 * One read-only template on the git server of the workspace. A specialist forks
 * it, clones the fork into its home, and pushes its branch.
 */
export interface Template {
	/** The name on the git server, `templates/<name>`, and the directory under `templates/`. */
	readonly name: string;
	/** What the template holds. The `repos` tool shows it to every specialist. */
	readonly description: string;
}

/** The templates, in the order that `repos` lists them. */
export const templates: readonly Template[] = [
	{
		name: 'device-scan',
		description:
			'A scan of the devices that the workstation reaches: USB devices, serial ports, USBTMC instruments, cameras, and microphones. Each scan writes a report, and inventory.md records the bench.',
	},
	{
		name: 'usb-camera',
		description:
			'A Linux USB camera and microphone sensor. A foreground server that the specialist owns captures a PNG frame from the camera and a WAV clip with a level series from the microphone for each observation. The specialist reads it with `fetch`, and the snapshot store keeps each fetched observation, frame, and clip. The demo mode makes synthetic data and labels it.',
	},
	{
		name: 'psu',
		description:
			'psu.py, a command-line tool for a programmable power supply: the outputs, the setpoints, the readings, and the protection limits of each channel, within the limits of psu.json. A guard enforces the limits and the locks. A driver for the HANMATEK HM310P and a simulated supply with several channels come with it. A simulated supply runs with no hardware.',
	},
];

/**
 * The files of one template, by path, as text. The host registers exactly
 * these files. A template holds text files only. A template stores its
 * ignore file as `gitignore`, and the host registers it as `.gitignore`.
 */
export function templateFiles(name: string): Record<string, string> {
	const files = packageFiles(join(templatesDirectory, name), { text: true });
	// npm and pnpm drop `.gitignore` from a package, so the file ships as `gitignore`.
	return Object.fromEntries(
		Object.entries(files).map(([path, text]) => [
			path.replace(/(^|\/)gitignore$/, '$1.gitignore'),
			text,
		]),
	);
}
