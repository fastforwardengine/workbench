import type { Attention } from '@ambionframework/ambion';

/**
 * The seats of every room. The Engineer hears every message, at `broadcast`,
 * to keep its view of the bench current. The Researcher waits at `named`.
 * It wakes only on a directed say from the assistant, the Engineer, or the
 * person (`@researcher`).
 */
export const seats: Record<string, Attention> = {
	researcher: 'named',
	engineer: 'broadcast',
};

/** A room of the project: what it is for, how the header names it, and what `/try` asks. */
export interface RoomPlan {
	name: string;
	goal: string;
	/** The line the header shows: the phases of the room, in order. */
	pattern: string;
	/** The question that `/try` puts in the composer. */
	prompt: string;
}

/**
 * The seeded room of the FM radio milestone. It holds every phase, and the
 * notes (`shared/notes`) carry the state of the bench from one phase to the next.
 */
export const buildRoom: RoomPlan = {
	name: 'build',
	goal:
		'Know the FM radio kit, and support the hand build of the first one. Record each part ' +
		'with its evidence in the notes. The first radio must play a station. ' +
		'Then tune the radio. Path A: a Pico presses the buttons, and the camera reads the display. ' +
		'Path B: the Pico drives the tuner over I²C, and a scan maps the stations of the band. ' +
		'Then guide the build of the second kit, check each polarized part from a photo before it ' +
		'is soldered, and power the kit on through the HM310P with a current limit. ' +
		'Last, path C: new firmware for the STC8G1K that takes serial commands.',
	pattern: 'Kit → first build → tune → second build → firmware',
	prompt:
		'List the parts of the kit from the notes, and name the facts we must settle before the build.',
};
