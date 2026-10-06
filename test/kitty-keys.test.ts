/**
 * The keys, with the Kitty keyboard flags that the terminal asks for. Each test
 * sends the escape codes that Kitty and Ghostty send, through OpenTUI's own
 * parser: a press, a repeat, and a release for each key.
 *
 * What OpenTUI does with them: a press and a repeat are both `keypress`
 * events, and a repeat has `repeated` set. A release is a `keyrelease` event.
 * The textarea and the Keys class listen to `keypress` only.
 */
import { buildKittyKeyboardFlags, type KeyEvent } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEYBOARD } from '../src/terminal/app/keyboard.ts';
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

/** The code points that the tests use. */
const CODE = { space: 32, enter: 13, tab: 9, escape: 27, backspace: 127, shift: 57441 } as const;

/** One escape code: key, modifiers, event type (1 press, 2 repeat, 3 release), and text. */
function code(
	key: number,
	options: { mods?: number; type?: 1 | 2 | 3; text?: number; shifted?: number } = {},
) {
	const { mods = 1, type = 1, text, shifted } = options;
	const first = shifted ? `${key}:${shifted}` : `${key}`;
	return `\x1b[${first};${mods}:${type}${text ? `;${text}` : ''}u`;
}

const press = (key: number, text?: number) => code(key, { text });
const repeat = (key: number, text?: number) => code(key, { type: 2, text });
const release = (key: number) => code(key, { type: 3 });

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
		surfaces: {} as never,
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
	/** Type a text of lowercase letters and spaces: a press and a release for each. */
	const type = (text: string) => {
		for (const char of text) {
			const point = char.codePointAt(0) ?? 0;
			send(press(point, point), release(point));
		}
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
	it('ask for disambiguation, alternate keys, events, all keys as escapes, and text', () => {
		expect(buildKittyKeyboardFlags(KEYBOARD)).toBe(1 | 2 | 4 | 8 | 16);
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
		send(press(97, 97), repeat(97, 97), repeat(97, 97), release(97));
		expect(seen.map((key) => [key.eventType, Boolean(key.repeated)])).toEqual([
			['press', false],
			['press', true],
			['press', true],
		]);
		expect(freed.map((key) => key.eventType)).toEqual(['release']);
	});

	it('types a held key once for each press and repeat, as a terminal without release events does', async () => {
		const { composer, send } = await build();
		send(press(97, 97), repeat(97, 97), repeat(97, 97), release(97));
		expect(composer.text).toBe('aaa');
	});

	it('types a capital letter once', async () => {
		const { composer, send } = await build();
		send(
			code(CODE.shift, { mods: 2 }),
			code(104, { mods: 2, shifted: 72, text: 72 }),
			code(104, { mods: 2, type: 3, shifted: 72 }),
			code(CODE.shift, { mods: 1, type: 3 }),
		);
		send(press(105, 105), release(105));
		expect(composer.text).toBe('Hi');
	});

	it('types nothing for a modifier key alone', async () => {
		const { composer, send, onKey } = await build();
		send(code(CODE.shift, { mods: 2 }), code(CODE.shift, { mods: 1, type: 3 }));
		send(code(57442, { mods: 5 }), code(57442, { mods: 1, type: 3 }));
		expect(composer.text).toBe('');
		expect(onKey.mock.calls.every(([key]) => key.name !== 'space')).toBe(true);
	});

	it('types a space once', async () => {
		const { composer, send, type } = await build();
		type('a');
		send(press(CODE.space, CODE.space), release(CODE.space));
		type('b');
		expect(composer.text).toBe('a b');
	});

	it('sends once on Enter, and not on its release', async () => {
		const { submit, send, type } = await build();
		type('hi');
		send(press(CODE.enter), release(CODE.enter));
		expect(submit).toHaveBeenCalledTimes(1);
	});

	it('adds one line on Shift+Enter', async () => {
		const { composer, submit, send, type } = await build();
		type('a');
		send(code(CODE.enter, { mods: 2 }), code(CODE.enter, { mods: 2, type: 3 }));
		type('b');
		expect(submit).not.toHaveBeenCalled();
		expect(composer.text).toBe('a\nb');
	});

	it('deletes one character on Backspace, and not on its release', async () => {
		const { composer, send, type } = await build();
		type('abc');
		send(press(CODE.backspace), release(CODE.backspace));
		expect(composer.text).toBe('ab');
	});

	it('runs Tab once', async () => {
		const { session, send } = await build();
		send(press(CODE.tab), release(CODE.tab));
		expect(session.say).toHaveBeenCalledTimes(1);
	});

	it('runs Escape once, and cancels a room that waits for its goal once', async () => {
		const { session, send } = await build();
		session.awaitingGoal = 'bench';
		send(press(CODE.escape), release(CODE.escape));
		expect(session.cancelWaiting).toHaveBeenCalledTimes(1);
	});

	it('runs Ctrl+C once, and clears the composer', async () => {
		const { composer, session, send, type } = await build();
		type('abc');
		send(code(99, { mods: 5 }), code(99, { mods: 5, type: 3 }));
		expect(composer.text).toBe('');
		expect(session.interrupt).toHaveBeenCalledTimes(1);
	});

	it('quits once on Ctrl+D with an empty composer', async () => {
		const { quit, send } = await build();
		send(code(100, { mods: 5 }), code(100, { mods: 5, type: 3 }));
		expect(quit).toHaveBeenCalledTimes(1);
	});

	it('does not run a key handler on a release', async () => {
		const { onKey, send } = await build();
		send(release(97), release(CODE.enter), release(CODE.tab), release(CODE.escape));
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

	it('records on the first press, ignores the repeats, and sends on the release', async () => {
		const { composer, send, voice, time, delivered, start } = await talking();
		send(press(CODE.space, CODE.space));
		expect(voice.phase).toBe('listening');
		send(
			repeat(CODE.space, CODE.space),
			repeat(CODE.space, CODE.space),
			repeat(CODE.space, CODE.space),
		);
		time.at += 1_500;
		send(release(CODE.space));
		await wait(20);
		expect(start).toHaveBeenCalledTimes(1);
		expect(delivered).toEqual(['check the supply']);
		expect(composer.text).toBe('');
		expect(voice.phase).toBe('idle');
	});

	it('sends nothing for a tap', async () => {
		const { send, time, delivered, composer } = await talking();
		send(press(CODE.space, CODE.space));
		time.at += 100;
		send(release(CODE.space));
		await wait(20);
		expect(delivered).toEqual([]);
		expect(composer.text).toBe('');
	});

	it('types a space when the composer holds text, and starts nothing', async () => {
		const { composer, send, type, start, voice } = await talking();
		type('/voice');
		send(press(CODE.space, CODE.space), release(CODE.space));
		expect(composer.text).toBe('/voice ');
		expect(start).not.toHaveBeenCalled();
		expect(voice.phase).toBe('idle');
	});

	it('drops the recording on Ctrl+C', async () => {
		const { send, voice, time, delivered } = await talking();
		send(press(CODE.space, CODE.space));
		send(code(99, { mods: 5 }), code(99, { mods: 5, type: 3 }));
		expect(voice.phase).toBe('idle');
		time.at += 1_500;
		send(release(CODE.space));
		await wait(20);
		expect(delivered).toEqual([]);
	});

	it('does not take Space when voice mode is off', async () => {
		const { composer, send, start } = await build().then((built) => ({
			...built,
			start: vi.fn(),
		}));
		send(press(CODE.space, CODE.space), release(CODE.space));
		expect(composer.text).toBe(' ');
		expect(start).not.toHaveBeenCalled();
	});
});
