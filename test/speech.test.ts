/**
 * The rules of spoken replies, over fake parts: no engine, no player, no OpenTUI.
 */
import type { Message } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { VOICE_CLOSE, VOICE_MARK, VOICE_OPEN } from '../src/domain/voice.ts';
import {
	type Heard,
	plainText,
	Speech,
	type SpeechParts,
	spokenTexts,
} from '../src/terminal/state/speech.ts';

const AT = '2026-01-01T00:00:00Z';

const said = (seq: number, from: string, text: string, to?: string): Message =>
	({ seq, kind: 'said', from, text, to, at: AT }) as Message;

const system = (seq: number, text: string): Message =>
	({ seq, kind: 'system', text, at: AT }) as Message;

/** A seat reply with the words to read aloud between the voice tags. */
const tagged = (...words: string[]): string =>
	words.map((one) => `${VOICE_OPEN}${one}${VOICE_CLOSE}`).join('\n\n');

/** A seat reply that has `words` between the voice tags. */
const reply = (seq: number, from: string, words: string, to?: string): Message =>
	said(seq, from, tagged(words), to);

const HUMANS: ReadonlySet<string> = new Set(['priya']);

/** The room and the parts that a test moves. */
function bench(over: Partial<SpeechParts> = {}) {
	const mic = { busy: false };
	const room = { name: 'bench', person: 'priya' as string | undefined, messages: [] as Message[] };
	const log = {
		spoken: [] as string[],
		notes: [] as string[],
		served: 0,
		halted: 0,
		aborted: [] as string[],
	};
	/** Resolvers of the texts that wait for their sound to end. */
	const sounds: (() => void)[] = [];
	const parts: SpeechParts = {
		ready: async () => undefined,
		serve: () => {
			log.served += 1;
		},
		halt: () => {
			log.halted += 1;
		},
		speak: (text, signal) =>
			new Promise<void>((resolve, reject) => {
				log.spoken.push(text);
				sounds.push(resolve);
				signal.addEventListener('abort', () => {
					log.aborted.push(text);
					reject(new DOMException('aborted', 'AbortError'));
				});
			}),
		heard: (): Heard => ({
			room: room.name,
			person: room.person,
			humans: HUMANS,
			messages: room.messages,
		}),
		busy: () => mic.busy,
		say: (note) => log.notes.push(note),
		...over,
	};
	const speech = new Speech(parts);
	/** Add messages, then let the speech read the room. */
	const land = (...messages: Message[]) => {
		room.messages = [...room.messages, ...messages];
		speech.update();
	};
	/** Let the pending promises run. */
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	/** End the sound that plays now. */
	const finish = async () => {
		sounds.shift()?.();
		await settle();
	};
	return { speech, room, log, mic, land, settle, finish };
}

/** A bench with spoken replies on, and one voice message sent. */
async function ready() {
	const b = bench();
	b.room.messages = [said(1, 'priya', 'old question'), reply(2, 'engineer', 'old answer')];
	b.speech.enable();
	await b.settle();
	b.land(said(3, 'priya', `${VOICE_MARK}check the supply`));
	return b;
}

describe('plain text and spoken texts', () => {
	it('removes headings, lists, quotes, and rules', () => {
		expect(plainText('## The supply')).toBe('The supply');
		expect(plainText('- one\n* two\n3. three')).toBe('one two three');
		expect(plainText('> quoted')).toBe('quoted');
		expect(plainText('---')).toBe('');
	});

	it('removes emphasis, code ticks, and links', () => {
		expect(plainText('It is **9 volts** and *stable*.')).toBe('It is 9 volts and stable.');
		expect(plainText('Run `psu on` now.')).toBe('Run psu on now.');
		expect(plainText('See [the notes](https://x.test/n) and ![a plot](p.png).')).toBe(
			'See the notes and a plot.',
		);
		expect(plainText('Part RDA_5807_M is ~~old~~ fine.')).toBe('Part RDA_5807_M is old fine.');
		expect(plainText('2 * 3 * 4')).toBe('2 * 3 * 4');
	});

	it('gives one text for each paragraph of each span, with no Markdown', () => {
		expect(
			spokenTexts(
				'<voice>It is **9 volts**.\nStable.\n\n- Next.</voice> Skip. <voice>Last.</voice>',
			),
		).toEqual(['It is 9 volts. Stable.', 'Next.', 'Last.']);
		expect(spokenTexts('<voice>\n```\n\n```\n</voice>')).toEqual([]);
	});

	it('gives no text outside the tags', () => {
		expect(spokenTexts('No tags here.')).toEqual([]);
		expect(spokenTexts('Before.\n\n<voice>Said.</voice>\n\nAfter.')).toEqual(['Said.']);
	});
});

describe('Speech', () => {
	it('reads a seat reply to a voice message', async () => {
		const b = await ready();
		b.land(said(4, 'engineer', `${tagged('The supply is on.')}\n\nDetails follow.`));
		await b.settle();
		expect(b.log.spoken).toEqual(['The supply is on.']);
	});

	it('reads nothing from an untagged reply to a voice message', async () => {
		const b = await ready();
		b.land(said(4, 'engineer', 'The supply is on.\n\nDetails follow.'));
		await b.settle();
		expect(b.log.spoken).toEqual([]);
	});

	it('queues one text for each paragraph of a span, in order', async () => {
		const b = await ready();
		b.land(reply(4, 'engineer', 'First thing.\n\nSecond thing.\nStill second.'));
		await b.settle();
		expect(b.log.spoken).toEqual(['First thing.']);
		await b.finish();
		expect(b.log.spoken).toEqual(['First thing.', 'Second thing. Still second.']);
	});

	it('reads two spans of one message in order, and not the text between them', async () => {
		const b = await ready();
		b.land(
			said(
				4,
				'engineer',
				`Before.\n\n${tagged('One.')}\n\nOn the screen only.\n\n${tagged('Two.')}\n\nAfter.`,
			),
		);
		await b.settle();
		expect(b.log.spoken).toEqual(['One.']);
		await b.finish();
		expect(b.log.spoken).toEqual(['One.', 'Two.']);
		await b.finish();
		expect(b.log.spoken).toEqual(['One.', 'Two.']);
	});

	it('removes Markdown inside a span', async () => {
		const b = await ready();
		b.land(reply(4, 'engineer', 'The supply is **on** at `9 volts`, see [notes](https://x.test).'));
		await b.settle();
		expect(b.log.spoken).toEqual(['The supply is on at 9 volts, see notes.']);
	});

	it('reads the words of a span that has no close tag', async () => {
		const b = await ready();
		b.land(said(4, 'engineer', `${VOICE_OPEN}It is on.`));
		await b.settle();
		expect(b.log.spoken).toEqual(['It is on.']);
	});

	it('reads nothing when the latest message of the person is typed', async () => {
		const b = await ready();
		b.land(said(4, 'priya', 'now typed'));
		b.land(reply(5, 'engineer', 'A reply.'));
		await b.settle();
		expect(b.log.spoken).toEqual([]);
	});

	it('stays silent for a typed message, and reads a reply to a voice message after it', async () => {
		const b = bench();
		b.speech.enable();
		await b.settle();
		b.land(said(1, 'priya', 'typed'), reply(2, 'engineer', 'Heard.'));
		await b.settle();
		expect(b.log.spoken).toEqual([]);
		b.land(said(3, 'priya', `${VOICE_MARK}spoken`), reply(4, 'engineer', 'Spoken answer.'));
		await b.settle();
		expect(b.log.spoken).toEqual(['Spoken answer.']);
	});

	it('never reads a reply that lands while the microphone is busy', async () => {
		const b = await ready();
		b.mic.busy = true;
		b.land(reply(4, 'engineer', 'During recording.'));
		await b.settle();
		b.mic.busy = false;
		b.speech.update();
		await b.settle();
		expect(b.log.spoken).toEqual([]);
	});

	it('reads a reply that lands after the microphone is free', async () => {
		const b = await ready();
		b.mic.busy = true;
		b.land(reply(4, 'engineer', 'During recording.'));
		b.mic.busy = false;
		b.land(reply(5, 'engineer', 'After recording.'));
		await b.settle();
		expect(b.log.spoken).toEqual(['After recording.']);
	});

	it('drops the sound and the queue when the microphone becomes busy', async () => {
		const b = await ready();
		b.land(reply(4, 'engineer', 'One.'), reply(5, 'engineer', 'Two.'));
		await b.settle();
		b.mic.busy = true;
		b.speech.update();
		await b.settle();
		expect(b.log.aborted).toEqual(['One.']);
		b.mic.busy = false;
		b.speech.update();
		await b.settle();
		expect(b.log.spoken).toEqual(['One.']);
	});

	it('skips system messages, directed says to other seats, and other people', async () => {
		const b = await ready();
		b.land(
			system(4, 'breakout sweep: Done.'),
			reply(5, 'engineer', 'To the researcher.', 'researcher'),
			reply(6, 'dev', 'A colleague speaks.'),
			said(7, 'priya', 'my own words'),
		);
		await b.settle();
		expect(b.log.spoken).toEqual([]);
	});

	it('reads a say directed to the person, and a say to nobody', async () => {
		const b = await ready();
		b.land(reply(4, 'engineer', 'For you.', 'priya'), reply(5, 'researcher', 'For all.'));
		await b.settle();
		expect(b.log.spoken).toEqual(['For you.']);
		await b.finish();
		expect(b.log.spoken).toEqual(['For you.', 'For all.']);
	});

	it('skips a message with no words after the cleanup', async () => {
		const b = await ready();
		b.land(reply(4, 'engineer', '---'), reply(5, 'engineer', 'Words.'));
		await b.settle();
		expect(b.log.spoken).toEqual(['Words.']);
	});

	it('does not read what was there when voice mode turned on', async () => {
		const b = bench();
		b.room.messages = [said(1, 'priya', `${VOICE_MARK}before`), reply(2, 'engineer', 'Old reply.')];
		b.speech.enable();
		await b.settle();
		b.speech.update();
		await b.settle();
		expect(b.log.spoken).toEqual([]);
	});

	it('does not read a message twice', async () => {
		const b = await ready();
		b.land(reply(4, 'engineer', 'Once.'));
		b.speech.update();
		b.speech.update();
		await b.settle();
		await b.finish();
		expect(b.log.spoken).toEqual(['Once.']);
	});

	it('does not replay the messages of a room that opens', async () => {
		const b = await ready();
		b.room.name = 'other';
		b.room.messages = [
			said(1, 'priya', `${VOICE_MARK}there`),
			reply(2, 'engineer', 'Seen already.'),
		];
		b.speech.update();
		await b.settle();
		expect(b.log.spoken).toEqual([]);
		b.land(reply(3, 'engineer', 'New in the other room.'));
		await b.settle();
		expect(b.log.spoken).toEqual(['New in the other room.']);
	});

	it('stops the sound when the room changes', async () => {
		const b = await ready();
		b.land(reply(4, 'engineer', 'First.'), reply(5, 'engineer', 'Second.'));
		await b.settle();
		b.room.name = 'other';
		b.room.messages = [];
		b.speech.update();
		await b.settle();
		expect(b.log.aborted).toEqual(['First.']);
		expect(b.log.spoken).toEqual(['First.']);
	});

	it('reads the replies one at a time, in order', async () => {
		const b = await ready();
		b.land(reply(4, 'engineer', 'One.'), reply(5, 'researcher', 'Two.'));
		b.land(reply(6, 'engineer', 'Three.'));
		await b.settle();
		expect(b.log.spoken).toEqual(['One.']);
		await b.finish();
		expect(b.log.spoken).toEqual(['One.', 'Two.']);
		await b.finish();
		expect(b.log.spoken).toEqual(['One.', 'Two.', 'Three.']);
	});

	it('stops the sound and clears the queue', async () => {
		const b = await ready();
		b.land(reply(4, 'engineer', 'One.'), reply(5, 'engineer', 'Two.'));
		await b.settle();
		b.speech.stop();
		await b.settle();
		expect(b.log.aborted).toEqual(['One.']);
		expect(b.log.spoken).toEqual(['One.']);
		b.land(reply(6, 'engineer', 'Three.'));
		await b.settle();
		expect(b.log.spoken).toEqual(['One.', 'Three.']);
	});

	it('says nothing and plays nothing while voice mode is off', async () => {
		const b = bench();
		b.land(said(1, 'priya', `${VOICE_MARK}hi`), reply(2, 'engineer', 'Hello.'));
		await b.settle();
		expect(b.log.spoken).toEqual([]);
		expect(b.log.served).toBe(0);
	});

	it('starts the engine once, and ends it with voice mode', async () => {
		const b = bench();
		b.speech.enable();
		b.speech.enable();
		await b.settle();
		expect(b.log.served).toBe(1);
		expect(b.speech.active).toBe(true);
		b.speech.disable();
		expect(b.log.halted).toBe(1);
		expect(b.speech.active).toBe(false);
	});

	it('stops the sound and drops the queue when voice mode turns off', async () => {
		const b = await ready();
		b.land(reply(4, 'engineer', 'One.'), reply(5, 'engineer', 'Two.'));
		await b.settle();
		b.speech.disable();
		await b.settle();
		expect(b.log.aborted).toEqual(['One.']);
		b.land(reply(6, 'engineer', 'Three.'));
		await b.settle();
		expect(b.log.spoken).toEqual(['One.']);
	});

	it('does not read what landed while voice mode was off', async () => {
		const b = await ready();
		b.speech.disable();
		b.land(reply(4, 'engineer', 'While off.'));
		b.speech.enable();
		await b.settle();
		b.speech.update();
		await b.settle();
		expect(b.log.spoken).toEqual([]);
	});

	it('shows one note when the engine is missing, and reads nothing', async () => {
		const note = 'Spoken replies are off: run make voice.';
		const b = bench({ ready: async () => note });
		b.speech.enable();
		await b.settle();
		b.land(said(1, 'priya', `${VOICE_MARK}hi`), reply(2, 'engineer', 'Hello.'));
		b.speech.enable();
		await b.settle();
		expect(b.log.notes).toEqual([note]);
		expect(b.log.served).toBe(0);
		expect(b.log.spoken).toEqual([]);
		expect(b.speech.active).toBe(false);
	});

	it('ignores a check that ends after voice mode turned off', async () => {
		let finishCheck: (problem: string | undefined) => void = () => {};
		const b = bench({
			ready: () => new Promise((resolve) => (finishCheck = resolve)),
		});
		b.speech.enable();
		b.speech.disable();
		finishCheck(undefined);
		await b.settle();
		expect(b.log.served).toBe(0);
		expect(b.speech.active).toBe(false);
	});

	it('shows one note for a failure and drops the queue', async () => {
		const b = bench({
			speak: async () => {
				throw new Error('koko answered 500: no good\nmore');
			},
		});
		b.room.messages = [];
		b.speech.enable();
		await b.settle();
		b.land(said(1, 'priya', `${VOICE_MARK}hi`));
		b.land(reply(2, 'engineer', 'One.'), reply(3, 'engineer', 'Two.'));
		await b.settle();
		b.land(reply(4, 'engineer', 'Three.'));
		await b.settle();
		expect(b.log.notes).toEqual(['Cannot speak: koko answered 500: no good']);
	});

	it('shows the note of an engine that ended by itself', async () => {
		const b = await ready();
		b.speech.crashed('koko stopped: it ended with code 1');
		b.speech.crashed('koko stopped: it ended with code 1');
		expect(b.log.notes).toEqual(['Cannot speak: koko stopped: it ended with code 1']);
	});

	it('reads nothing before the person is chosen', async () => {
		const b = bench();
		b.room.person = undefined;
		b.speech.enable();
		await b.settle();
		b.land(said(1, 'engineer', `${VOICE_MARK}odd`), reply(2, 'engineer', 'Reply.'));
		await b.settle();
		expect(b.log.spoken).toEqual([]);
	});
});
