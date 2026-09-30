import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Attention } from '@ambionframework/ambion';
import { packageDirectory } from './package-root.ts';

/**
 * The seats of a room with no seats of its own. Three specialists hear every
 * message, at `broadcast`. The Builder listens at `named`. Only a directed say
 * from the assistant or a specialist wakes it, because a message from a person
 * names no seat.
 */
export const seats: Record<string, Attention> = {
	datasheets: 'broadcast',
	experiments: 'broadcast',
	instruments: 'broadcast',
	builder: 'named',
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
 * `/shared/bench.md` carries the state of the bench from one room to the next.
 */
export const scenarios: Scenario[] = [
	{
		name: 'radio-kit',
		goal:
			'Know the FM radio kit, and support the hand build of the first one. Record each part ' +
			'with its evidence in /shared/bench.md, find the datasheets and the schematic, and ' +
			'guide the person through the build. The first radio must play a station.',
		pattern: 'Parts → datasheets → schematic → build',
		prompt:
			'List the parts of the kit from the photo, and name the facts we must settle before the build.',
		seats: {
			builder: 'broadcast',
			datasheets: 'broadcast',
			experiments: 'named',
			instruments: 'named',
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
			instruments: 'broadcast',
			experiments: 'broadcast',
			datasheets: 'named',
			builder: 'named',
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
			builder: 'broadcast',
			instruments: 'broadcast',
			datasheets: 'named',
			experiments: 'named',
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
			instruments: 'broadcast',
			datasheets: 'broadcast',
			experiments: 'named',
			builder: 'named',
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

**\`/shared/bench.md\` holds the state of the bench.** Read it before you act,
in any room.

## Parts of the kit

These come from the product photo. Check each one against the kit.

- The FM tuner module: RDA5807FP-M, controlled over I²C.
- The microcontroller: STC8G1K, 16 pins, in a socket.
- The amplifier module: 8002. The power module: CAI-222.
- A 4-digit 7-segment display, and four buttons: V−, V+, CH−, CH+.
- A speaker, a headphone jack, a telescopic antenna, and a case.

## On the bench

- Two FM radio kits, the ELEGOO Electronics Fun Kit, and soldering equipment.
- A HANMATEK HM310P power supply, a Logitech BRIO camera, and a USB microphone.
- A Raspberry Pi Pico for paths A and B (to buy).

## House rules

- Read the datasheet in /library before you state a limit. Cite the path.
- A measurement counts only when a script read it from a device. Cite the
  file that the script wrote. Every other value is a planned value.
- The first power-on of a kit goes through the HM310P, with a current limit.
  Stop at once on an abnormal current.
- The power stays off until the checks of the build pass.
- Record a decision in /shared/notes.md when the person permits file edits.
`,
	'shared/bench.md': `# The bench

**This file is the state of the bench.** Every room reads it before it acts,
and updates it when it learns a fact. Each fact has a source, a time, and a
confidence. Two facts that disagree stay in the list of conflicts until the
person or new evidence settles them. Do not delete a fact of another seat.

Confidence is \`high\` (a reading or a cited photo), \`medium\` (a datasheet), or
\`low\` (a guess or the product photo).

## The build

| Kit    | Step        | State       | Evidence |
| ------ | ----------- | ----------- | -------- |
| First  | not started |             |          |
| Second | not started |             |          |

## The parts

| Part                         | Marking in the photo | Checked against the kit | Source        | Confidence |
| ---------------------------- | -------------------- | ----------------------- | ------------- | ---------- |
| FM tuner module              | RDA5807FP-M          | no                      | product photo | low        |
| Microcontroller, 16 pins     | STC8G1K, in a socket | no                      | product photo | low        |
| Amplifier module             | 8002                 | no                      | product photo | low        |
| Power module                 | CAI-222              | no                      | product photo | low        |
| 4-digit 7-segment display    |                      | no                      | product photo | low        |
| Buttons                      | V−, V+, CH−, CH+     | no                      | product photo | low        |

## The instruments

| Device                | State        | Source | Time |
| --------------------- | ------------ | ------ | ---- |
| HANMATEK HM310P       | not scanned  |        |      |
| Logitech BRIO camera  | not scanned  |        |      |
| USB microphone        | not scanned  |        |      |
| Raspberry Pi Pico     | not on hand  |        |      |

## The radio

| Fact                    | Value   | Source | Time | Confidence |
| ----------------------- | ------- | ------ | ---- | ---------- |
| Plays a station         | unknown |        |      |            |
| Frequency               | unknown |        |      |            |
| Current at 5 V, idle    | unknown |        |      |            |

## Open conflicts

None.
`,
	'shared/notes.md': `# Lab notes

Status: empty. Record decisions and test plans here.
`,
};

/**
 * The seed of a workspace: each file by its workspace path, such as
 * `/shared/kit.md`. The library comes from `library/` of the package. The
 * host writes each file that the workspace does not hold yet, so an edit
 * always remains. `overrides` replaces files of the seed by path, as an eval
 * of another project does.
 */
export function seedFiles(overrides: Record<string, string> = {}): Record<string, string> {
	const files: Record<string, string> = {};
	for (const entry of readdirSync(libraryDirectory, { withFileTypes: true })) {
		if (entry.isFile())
			files[`/library/${entry.name}`] = readFileSync(join(libraryDirectory, entry.name), 'utf8');
	}
	for (const [name, content] of Object.entries(sharedFiles)) files[`/${name}`] = content;
	return { ...files, ...overrides };
}
