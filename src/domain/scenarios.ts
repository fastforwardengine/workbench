import type { Attention } from '@ambionframework/ambion';
import { packageDirectory, packageFiles } from './package-root.ts';

/**
 * The seats of a room with no seats of its own. The two specialists hear
 * every message, at `broadcast`. The Engineer needs every message to keep its
 * view of the bench current.
 */
export const seats: Record<string, Attention> = {
	researcher: 'broadcast',
	engineer: 'broadcast',
};

/** One room of the project: what it is for, how the header names it, and who listens. */
export interface Scenario {
	name: string;
	goal: string;
	/** The line the header shows: the phases of the room, in order. */
	pattern: string;
	/** The question that `/try` puts in the composer. */
	prompt: string;
	seats: Record<string, Attention>;
}

/**
 * The rooms of the FM radio milestone, one for each phase. A room seats the
 * specialists that its phase needs. The owners of the phase hear every message,
 * and the others answer when the assistant or an owner addresses them.
 * The notes (`shared/notes`) carry the state of the bench from one room to the next.
 */
export const scenarios: Scenario[] = [
	{
		name: 'radio-kit',
		goal:
			'Know the FM radio kit, and support the hand build of the first one. Record each part ' +
			'with its evidence in the notes, find the datasheets and the schematic, and ' +
			'guide the person through the build. The first radio must play a station.',
		pattern: 'Parts → datasheets → schematic → build',
		prompt:
			'List the parts of the kit from the notes, and name the facts we must settle before the build.',
		seats: {
			engineer: 'broadcast',
			researcher: 'broadcast',
		},
	},
	{
		name: 'radio-tune',
		goal:
			'Hear the radio, and tune it in two ways. Path A: a Pico presses the buttons, and the ' +
			'camera reads the display. Path B: the Pico drives the tuner over I²C, and a scan maps ' +
			'the stations of the band by signal strength, checked by sound.',
		pattern: 'Hear → press (A) → I²C (B) → station map',
		prompt: 'Plan path A: how the Pico presses CH+ and CH−, and how the camera reads the display.',
		seats: {
			engineer: 'broadcast',
			researcher: 'broadcast',
		},
	},
	{
		name: 'radio-build',
		goal:
			'Guide the build of the second kit. Write the steps with their parts and places, check ' +
			'the placement and the orientation of each polarized part from a photo before it is ' +
			'soldered, and power the kit on through the HM310P with a current limit.',
		pattern: 'Steps → placement check → first power-on',
		prompt:
			'Write the build procedure of the second kit as steps, with a check for each polarized part.',
		seats: {
			engineer: 'broadcast',
			researcher: 'named',
		},
	},
	{
		name: 'radio-firmware',
		goal:
			'Path C: new firmware for the STC8G1K that takes serial commands, and keeps the buttons ' +
			'and the display working. Set up the toolchain, take the pins from the schematic, and ' +
			'keep a spare chip with the stock firmware.',
		pattern: 'Toolchain → pins → firmware → flash',
		prompt: 'List what path C needs: the compiler, the flasher, the pins, and the spare chip.',
		seats: {
			engineer: 'broadcast',
			researcher: 'broadcast',
		},
	},
];

const libraryDirectory = packageDirectory('library');

/** The starter files under /shared. Existing edits always remain intact. */
const sharedFiles: Record<string, string> = {
	'shared/kit.md': `# The project

**Workbench holds one bench project: an FM radio kit.** The person builds
the first kit by hand. The team then tunes the radio in three ways, and
guides the build of a second kit. Four rooms hold the phases:

| Room             | Phase                                                                  |
| ---------------- | ---------------------------------------------------------------------- |
| \`radio-kit\`      | Know the kit, and support the hand build of the first one              |
| \`radio-tune\`     | Hear the radio, and tune it: path A (buttons) and path B (I²C)        |
| \`radio-build\`    | Guide the build of the second kit, and its first power-on              |
| \`radio-firmware\` | Path C: new firmware for the microcontroller                           |

**The notes hold the state of the bench.** They are the git repository
\`shared/notes\`. Clone it and read its README.md before you act, in any room.

## Parts of the kit

These come from the product photo, the manual, and the schematic. Check each
one against the kit. The datasheets, the manual, and the schematic are in
/library. Start with /library/README.md.

- The FM tuner module: RDA5807FP-M, controlled over I²C.
- The microcontroller: STC8G1K17, 16 pins, in a DIP16 socket.
- The amplifier module: 8002. The charging module: CAI-222 in the photo,
  probably a TP4056 board.
- A 4-digit 7-segment display (3641AS), and four buttons: V−, V+, CH−, CH+.
- A speaker, a headphone jack, a telescopic antenna, and a case.

## On the bench

- Two FM radio kits, the ELEGOO Electronics Fun Kit, and soldering equipment.
- A HANMATEK HM310P power supply, a Logitech BRIO camera, and a USB microphone.
- To buy: a Raspberry Pi Pico for paths A and B. For path C, a 3.3 V
  USB-to-serial adapter and a spare STC8G1K of the exact type.

## House rules

- Read the datasheet in /library before you state a limit. Cite the path.
- A measurement counts only when a script read it from a device. Cite the
  file that the script wrote. Every other value is a planned value.
- The first power-on of the second kit goes through the HM310P, with a current
  limit. Stop at once on an abnormal current.
- The power stays off until the checks of the build pass.
- Record a decision in the notes, in \`decisions/\`, unless the person told you not to edit files.
`,
};

/** The content of a seed file: text for Markdown, bytes for a figure. */
export type SeedContent = string | Uint8Array;

/**
 * The files of `library/`, at any depth, by workspace path such as
 * `/library/images/kit-schematic.jpg`. A Markdown file is text. Every other
 * file, such as a figure, is bytes. The shared ignore rule of the package
 * applies: `.DS_Store`, `.git`, `__pycache__`, and `.pyc` files stay out.
 * The seed keeps another dot file.
 */
function libraryFiles(): Record<string, SeedContent> {
	return Object.fromEntries(
		Object.entries(packageFiles(libraryDirectory)).map(([name, bytes]) => [
			`/library/${name}`,
			name.endsWith('.md') ? Buffer.from(bytes).toString('utf8') : bytes,
		]),
	);
}

/**
 * The seed of a workspace: each file by its workspace path, such as
 * `/shared/kit.md`. The library comes from `library/` of the package. The
 * host writes each file of `/library` at every start, because the package
 * owns them. It writes every other file only when the workspace does not
 * hold it, so an edit always remains. `overrides` replaces files of the seed by path, as an eval
 * of another project does.
 */
export function seedFiles(overrides: Record<string, string> = {}): Record<string, SeedContent> {
	const files = libraryFiles();
	for (const [name, content] of Object.entries(sharedFiles)) files[`/${name}`] = content;
	return { ...files, ...overrides };
}
