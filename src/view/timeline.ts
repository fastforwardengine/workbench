import type { Exchange, ExchangeActivation, Message } from '@ambionframework/ambion';
import { formatUsage, type PassView } from './steps.ts';

type ClosedView = Extract<Exchange, { status: 'closed' }>;

/**
 * How a message reads in the conversation. A post is a message of the system:
 * the host posted it, or the room gave the say of a seat back to it.
 */
export type Role = 'question' | 'said' | 'posted';

export interface MessageBlock {
	type: 'message';
	message: Message;
	role: Role;
	/** Set on a scheduled say that its seat or the host dismissed. It does not return. */
	dismissed?: true;
}

interface NoteBlock {
	type: 'note';
	text: string;
}

/** The trace of one activation, as `/steps` shows it. */
export interface StepsBlock {
	type: 'steps';
	title: string;
	/** True while the activation has no end step. */
	running: boolean;
	passes: PassView[];
}

/** The open exchange, at the end of the conversation. */
export interface LiveBlock {
	type: 'live';
	text: string;
	/** The latest work a seat reported, when there is one. */
	detail?: string;
}

export type Block = MessageBlock | NoteBlock | StepsBlock | LiveBlock;

export interface TimelineInput {
	messages: readonly Message[];
	exchanges: readonly Exchange[];
	open?: { person?: string };
	/** The latest work a seat reported in the open exchange. */
	activity?: string;
	humans: ReadonlySet<string>;
	/** The seats that are working now. */
	working: readonly string[];
	/** Blocks that follow the messages, before the live block. */
	tail?: readonly Block[];
	/** Why each failed activation failed, by activation id, as this process heard it. */
	failures?: ReadonlyMap<string, string>;
}

const spoken = (message: Message): boolean => message.kind === 'said' || message.kind === 'posted';

function waitingOn(exchange: ClosedView): string | undefined {
	return exchange.outcome.kind === 'awaiting' ? `Waiting on ${exchange.outcome.person}` : undefined;
}

/** The seat whose reply the room gave up on, or undefined when the room gave up on none. */
const gaveUpOn = (exchange: ClosedView): ExchangeActivation | undefined =>
	exchange.outcome.kind === 'exhausted'
		? exchange.activations.findLast(
				(activation) => activation.purpose === 'respond' && activation.outcome.kind === 'failed',
			)
		: undefined;

/**
 * One failed activation: the seat, whether the room tried it again, and the
 * reason when this process heard it. A permanent failure runs once.
 */
function failureText(activation: ExchangeActivation, failures?: ReadonlyMap<string, string>) {
	const permanent = 'cause' in activation.outcome && activation.outcome.cause === 'permanent';
	const tries = permanent ? 'the room does not retry this' : `after ${activation.attempt} attempts`;
	const reason = failures?.get(activation.id);
	return `${activation.seat} failed, ${tries}${reason ? `: ${reason}` : ''}`;
}

/**
 * The line under the last message of a closed exchange that ended without a
 * reply to the person: the exchange waits on a person, or the room gave up on a
 * seat. An exchange that ended in any other way has no line.
 */
function noteFor(exchange: ClosedView, failures?: ReadonlyMap<string, string>): string | undefined {
	const cost = formatUsage(exchange.usage);
	const suffix = cost ? ` · ${cost}` : '';
	const waiting = waitingOn(exchange);
	if (waiting) return `${waiting}${suffix}`;
	const failed = gaveUpOn(exchange);
	return failed ? `Closed, ${failureText(failed, failures)}${suffix}` : undefined;
}

/**
 * The seq of the message that an exchange note follows: the last spoken
 * message in the range of the exchange, or its opening when none is spoken.
 */
function anchorOf(exchange: ClosedView, messages: readonly Message[]): number {
	const inRange = messages.filter(
		(message) => spoken(message) && message.seq >= exchange.from && message.seq <= exchange.through,
	);
	return inRange.at(-1)?.seq ?? exchange.from;
}

/** The notes of the closed exchanges, by the seq of the message that each follows. */
function notesBySeq(input: TimelineInput): Map<number, string[]> {
	const notes = new Map<number, string[]>();
	for (const exchange of input.exchanges) {
		if (exchange.status !== 'closed') continue;
		const text = noteFor(exchange, input.failures);
		if (!text) continue;
		const anchor = anchorOf(exchange, input.messages);
		notes.set(anchor, [...(notes.get(anchor) ?? []), text]);
	}
	return notes;
}

const roleOf = (message: Message, humans: ReadonlySet<string>): Role => {
	if (message.kind === 'posted') return 'posted';
	return humans.has(message.from ?? '') ? 'question' : 'said';
};

/**
 * Turn the record into the blocks the conversation shows.
 *
 * Every message shows in the open, in the order of the record. A closed
 * exchange that waits on a person, or that the room gave up on, adds one note
 * after its last message. The blocks that follow the messages come next, and a
 * live block ends the list while an exchange is open.
 */
export function buildTimeline(input: TimelineInput): Block[] {
	const dismissed = new Set(
		input.messages.flatMap((message) => (message.kind === 'dismissed' ? [message.message] : [])),
	);
	const notes = notesBySeq(input);
	const blocks: Block[] = [];
	for (const message of input.messages.filter(spoken)) {
		blocks.push({
			type: 'message',
			message,
			role: roleOf(message, input.humans),
			...(dismissed.has(message.seq) ? { dismissed: true } : {}),
		});
		for (const text of notes.get(message.seq) ?? []) blocks.push({ type: 'note', text });
	}
	blocks.push(...(input.tail ?? []));
	if (input.open) blocks.push(liveBlock(input.open.person, input.working, input.activity));
	return blocks;
}

function liveBlock(
	person: string | undefined,
	working: readonly string[],
	activity?: string,
): LiveBlock {
	const seats = working.length > 0 ? ` with ${working.join(', ')}` : '';
	const work = person === undefined ? 'the room’s work' : `${person}’s question`;
	return { type: 'live', text: `Working on ${work}${seats}`, detail: activity };
}
