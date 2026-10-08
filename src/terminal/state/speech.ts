import type { Message } from '@ambionframework/ambion';
import { VOICE_MARK } from '../../domain/voice.ts';
import { oneLine } from './voice.ts';

/** What spoken replies read from the terminal: the open room and its messages. */
export interface Heard {
	/** The name of the room that the messages come from, or an empty text when none is open. */
	room: string;
	/** The name of the person, or undefined before the person is chosen. */
	person: string | undefined;
	/** The names of the people in the room. A person is not a seat. */
	humans: ReadonlySet<string>;
	/** The messages of the room, in order. */
	messages: readonly Message[];
}

/** What spoken replies need from outside. A test passes fakes. */
export interface SpeechParts {
	/** A note that says why spoken replies cannot run, or undefined when the engine is there. */
	ready(): Promise<string | undefined>;
	/** Start the engine, which loads the model. A second call changes nothing while it runs. */
	serve(): void;
	/** End the engine. */
	halt(): void;
	/** Say one text aloud. It returns when the sound ends. The signal stops the sound. */
	speak(text: string, signal: AbortSignal): Promise<void>;
	/** The open room and its messages now. */
	heard(): Heard;
	/** Show a short note. */
	say(note: string): void;
}

/** Whether spoken replies run. `missing` means voice mode is on and the engine is not there. */
type SpeechState = 'off' | 'checking' | 'ready' | 'missing';

/** The paragraphs of a text are the parts between blank lines. */
const BLANK_LINE = /\r?\n[ \t]*\r?\n/;

/** The text up to the first blank line. */
export function firstParagraph(text: string): string {
	return text.trim().split(BLANK_LINE)[0] ?? '';
}

/** Remove the marks that start a line: a heading, a quote, a list item, a rule. */
function withoutLineMarks(line: string): string {
	return line
		.replace(/^\s*#{1,6}\s+/, '')
		.replace(/^\s*>\s?/, '')
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
		.replace(/^\s*(?:`{3,}|~{3,})\w*\s*$/, '')
		.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/, '');
}

/** Remove the marks inside a line: images, links, emphasis, and code ticks. */
function withoutInlineMarks(line: string): string {
	return line
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
		.replace(/\*(?=\S)(.+?)(?<=\S)\*/g, '$1')
		.replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1')
		.replace(/`+([^`]*)`+/g, '$1');
}

/** The text with the Markdown removed, as one line. */
export function plainText(markdown: string): string {
	return markdown
		.split('\n')
		.map((line) => withoutInlineMarks(withoutLineMarks(line)))
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** The words to say for a message: its first paragraph with no Markdown. Empty when nothing is left. */
export function spokenText(text: string): string {
	return plainText(firstParagraph(text));
}

/** One text that waits to be said. */
interface Line {
	seq: number;
	text: string;
}

/** The newest said message of the person, or undefined. */
function latestAsk(messages: readonly Message[], person: string): Message | undefined {
	return messages.findLast((message) => message.kind === 'said' && message.from === person);
}

/** True when a seat said the message to the person or to the room. */
function isReply(message: Message, heard: Heard): boolean {
	if (message.kind !== 'said' || message.from === heard.person) return false;
	if (heard.humans.has(message.from)) return false;
	return message.to === undefined || message.to === heard.person;
}

/**
 * Spoken replies. While voice mode is on, a seat reply to a voice message is
 * read aloud: its first paragraph, one message at a time. This class holds the
 * rules and no device: the engine and the player come in as parts.
 *
 * The rules read the room after each change. A message is new when its seq is
 * above the watermark. The watermark moves to the last seq when voice mode
 * turns on and when the open room changes, so a message that the terminal
 * already had is never read.
 */
export class Speech {
	private readonly parts: SpeechParts;
	private state: SpeechState = 'off';
	private room = '';
	private watermark = 0;
	private queue: Line[] = [];
	private playing = false;
	private abort: AbortController | undefined;
	/** Counts the starts and the ends. A result of an older check is stale. */
	private epoch = 0;
	/** True after a failure note, until a text is said. */
	private faulted = false;

	constructor(parts: SpeechParts) {
		this.parts = parts;
	}

	/** True while spoken replies can say a text. */
	get active(): boolean {
		return this.state === 'ready';
	}

	/**
	 * Voice mode turned on. A call while it is on changes nothing. The engine
	 * starts when it is there. If it is not, one note says what is missing,
	 * and voice mode works without spoken replies.
	 */
	enable(): void {
		if (this.state !== 'off') return;
		this.state = 'checking';
		this.faulted = false;
		this.epoch += 1;
		const heard = this.parts.heard();
		this.room = heard.room;
		this.watermark = lastSeq(heard.messages);
		const epoch = this.epoch;
		void this.parts.ready().then(
			(problem) => this.checked(epoch, problem),
			(error: unknown) => this.checked(epoch, oneLine(error)),
		);
	}

	/** Voice mode turned off, or the terminal ends. The speech stops and the engine ends. */
	disable(): void {
		this.epoch += 1;
		this.state = 'off';
		this.stop();
		this.parts.halt();
	}

	/** Stop the sound that plays now, and drop the texts that wait. */
	stop(): void {
		this.queue = [];
		this.abort?.abort();
	}

	/** The engine ended with no request to end it. One note says why. */
	crashed(line: string): void {
		if (this.state === 'off') return;
		this.fault(line);
	}

	/** Read the room after a change. It queues each new reply that the rules allow. */
	update(): void {
		if (this.state === 'off') return;
		const heard = this.parts.heard();
		if (heard.room !== this.room) {
			this.room = heard.room;
			this.stop();
			this.watermark = lastSeq(heard.messages);
			return;
		}
		const last = lastSeq(heard.messages);
		if (last <= this.watermark) return;
		if (this.state === 'ready') this.queue.push(...this.repliesAfter(heard));
		this.watermark = last;
		void this.pump();
	}

	/** The texts to say, in order: the new replies after the latest voice message of the person. */
	private repliesAfter(heard: Heard): Line[] {
		const { person, messages } = heard;
		const ask = person === undefined ? undefined : latestAsk(messages, person);
		if (ask?.kind !== 'said' || !ask.text.startsWith(VOICE_MARK)) return [];
		const after = Math.max(this.watermark, ask.seq);
		return messages
			.filter((message) => message.seq > after && isReply(message, heard))
			.flatMap((message) => {
				const text = message.kind === 'said' ? spokenText(message.text) : '';
				return text === '' ? [] : [{ seq: message.seq, text }];
			});
	}

	private checked(epoch: number, problem: string | undefined): void {
		if (epoch !== this.epoch || this.state !== 'checking') return;
		if (problem) {
			this.state = 'missing';
			this.parts.say(problem);
			return;
		}
		this.state = 'ready';
		this.parts.serve();
	}

	/** Say the queued texts, one at a time. A call while one plays changes nothing. */
	private async pump(): Promise<void> {
		if (this.playing) return;
		this.playing = true;
		try {
			for (let next = this.queue.shift(); next; next = this.queue.shift()) {
				if (this.state !== 'ready') break;
				await this.sayOne(next.text);
			}
		} finally {
			this.playing = false;
		}
	}

	private async sayOne(text: string): Promise<void> {
		const abort = new AbortController();
		this.abort = abort;
		try {
			await this.parts.speak(text, abort.signal);
			this.faulted = false;
		} catch (error) {
			if (!abort.signal.aborted) this.fault(oneLine(error));
		} finally {
			if (this.abort === abort) this.abort = undefined;
		}
	}

	/** Show one note for a failure, and drop the texts that wait. A text that is said clears the mark. */
	private fault(line: string): void {
		this.queue = [];
		if (this.faulted) return;
		this.faulted = true;
		this.parts.say(`Cannot speak: ${line}`);
	}
}

/** The seq of the last message, or 0 when the room has none. */
function lastSeq(messages: readonly Message[]): number {
	return messages.at(-1)?.seq ?? 0;
}
