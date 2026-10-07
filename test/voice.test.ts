/**
 * The rules of voice mode, over fake parts: no microphone, no whisper, no OpenTUI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	cleanTranscript,
	HOLD_GAP_MS,
	MAX_HOLD_MS,
	MIN_HOLD_MS,
	oneLine,
	Voice,
	type VoiceKey,
	type VoiceParts,
} from '../src/terminal/state/voice.ts';
import { fakeTake, quietParts } from './voice-fakes.ts';

const space: VoiceKey = { name: 'space', ctrl: false, meta: false, shift: false };

/** A clock that the test moves. */
function clock() {
	const time = { at: 1_000 };
	return { time, now: () => time.at };
}

/** A voice mode that is on, with fakes that record what happens. */
async function ready(over: Partial<VoiceParts> = {}) {
	const { time, now } = clock();
	const log = {
		said: [] as string[],
		problems: [] as (string | undefined)[],
		delivered: [] as string[],
		discarded: [] as string[],
		changes: 0,
	};
	const take = fakeTake('/tmp/one.wav');
	const parts = quietParts({
		now,
		start: async () => take,
		transcribe: async () => 'check the supply',
		discard: async (file) => {
			log.discarded.push(file);
		},
		deliver: async (text) => {
			log.delivered.push(text);
		},
		say: (note) => log.said.push(note),
		problem: (line) => log.problems.push(line),
		changed: () => {
			log.changes += 1;
		},
		...over,
	});
	const voice = new Voice(parts);
	await voice.toggle();
	return { voice, time, log, take };
}

/** Hold Space for some milliseconds, then let go. It returns when the release work ends. */
async function hold(voice: Voice, time: { at: number }, ms: number, composerEmpty = true) {
	voice.press(space, composerEmpty);
	time.at += ms;
	await voice.release();
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('switching voice mode', () => {
	it('turns on when the parts are ready, and off on the second switch', async () => {
		const { voice } = await ready();
		expect(voice.on).toBe(true);
		await voice.toggle();
		expect(voice.on).toBe(false);
	});

	it('stays off and says the fix when the parts are not ready', async () => {
		const said: string[] = [];
		const voice = new Voice(
			quietParts({
				ready: async () => 'Voice mode stays off.\nInstall whisper.cpp: brew install whisper-cpp',
				say: (note) => said.push(note),
			}),
		);
		await voice.toggle();
		expect(voice.on).toBe(false);
		expect(said).toEqual(['Voice mode stays off.\nInstall whisper.cpp: brew install whisper-cpp']);
	});

	it('checks once when the person switches twice at once', async () => {
		const ready = vi.fn(async () => undefined);
		const voice = new Voice(quietParts({ ready }));
		await Promise.all([voice.toggle(), voice.toggle()]);
		expect(ready).toHaveBeenCalledTimes(1);
		expect(voice.on).toBe(true);
	});
});

describe('the transcriber', () => {
	it('starts when voice mode turns on and ends when it turns off', async () => {
		const serve = vi.fn();
		const halt = vi.fn();
		const { voice } = await ready({ serve, halt });
		expect(serve).toHaveBeenCalledTimes(1);
		expect(halt).not.toHaveBeenCalled();
		await voice.toggle();
		expect(halt).toHaveBeenCalledTimes(1);
	});

	it('does not start when the check fails', async () => {
		const serve = vi.fn();
		const voice = new Voice(quietParts({ ready: async () => 'Voice mode stays off.', serve }));
		await voice.toggle();
		expect(serve).not.toHaveBeenCalled();
	});

	it('starts again at the next press, for a transcriber that failed', async () => {
		const serve = vi.fn();
		const { voice, time } = await ready({ serve });
		await hold(voice, time, 1_000);
		expect(serve).toHaveBeenCalledTimes(2);
	});

	it('does not start when the terminal ends during the check', async () => {
		let answer: (problem: string | undefined) => void = () => {};
		const serve = vi.fn();
		const voice = new Voice(
			quietParts({ ready: () => new Promise((resolve) => (answer = resolve)), serve }),
		);
		const toggled = voice.toggle();
		voice.dispose();
		answer(undefined);
		await toggled;
		expect(serve).not.toHaveBeenCalled();
		expect(voice.on).toBe(false);
	});

	it('ends at dispose', async () => {
		const halt = vi.fn();
		const { voice } = await ready({ halt });
		voice.dispose();
		expect(halt).toHaveBeenCalledTimes(1);
	});

	it('shows the loading line while the model loads, in every phase', async () => {
		let loading = true;
		const { voice, time } = await ready({ loading: () => loading });
		expect(voice.line).toContain('loading model');
		voice.press(space, true);
		expect(voice.line).toBe('listening');
		time.at += 1_000;
		const released = voice.release();
		expect(voice.line).toBe('loading model');
		loading = false;
		await released;
		expect(voice.line).toContain('hold Space to talk');
	});

	it('records while the model loads, and sends the take after the model is ready', async () => {
		let loaded!: () => void;
		const model = new Promise<void>((resolve) => (loaded = resolve));
		const { voice, time, log } = await ready({
			loading: () => true,
			transcribe: async () => {
				await model;
				return 'check the supply';
			},
		});
		voice.press(space, true);
		time.at += 1_000;
		const released = voice.release();
		await vi.advanceTimersByTimeAsync(0);
		expect(log.delivered).toEqual([]);
		loaded();
		await released;
		expect(log.delivered).toEqual(['check the supply']);
	});

	it('shows the line of a transcriber that ended, and clears it at the next press', async () => {
		let shown: string | undefined;
		const { voice } = await ready({
			problem: (line) => {
				shown = line;
			},
			shown: () => shown,
		});
		voice.crashed('whisper-server stopped: failed to load');
		expect(shown).toBe('whisper-server stopped: failed to load');
		voice.press(space, true);
		expect(shown).toBeUndefined();
	});

	it('ignores the end of a transcriber when voice mode is off', async () => {
		const { voice, log } = await ready();
		await voice.toggle();
		voice.crashed('whisper-server stopped: late');
		expect(log.problems).toEqual([]);
	});
});

describe('the Space key', () => {
	it('is not taken when voice mode is off', () => {
		const voice = new Voice(quietParts());
		expect(voice.press(space, true)).toBe(false);
		expect(voice.phase).toBe('idle');
	});

	it('types a space when the composer holds text, so the person can type /voice', async () => {
		const { voice } = await ready();
		expect(voice.press(space, false)).toBe(false);
		expect(voice.phase).toBe('idle');
	});

	it.each([
		['Ctrl', { ctrl: true }],
		['Alt', { meta: true }],
		['Shift', { shift: true }],
		['Super', { super: true }],
	])('does not start on Space with %s', async (_label, modifier) => {
		const { voice } = await ready();
		expect(voice.press({ ...space, ...modifier }, true)).toBe(false);
		expect(voice.phase).toBe('idle');
	});

	it('does not take another key', async () => {
		const { voice } = await ready();
		expect(voice.press({ ...space, name: 'a' }, true)).toBe(false);
	});

	it('starts a recording on an empty composer, and takes the key', async () => {
		const { voice } = await ready();
		expect(voice.press(space, true)).toBe(true);
		expect(voice.phase).toBe('listening');
	});

	it('ignores key repeat while the person holds it, and takes each repeat', async () => {
		const start = vi.fn(async () => fakeTake());
		const { voice } = await ready({ start });
		voice.press(space, true);
		for (let repeat = 0; repeat < 5; repeat++)
			expect(voice.press({ ...space, repeated: true }, true)).toBe(true);
		expect(start).toHaveBeenCalledTimes(1);
		expect(voice.phase).toBe('listening');
	});

	it('takes the key while it listens, even when the composer holds text', async () => {
		const { voice } = await ready();
		voice.press(space, true);
		expect(voice.press({ ...space, repeated: true }, false)).toBe(true);
	});

	it('does not start from a repeat', async () => {
		const start = vi.fn(async () => fakeTake());
		const { voice } = await ready({ start });
		expect(voice.press({ ...space, repeated: true }, true)).toBe(true);
		expect(start).not.toHaveBeenCalled();
		expect(voice.phase).toBe('idle');
	});

	it('ignores a release when nothing records', async () => {
		const { voice, log } = await ready();
		await voice.release();
		expect(log.delivered).toEqual([]);
	});
});

describe('a hold', () => {
	it('stops the recording, reads it, deletes the file, and sends the words', async () => {
		const { voice, time, log, take } = await ready();
		await hold(voice, time, MIN_HOLD_MS + 200);
		expect(take.stopped).toBe(1);
		expect(log.delivered).toEqual(['check the supply']);
		expect(log.discarded).toEqual(['/tmp/one.wav']);
		expect(voice.phase).toBe('idle');
	});

	it('shows transcribing while whisper runs', async () => {
		let finish: (text: string) => void = () => {};
		const { voice, time } = await ready({
			transcribe: () => new Promise<string>((resolve) => (finish = resolve)),
		});
		voice.press(space, true);
		time.at += 1_000;
		const released = voice.release();
		await vi.advanceTimersByTimeAsync(0);
		expect(voice.phase).toBe('transcribing');
		expect(voice.line).toBe('transcribing');
		finish('hello');
		await released;
		expect(voice.phase).toBe('idle');
	});

	it('sends nothing for a press shorter than 300 ms, and deletes the file', async () => {
		const transcribe = vi.fn(async () => 'x');
		const { voice, time, log, take } = await ready({ transcribe });
		await hold(voice, time, MIN_HOLD_MS - 1);
		expect(transcribe).not.toHaveBeenCalled();
		expect(log.delivered).toEqual([]);
		expect(take.stopped).toBe(1);
		expect(log.discarded).toEqual(['/tmp/one.wav']);
		expect(voice.phase).toBe('idle');
	});

	it('sends a press of exactly 300 ms', async () => {
		const { voice, time, log } = await ready();
		await hold(voice, time, MIN_HOLD_MS);
		expect(log.delivered).toEqual(['check the supply']);
	});

	it('sends nothing for an empty transcript, and says so', async () => {
		const { voice, time, log } = await ready({ transcribe: async () => '' });
		await hold(voice, time, 1_000);
		expect(log.delivered).toEqual([]);
		expect(log.said).toEqual(['No speech heard.']);
	});

	it('records again after a hold ends', async () => {
		const start = vi.fn(async () => fakeTake());
		const { voice, time, log } = await ready({ start });
		await hold(voice, time, 1_000);
		await hold(voice, time, 1_000);
		expect(start).toHaveBeenCalledTimes(2);
		expect(log.delivered).toHaveLength(2);
	});

	it('ends a hold by itself at the limit, when no release comes', async () => {
		const { voice, time, log } = await ready();
		voice.press(space, true);
		time.at += MAX_HOLD_MS;
		await vi.advanceTimersByTimeAsync(MAX_HOLD_MS);
		expect(log.delivered).toEqual(['check the supply']);
		// The late release changes nothing.
		await voice.release();
		expect(log.delivered).toHaveLength(1);
	});

	it('does not start a second recording from the repeats after the limit', async () => {
		const start = vi.fn(async () => fakeTake());
		const { voice, time } = await ready({ start });
		voice.press(space, true);
		// Plain repeats of a text key carry no flag. They keep coming while the hold lasts.
		for (let spent = 0; spent < MAX_HOLD_MS; spent += 1_000) {
			time.at += 1_000;
			voice.press(space, true);
		}
		await vi.advanceTimersByTimeAsync(MAX_HOLD_MS);
		for (let repeat = 0; repeat < 5; repeat++) {
			time.at += 30;
			expect(voice.press(space, true)).toBe(true);
		}
		await vi.advanceTimersByTimeAsync(0);
		expect(start).toHaveBeenCalledTimes(1);
		await voice.release();
		voice.press(space, true);
		expect(start).toHaveBeenCalledTimes(2);
	});

	it('takes the repeats of a held Space that carry no flag, and starts one recording', async () => {
		const start = vi.fn(async () => fakeTake());
		const { voice, time, log } = await ready({ start });
		voice.press(space, true);
		for (let repeat = 0; repeat < 20; repeat++) {
			time.at += 30;
			expect(voice.press(space, true)).toBe(true);
		}
		await voice.release();
		expect(start).toHaveBeenCalledTimes(1);
		expect(log.delivered).toEqual(['check the supply']);
	});

	it('takes the repeats that arrive while whisper runs, and starts nothing', async () => {
		const start = vi.fn(async () => fakeTake());
		const { voice, time } = await ready({
			start,
			transcribe: () => new Promise<string>(() => {}),
		});
		voice.press(space, true);
		time.at += 1_000;
		void voice.release();
		await vi.advanceTimersByTimeAsync(0);
		for (let repeat = 0; repeat < 5; repeat++) {
			time.at += 30;
			expect(voice.press(space, true)).toBe(true);
		}
		expect(start).toHaveBeenCalledTimes(1);
	});

	it('starts again after a release that never came, once the repeats have stopped', async () => {
		const start = vi.fn(async () => fakeTake());
		const { voice, time } = await ready({ start });
		voice.press(space, true);
		time.at += MAX_HOLD_MS;
		await vi.advanceTimersByTimeAsync(MAX_HOLD_MS);
		time.at += HOLD_GAP_MS + 1;
		voice.press(space, true);
		expect(start).toHaveBeenCalledTimes(2);
	});

	it('releases before the recorder has started, and still stops it', async () => {
		let begin: () => void = () => {};
		const take = fakeTake();
		const { voice, time, log } = await ready({
			start: () => new Promise((resolve) => (begin = () => resolve(take))),
		});
		voice.press(space, true);
		time.at += 1_000;
		const released = voice.release();
		begin();
		await released;
		expect(take.stopped).toBe(1);
		expect(log.delivered).toEqual(['check the supply']);
	});

	it('waits for a closing recording before it starts the next one', async () => {
		let closed: () => void = () => {};
		const slow = { ...fakeTake(), stop: () => new Promise<void>((resolve) => (closed = resolve)) };
		const start = vi.fn(async () => slow);
		const { voice, time } = await ready({ start });
		voice.press(space, true);
		time.at += 100;
		const released = voice.release();
		await vi.advanceTimersByTimeAsync(0);
		expect(voice.press(space, true)).toBe(true);
		expect(start).toHaveBeenCalledTimes(1);
		closed();
		await released;
		voice.press(space, true);
		expect(start).toHaveBeenCalledTimes(2);
	});
});

describe('a failure', () => {
	it('shows one line when the recorder does not start, and goes back to idle', async () => {
		const { voice, log } = await ready({
			start: async () => {
				throw new Error('Audio recorder capture start failed\nmore detail');
			},
		});
		voice.press(space, true);
		await vi.advanceTimersByTimeAsync(0);
		expect(voice.phase).toBe('idle');
		expect(log.problems.at(-1)).toBe('Cannot record: Audio recorder capture start failed');
		await voice.release();
		expect(log.delivered).toEqual([]);
	});

	it('shows one line when whisper fails, and deletes the file', async () => {
		const { voice, time, log } = await ready({
			transcribe: async () => {
				throw new Error('whisper-server answered 500: failed to open model\nstack');
			},
		});
		await hold(voice, time, 1_000);
		expect(log.problems.at(-1)).toBe('whisper-server answered 500: failed to open model');
		expect(log.delivered).toEqual([]);
		expect(log.discarded).toEqual(['/tmp/one.wav']);
		expect(voice.phase).toBe('idle');
	});

	it('shows one line when the recording does not finish', async () => {
		const take = {
			...fakeTake(),
			stop: async () => {
				throw new Error('The recording did not finish.');
			},
		};
		const { voice, time, log } = await ready({ start: async () => take });
		await hold(voice, time, 1_000);
		expect(log.problems.at(-1)).toBe('The recording did not finish.');
		expect(log.delivered).toEqual([]);
	});

	it('clears its own failure line when a new recording starts', async () => {
		const shown = { line: undefined as string | undefined };
		const { voice, time } = await ready({
			transcribe: async () => {
				throw new Error('whisper-server answered 500: no model');
			},
			problem: (line) => {
				shown.line = line;
			},
			shown: () => shown.line,
		});
		await hold(voice, time, 1_000);
		expect(shown.line).toBe('whisper-server answered 500: no model');
		voice.press(space, true);
		expect(shown.line).toBeUndefined();
	});

	it('leaves an error that it did not set', async () => {
		const problem = vi.fn();
		const { voice, time } = await ready({ problem, shown: () => 'Error: the send failed' });
		await hold(voice, time, 1_000);
		expect(problem).not.toHaveBeenCalled();
	});

	it('leaves a line that a later error replaced', async () => {
		const shown = { line: undefined as string | undefined };
		const problem = vi.fn((line: string | undefined) => {
			shown.line = line;
		});
		const { voice, time } = await ready({
			transcribe: async () => {
				throw new Error('whisper-server answered 500: no model');
			},
			problem,
			shown: () => shown.line,
		});
		await hold(voice, time, 1_000);
		shown.line = 'Error: the send failed';
		voice.press(space, true);
		expect(shown.line).toBe('Error: the send failed');
	});
});

describe('the room that the transcript goes to', () => {
	it('sends it to the room that was open at the press', async () => {
		const place = { now: 'priya/bench' };
		const { voice, time, log } = await ready({ place: () => place.now });
		await hold(voice, time, 1_000);
		expect(log.delivered).toEqual(['check the supply']);
	});

	it('drops it, and shows the words, when the person switched room while whisper ran', async () => {
		const place = { now: 'priya/bench' };
		let finish: (text: string) => void = () => {};
		const { voice, time, log } = await ready({
			place: () => place.now,
			transcribe: () => new Promise<string>((resolve) => (finish = resolve)),
		});
		voice.press(space, true);
		time.at += 1_000;
		const released = voice.release();
		await vi.advanceTimersByTimeAsync(0);
		place.now = 'priya/budget';
		finish('check the supply');
		await released;
		expect(log.delivered).toEqual([]);
		expect(log.said).toEqual([
			'Dropped the transcript, because the room changed: check the supply',
		]);
	});

	it('drops it when the person switched to another person', async () => {
		const place = { now: 'priya/bench' };
		const { voice, time, log } = await ready({
			place: () => place.now,
			transcribe: async () => {
				place.now = 'noor/bench';
				return 'hello';
			},
		});
		await hold(voice, time, 1_000);
		expect(log.delivered).toEqual([]);
		expect(log.said).toHaveLength(1);
	});
});

describe('cancel', () => {
	it('does nothing when idle', async () => {
		const { voice } = await ready();
		expect(voice.cancel()).toBe(false);
	});

	it('drops a recording: stops it, deletes the file, and sends nothing', async () => {
		const { voice, time, log, take } = await ready();
		voice.press(space, true);
		expect(voice.cancel()).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(voice.phase).toBe('idle');
		expect(take.stopped).toBe(1);
		expect(log.discarded).toEqual(['/tmp/one.wav']);
		// The release that follows changes nothing.
		time.at += 1_000;
		await voice.release();
		expect(log.delivered).toEqual([]);
	});

	it('stops whisper and sends nothing while it transcribes', async () => {
		let signal: AbortSignal | undefined;
		const { voice, time, log } = await ready({
			transcribe: (_file, abort) =>
				new Promise<string>((_resolve, reject) => {
					signal = abort;
					abort.addEventListener('abort', () => reject(new Error('aborted')));
				}),
		});
		voice.press(space, true);
		time.at += 1_000;
		const released = voice.release();
		await vi.advanceTimersByTimeAsync(0);
		expect(voice.cancel()).toBe(true);
		await released;
		expect(signal?.aborted).toBe(true);
		expect(log.delivered).toEqual([]);
		expect(log.problems.at(-1)).toBeUndefined();
		expect(log.discarded).toEqual(['/tmp/one.wav']);
	});

	it('runs when the person switches voice mode off', async () => {
		const { voice, log } = await ready();
		voice.press(space, true);
		await voice.toggle();
		await vi.advanceTimersByTimeAsync(0);
		expect(voice.on).toBe(false);
		expect(voice.phase).toBe('idle');
		expect(log.discarded).toEqual(['/tmp/one.wav']);
	});

	it('drops the words that arrive after a cancel', async () => {
		let finish: (text: string) => void = () => {};
		const { voice, time, log } = await ready({
			transcribe: () => new Promise<string>((resolve) => (finish = resolve)),
		});
		voice.press(space, true);
		time.at += 1_000;
		const released = voice.release();
		await vi.advanceTimersByTimeAsync(0);
		voice.cancel();
		finish('late words');
		await released;
		expect(log.delivered).toEqual([]);
	});
});

describe('dispose', () => {
	it('stops the transcription and sends nothing', async () => {
		let finish: (text: string) => void = () => {};
		const { voice, time, log } = await ready({
			transcribe: () => new Promise<string>((resolve) => (finish = resolve)),
		});
		voice.press(space, true);
		time.at += 1_000;
		const released = voice.release();
		await vi.advanceTimersByTimeAsync(0);
		voice.dispose();
		finish('hello');
		await released;
		expect(log.delivered).toEqual([]);
	});

	it('starts nothing after it', async () => {
		const start = vi.fn(async () => fakeTake());
		const { voice } = await ready({ start });
		voice.dispose();
		voice.press(space, true);
		expect(start).not.toHaveBeenCalled();
	});

	it('clears the limit timer of a hold', async () => {
		const { voice, log } = await ready();
		voice.press(space, true);
		voice.dispose();
		await vi.advanceTimersByTimeAsync(MAX_HOLD_MS);
		expect(log.delivered).toEqual([]);
	});
});

describe('the text of whisper-server', () => {
	it('joins the lines and trims', () => {
		expect(cleanTranscript(' Hello there.\n  Check the supply. \n')).toBe(
			'Hello there. Check the supply.',
		);
	});

	it('treats a line that names a sound as no speech', () => {
		expect(cleanTranscript(' [BLANK_AUDIO]\n')).toBe('');
		expect(cleanTranscript('(wind blowing)\n[Music]\n')).toBe('');
		expect(cleanTranscript('[BLANK_AUDIO]\nSet five volts.')).toBe('Set five volts.');
	});

	it('keeps brackets inside a sentence', () => {
		expect(cleanTranscript('Read [the register] now.')).toBe('Read [the register] now.');
	});

	it('is empty for empty output', () => {
		expect(cleanTranscript('')).toBe('');
		expect(cleanTranscript('\n  \n')).toBe('');
	});
});

describe('one line of an error', () => {
	it('takes the first non-empty line, and at most 200 characters', () => {
		expect(oneLine(new Error('\n\nfirst\nsecond'))).toBe('first');
		expect(oneLine('x'.repeat(500))).toHaveLength(200);
	});
});
