/**
 * The LED sweep, kept as the project of the live evals. It was the first
 * project of Workbench. Its question has a known good answer, so the evals
 * stay cheap and stable. The rooms of the product follow the FM radio.
 * The evals give this project to `team` and this kit to `seedWorkspace`.
 */
import { type RoomPlan, seats } from '../../src/domain/room.ts';

/** The paragraph that opens the instructions of every seat. */
export const ledProject =
	'Workbench is a lab workspace for one bench project: an LED parameter sweep. ' +
	'A power supply drives an LED through a range of currents, and a camera measures the light at each step. ';

/** The files of the seed that this project replaces. */
export const ledFiles: Record<string, string> = {
	'/shared/kit.md': `# The project

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
- Record a decision in the notes, in \`decisions/\`, unless the person told you not to edit files.
`,
};

/** The first files of the notes repository in the evals: the LED sweep starts with an empty notebook. */
export const ledNotes: Record<string, string> = {
	'README.md': `# Notes of the team

These notes hold what the team knows about the LED sweep. One claim is one
bullet, with its source and its confidence.
`,
};

/** The room of the LED sweep, with the seats of the first version of Workbench. */
export const ledSweepRoom: RoomPlan & { seats: typeof seats } = {
	name: 'led-sweep',
	goal:
		'Sweep the drive current of an LED with a bench power supply, and measure the light ' +
		'at each step with a camera. Keep the current within the limit of the LED datasheet.',
	pattern: 'Datasheet limits → test plan → sweep',
	prompt: 'Plan the LED current sweep, and name the limits that it must respect.',
	seats,
};
