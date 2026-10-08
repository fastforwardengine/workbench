/**
 * The keys, with the Kitty keyboard flags that the terminal asks for. Each test
 * sends the bytes that Kitty and Ghostty send with these flags, through
 * OpenTUI's own parser.
 *
 * What the terminal sends: a text key arrives as plain text, for the press and
 * for each repeat. Its release is a `CSI u` code. Enter, Tab, and Backspace have
 * no release. A key without text, such as an arrow, sends press, repeat, and
 * release as `CSI` codes.
 *
 * What OpenTUI does with them: a press and a repeat are both `keypress`
 * events, and a flagged repeat has `repeated` set. A release is a `keyrelease`
 * event. The textarea and the Keys class listen to `keypress` only.
 */
import { buildKittyKeyboardFlags, type KeyEvent } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEYBOARD, keyboardProblem } from '../src/terminal/app/keyboard.ts';
import { Keys } from '../src/terminal/app/keys.ts';
import { Voice } from '../src/terminal/state/voice.ts';
import { Composer } from '../src/terminal/widgets/composer.ts';
import { Palette } from '../src/terminal/widgets/palette.ts';
import { fakeTake, quietParts } from './voice-fakes.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The release of a key, as a `CSI u` code. The code point is the key, and `mods` is 1 plus the modifier bits. */
const release = (key: number | string, mods = 1) =>
	`\x1b[${typeof key === 'string' ? key.codePointAt(0) : key};${mods}:3u`;

/** The keys without text, as the terminal sends them. */
const KEY = {
	enter: '\r',
	tab: '\t',
	backspace: '\x7f',
	escape: '\x1b[27u',
	shiftEnter: '\x1b[13;2u',
	ctrlC: '\x1b[99;5u',
	ctrlD: '\x1b[100;5u',
	ctrlDRepeat: '\x1b[100;5:2u',
	up: '\x1b[A',
	upRepeat: '\x1b[1;1:2A',
	upRelease: '\x1b[1;1:3A',
} as const;

/** The terminal, as `tui.ts` wires the keys, over a composer and a stub session. */
async function build(voice = new Voice(quietParts())) {
	const setup = await createTestRenderer({ width: 100, height: 20, useKittyKeyboard: KEYBOARD });
	cleanups.push(() => setup.renderer.destroy());
	const { renderer } = setup;
	const submit = vi.fn();
	const composer = new Composer(renderer, { submit, change: () => {} });
	renderer.root.add(composer.root);
	composer.focus();
	const session = {
		awaitingGoal: undefined as string | undefined,
		refItems: [],
		pickIds: [] as string[],
		say: vi.fn(),
		interrupt: vi.fn(),
		cancelWaiting: vi.fn(),
		suggestions: () => [],
	};
	const quit = vi.fn();
	const keys = new Keys({
		renderer,
		session: session as never,
		composer,
		palette: new Palette(composer),
		painter: { invalidate: () => {} } as never,
		dock: {} as never,
		viewfinder: {} as never,
		transcript: {} as never,
		voice,
		render: () => {},
		quit,
	});
	const onKey = vi.spyOn(keys, 'onKey');
	const onRelease = vi.spyOn(keys, 'onRelease');
	const seen: KeyEvent[] = [];
	const freed: KeyEvent[] = [];
	renderer.keyInput.on('keypress', (key: KeyEvent) => {
		seen.push(key);
		keys.onKey(key);
	});
	renderer.keyInput.on('keyrelease', (key: KeyEvent) => {
		freed.push(key);
		keys.onRelease(key);
	});
	const send = (...sequences: string[]) => {
		for (const sequence of sequences) renderer.stdin.emit('data', Buffer.from(sequence));
	};
	/** Type a text: the plain text of each key, then its release. */
	const type = (text: string) => {
		for (const char of text) send(char, release(char));
	};
	return {
		setup,
		composer,
		session,
		keys,
		onKey,
		onRelease,
		seen,
		freed,
		send,
		type,
		submit,
		quit,
	};
}

describe('the keyboard flags', () => {
	it('ask for disambiguation, alternate keys, and events', () => {
		expect(buildKittyKeyboardFlags(KEYBOARD)).toBe(1 | 2 | 4);
	});

	it('do not ask for all keys as escape codes, or for their text', () => {
		const flags = buildKittyKeyboardFlags(KEYBOARD);
		expect(flags & 8).toBe(0);
		expect(flags & 16).toBe(0);
		expect(KEYBOARD.allKeysAsEscapes).toBeUndefined();
		expect(KEYBOARD.reportText).toBeUndefined();
	});
});

describe('the terminal check for voice mode', () => {
	it('passes a terminal that reports the Kitty keyboard', () => {
		expect(keyboardProblem({ kitty_keyboard: true })).toBeUndefined();
	});

	it.each([
		['one that does not', { kitty_keyboard: false }],
		['one that has not answered', null],
		['no capabilities', undefined],
	])('refuses %s with one line', (_label, capabilities) => {
		const line = keyboardProblem(capabilities);
		expect(line).toBe(
			'Voice mode needs a terminal that reports key release, such as Ghostty or Kitty.',
		);
		expect(line).not.toContain('\n');
	});
});

describe('a key that the person presses and releases', () => {
	it('types each character once, with a release for each', async () => {
		const { composer, onKey, onRelease, type } = await build();
		type('hello world');
		expect(composer.text).toBe('hello world');
		expect(onKey).toHaveBeenCalledTimes(11);
		expect(onRelease).toHaveBeenCalledTimes(11);
	});

	it('runs the keypress listeners on a press and a repeat, and the keyrelease listeners on a release', async () => {
		const { seen, freed, send } = await build();
		send(KEY.up, KEY.upRepeat, KEY.upRepeat, KEY.upRelease);
		expect(seen.map((key) => [key.name, key.eventType, Boolean(key.repeated)])).toEqual([
			['up', 'press', false],
			['up', 'press', true],
			['up', 'press', true],
		]);
		expect(freed.map((key) => [key.name, key.eventType])).toEqual([['up', 'release']]);
	});

	it('types a held key once for each press and repeat', async () => {
		const { composer, send } = await build();
		send('a', 'a', 'a', release('a'));
		expect(composer.text).toBe('aaa');
	});

	it('types a capital letter once', async () => {
		const { composer, send, type } = await build();
		send('H', '\x1b[104:72;2:3u');
		type('i');
		expect(composer.text).toBe('Hi');
	});

	it('types the characters that Option makes on macOS, as the text that the terminal sends', async () => {
		const { composer, seen, send } = await build();
		send('µ', release('m', 3), 'Ω', release('z', 3), '∑', '°', '±');
		expect(composer.text).toBe('µΩ∑°±');
		expect(seen.every((key) => !key.meta)).toBe(true);
	});

	it('types an accented letter, and a letter from another script', async () => {
		const { composer, send } = await build();
		send('ä', 'ж');
		expect(composer.text).toBe('äж');
	});

	it('does not delete a word on a typed µ, as Option+d does', async () => {
		const { composer, send, type } = await build();
		type('one two ');
		send('µ');
		expect(composer.text).toBe('one two µ');
	});

	it('types a space once', async () => {
		const { composer, send, type } = await build();
		type('a');
		send(' ', release(' '));
		type('b');
		expect(composer.text).toBe('a b');
	});

	it('sends once on Enter', async () => {
		const { submit, send, type } = await build();
		type('hi');
		send(KEY.enter);
		expect(submit).toHaveBeenCalledTimes(1);
	});

	it('adds one line on Shift+Enter', async () => {
		const { composer, submit, send, type } = await build();
		type('a');
		send(KEY.shiftEnter);
		type('b');
		expect(submit).not.toHaveBeenCalled();
		expect(composer.text).toBe('a\nb');
	});

	it('deletes one character on Backspace', async () => {
		const { composer, send, type } = await build();
		type('abc');
		send(KEY.backspace);
		expect(composer.text).toBe('ab');
	});

	it('runs Tab once', async () => {
		const { session, send } = await build();
		send(KEY.tab);
		expect(session.say).toHaveBeenCalledTimes(1);
	});

	it('runs Escape once, and cancels a room that waits for its goal once', async () => {
		const { session, send } = await build();
		session.awaitingGoal = 'bench';
		send(KEY.escape, release(27));
		expect(session.cancelWaiting).toHaveBeenCalledTimes(1);
	});

	it('runs Ctrl+C once, and clears the composer', async () => {
		const { composer, session, send, type } = await build();
		type('abc');
		send(KEY.ctrlC, release('c', 5));
		expect(composer.text).toBe('');
		expect(session.interrupt).toHaveBeenCalledTimes(1);
	});

	it('quits once on two Ctrl+D', async () => {
		const { quit, send } = await build();
		send(KEY.ctrlD, release('d', 5));
		expect(quit).not.toHaveBeenCalled();
		send(KEY.ctrlD, release('d', 5));
		expect(quit).toHaveBeenCalledTimes(1);
	});

	it('ignores a repeat of Ctrl+D, and a later press leaves', async () => {
		const { quit, session, send } = await build();
		send(KEY.ctrlD, KEY.ctrlDRepeat, KEY.ctrlDRepeat, release('d', 5));
		expect(quit).not.toHaveBeenCalled();
		expect(session.say).toHaveBeenCalledTimes(1);
		send(KEY.ctrlD, release('d', 5));
		expect(quit).toHaveBeenCalledTimes(1);
	});

	it('keeps the draft on Ctrl+D, and does not leave', async () => {
		const { quit, composer, session, type, send } = await build();
		type('abc');
		send(KEY.ctrlD, release('d', 5), KEY.ctrlD, release('d', 5));
		expect(quit).not.toHaveBeenCalled();
		expect(session.say).not.toHaveBeenCalled();
		expect(composer.text).toBe('abc');
	});

	it('does not run a key handler on a release', async () => {
		const { onKey, send } = await build();
		send(release('a'), release(13), release(9), release(27), KEY.upRelease);
		expect(onKey).not.toHaveBeenCalled();
	});

	it('still takes a pasted text as one paste', async () => {
		const { composer, send } = await build();
		send('\x1b[200~line one\x1b[201~');
		expect(composer.text).toBe('line one');
	});
});

describe('hold Space to talk, through the parser', () => {
	async function talking(over = {}) {
		const time = { at: 1_000 };
		const delivered: string[] = [];
		const start = vi.fn(async () => fakeTake());
		const voice = new Voice(
			quietParts({
				now: () => time.at,
				start,
				transcribe: async () => 'check the supply',
				deliver: async (text) => {
					delivered.push(text);
				},
				...over,
			}),
		);
		await voice.toggle();
		const built = await build(voice);
		return { ...built, voice, time, delivered, start };
	}

	it('records on the first press, takes the plain repeats, types no space, and sends on the release', async () => {
		const { composer, send, voice, time, delivered, start } = await talking();
		send(' ');
		expect(voice.phase).toBe('listening');
		for (let repeat = 0; repeat < 30; repeat++) {
			time.at += 30;
			send(' ');
		}
		expect(composer.text).toBe('');
		expect(voice.phase).toBe('listening');
		time.at += 1_500;
		send(release(' '));
		await wait(20);
		expect(start).toHaveBeenCalledTimes(1);
		expect(delivered).toEqual(['check the supply']);
		expect(composer.text).toBe('');
		expect(voice.phase).toBe('idle');
	});

	it('sends the recording when Space comes up with Ctrl down', async () => {
		const { delivered, send, time, voice } = await talking();
		send(' ');
		expect(voice.phase).toBe('listening');
		time.at += 1_500;
		send(release(' ', 5));
		await wait(20);
		expect(delivered).toEqual(['check the supply']);
		expect(voice.phase).toBe('idle');
	});

	it('reads the press as the space key, and the CSI release as a release of it', async () => {
		const { seen, freed, send } = await talking();
		send(' ', release(' '));
		expect(seen.map((key) => key.name)).toEqual(['space']);
		expect(freed.map((key) => [key.name, key.eventType])).toEqual([['space', 'release']]);
	});

	it('types no space while repeats arrive during the transcription', async () => {
		const { composer, send, time, voice } = await talking({
			transcribe: () => new Promise(() => {}),
		});
		send(' ');
		time.at += 1_500;
		send(release(' '));
		await wait(10);
		expect(voice.phase).toBe('transcribing');
		for (let repeat = 0; repeat < 5; repeat++) {
			time.at += 30;
			send(' ');
		}
		expect(composer.text).toBe('');
	});

	it('sends nothing for a tap', async () => {
		const { send, time, delivered, composer } = await talking();
		send(' ');
		time.at += 100;
		send(release(' '));
		await wait(20);
		expect(delivered).toEqual([]);
		expect(composer.text).toBe('');
	});

	it('types a space when the composer holds text, and starts nothing', async () => {
		const { composer, send, type, start, voice } = await talking();
		type('/voice');
		send(' ', release(' '));
		expect(composer.text).toBe('/voice ');
		expect(start).not.toHaveBeenCalled();
		expect(voice.phase).toBe('idle');
	});

	it('drops the recording on Ctrl+C', async () => {
		const { send, voice, time, delivered } = await talking();
		send(' ');
		send(KEY.ctrlC, release('c', 5));
		expect(voice.phase).toBe('idle');
		time.at += 1_500;
		send(release(' '));
		await wait(20);
		expect(delivered).toEqual([]);
	});

	it('does not take Space when voice mode is off', async () => {
		const { composer, send } = await build();
		send(' ', release(' '));
		expect(composer.text).toBe(' ');
	});
});

describe('hold F13 to talk, through the parser', () => {
	/** F13 is a key without text: the press, the repeat, and the release are `CSI u` codes. */
	const F13 = { press: '\x1b[57376u', repeat: '\x1b[57376;1:2u', release: release(57376) };

	async function pedal(over = {}) {
		const time = { at: 1_000 };
		const delivered: string[] = [];
		const say = vi.fn();
		const start = vi.fn(async () => fakeTake());
		const voice = new Voice(
			quietParts({
				now: () => time.at,
				start,
				say,
				transcribe: async () => 'check the supply',
				deliver: async (text) => {
					delivered.push(text);
				},
				...over,
			}),
		);
		await voice.toggle();
		const built = await build(voice);
		return { ...built, voice, time, delivered, start, say };
	}

	it('reads the press as f13, the repeat as a flagged press, and the code as a release', async () => {
		const { seen, freed, send } = await pedal();
		send(F13.press, F13.repeat, F13.release);
		expect(seen.map((key) => [key.name, key.repeated])).toEqual([
			['f13', undefined],
			['f13', true],
		]);
		expect(freed.map((key) => [key.name, key.eventType])).toEqual([['f13', 'release']]);
	});

	it('records on the press, takes the repeats once, types nothing, and sends on the release', async () => {
		const { composer, send, voice, time, delivered, start } = await pedal();
		composer.setText('draft');
		send(F13.press);
		expect(voice.phase).toBe('listening');
		for (let repeat = 0; repeat < 30; repeat++) {
			time.at += 30;
			send(F13.repeat);
		}
		time.at += 1_500;
		send(F13.release);
		await wait(20);
		expect(start).toHaveBeenCalledTimes(1);
		expect(delivered).toEqual(['check the supply']);
		expect(composer.text).toBe('draft');
		expect(voice.phase).toBe('idle');
	});

	it('shows the note once when voice mode is off', async () => {
		const say = vi.fn();
		const { send } = await build(new Voice(quietParts({ say })));
		send(F13.press, F13.repeat, F13.repeat, F13.release);
		expect(say).toHaveBeenCalledTimes(1);
		expect(say).toHaveBeenCalledWith('Voice mode is off. /voice turns it on.');
	});
});
