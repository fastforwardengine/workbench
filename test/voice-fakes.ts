import { type Take, Voice, type VoiceParts } from '../src/terminal/state/voice.ts';

/** A recording that writes nothing. */
export function fakeTake(file = '/tmp/take.wav'): Take & { stopped: number } {
	const take = {
		file,
		stopped: 0,
		stop: async () => {
			take.stopped += 1;
		},
	};
	return take;
}

/** Voice parts that do nothing. A test overrides the parts that it checks. */
export function quietParts(over: Partial<VoiceParts> = {}): VoiceParts {
	return {
		ready: async () => undefined,
		start: async () => fakeTake(),
		transcribe: async () => '',
		discard: async () => {},
		place: () => 'priya/bench',
		deliver: async () => {},
		say: () => {},
		problem: () => {},
		changed: () => {},
		...over,
	};
}

/** A voice mode that is off and does nothing. */
export const quietVoice = (): Voice => new Voice(quietParts());
