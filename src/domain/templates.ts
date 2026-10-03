import { join } from 'node:path';
import { packageDirectory } from './package-root.ts';
import { textFiles } from './text-files.ts';

/** The directory that holds one directory for each template. */
export const templatesDirectory = packageDirectory('templates');

/**
 * One read-only template on the git server of the workspace. An agent forks
 * it, clones the fork into its home, and pushes its branch.
 */
export interface Template {
	/** The name on the git server, `templates/<name>`, and the directory under `templates/`. */
	readonly name: string;
	/** What the template holds. The `repos` tool shows it to every agent. */
	readonly description: string;
	/** The work the template starts, as a noun phrase, such as "a test plan". */
	readonly use: string;
	/** The specialists whose instructions name this template. */
	readonly specialists: readonly string[];
}

/** The templates, in the order that `repos` lists them. */
export const templates: readonly Template[] = [
	{
		name: 'test-plan',
		description:
			'A numbered test plan: the question, the setup, the variable, the controls, the measurement, the limits, and the pass criterion.',
		use: 'a test plan',
		specialists: ['researcher'],
	},
	{
		name: 'device-scan',
		description:
			'A scan of the devices that the workstation reaches: USB devices, serial ports, VISA instruments, cameras, and the SCPI ports of a subnet. Each scan writes a report, and inventory.md records the bench.',
		use: 'a scan of the connected devices',
		specialists: ['engineer'],
	},
	{
		name: 'usb-camera',
		description:
			'A Linux USB camera and microphone sensor. An agent-owned foreground server captures a PNG frame from the camera and a WAV clip with a level series from the microphone for each observation. The snapshot store keeps each observed frame and clip. The demo mode makes synthetic data and labels it.',
		use: 'retained images from a USB camera and sound clips from its microphone',
		specialists: ['engineer'],
	},
	{
		name: 'build-procedure',
		description:
			'A build procedure for a kit: each step with its parts, their places and orientation, the risk, the check, and the evidence, and the first power-on.',
		use: 'a build procedure',
		specialists: ['engineer'],
	},
	{
		name: 'psu',
		description:
			'psu.py, a command-line tool for a programmable power supply: the outputs, the setpoints, the readings, and the protection limits of each channel, within the limits of psu.json. A guard enforces the limits and the locks. A driver for the HANMATEK HM310P and a simulated supply with several channels come with it. A simulated supply runs with no hardware.',
		use: 'control of a programmable power supply',
		specialists: ['engineer'],
	},
];

/**
 * The files of one template, by path, as text. The host registers exactly
 * these files. A template holds text files only.
 */
export function templateFiles(name: string): Record<string, string> {
	return textFiles(join(templatesDirectory, name));
}

/** The instruction lines that name the templates of one specialist. Empty when it has none. */
export function templateInstructions(specialist: string): string {
	return templates
		.filter((template) => template.specialists.includes(specialist))
		.map(
			({ name, use }) =>
				` For ${use}, fork the ${name} template with \`fork\` and set clone, then commit and push your branch.`,
		)
		.join('');
}
