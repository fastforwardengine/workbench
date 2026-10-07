import type {
	Exchange,
	ExchangeActivation,
	Message,
	PostedMessage,
	SaidMessage,
} from '@ambionframework/ambion';
import { endedLine, type LiveActivation } from './live.ts';
import { type ActivationSteps, formatUsage, type PassView, stepsView } from './steps.ts';

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
	/** The activations of the open exchange. */
	activations: LiveActivation[];
	/** The latest error that a seat reported, when there is one. */
	detail?: string;
}

/** One activation of a closed exchange, folded to one line in the conversation. */
export interface StayItem {
	/** The activation id. */
	id: string;
	state: 'done' | 'failed';
	/** The title of the live block for an ended activation. */
	title: string;
	/** Why a failed activation failed, when this process heard it. */
	reason?: string;
	/** Set while the line is expanded: the step list of the activation. It is empty when the trace holds no steps. */
	open?: { passes: PassView[] };
}

/** The folded activations that lead to one message, or follow the last message of an exchange. */
export interface StaysBlock {
	type: 'stays';
	items: StayItem[];
}

export type Block = MessageBlock | NoteBlock | StepsBlock | LiveBlock | StaysBlock;

export interface TimelineInput {
	messages: readonly Message[];
	exchanges: readonly Exchange[];
	open?: { person?: string };
	/** The latest error that a seat reported in the open exchange. */
	activity?: string;
	humans: ReadonlySet<string>;
	/** The activations of the open exchange, as the live block shows them. */
	live?: readonly LiveActivation[];
	/** Blocks that follow the messages, before the live block. */
	tail?: readonly Block[];
	/** Why each failed activation failed, by activation id, as this process heard it. */
	failures?: ReadonlyMap<string, string>;
	/** The steps that this process read, by activation id. They give a stay its calls and its duration. */
	reads?: ReadonlyMap<string, ActivationSteps>;
	/** The stay that the person expanded, and the steps that the host holds for it. */
	expanded?: { id: string; read: ActivationSteps | undefined };
}

const spoken = (message: Message): message is SaidMessage | PostedMessage =>
	message.kind === 'said' || message.kind === 'posted';

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

/** The seq of the first spoken message that each activation wrote, by activation id. */
function firstMessages(messages: readonly Message[]): Map<string, number> {
	const first = new Map<string, number>();
	for (const message of messages)
		if (spoken(message) && message.activation !== undefined && !first.has(message.activation))
			first.set(message.activation, message.seq);
	return first;
}

function stayOf(activation: ExchangeActivation, input: TimelineInput): StayItem {
	const line = endedLine(
		activation,
		input.reads?.get(activation.id),
		input.failures?.get(activation.id),
	);
	const { expanded } = input;
	const open =
		expanded?.id === activation.id
			? { open: { passes: expanded.read ? stepsView(expanded.read) : [] } }
			: {};
	return { id: activation.id, ...line, ...open };
}

const addTo = <T>(map: Map<number, T[]>, seq: number, item: T): void => {
	map.set(seq, [...(map.get(seq) ?? []), item]);
};

/** Where the folded activations of the closed exchanges go, by the seq of a message. */
interface Stays {
	/** The stays that go above a message: it is the first message that the activation wrote. */
	above: Map<number, StayItem[]>;
	/** The stays of an activation that wrote no message. They go after the last message of the exchange. */
	below: Map<number, StayItem[]>;
}

function staysBySeq(input: TimelineInput): Stays {
	const first = firstMessages(input.messages);
	const stays: Stays = { above: new Map(), below: new Map() };
	for (const exchange of input.exchanges) {
		if (exchange.status !== 'closed') continue;
		const anchor = anchorOf(exchange, input.messages);
		for (const activation of exchange.activations) {
			const wrote = first.get(activation.id);
			if (wrote === undefined) addTo(stays.below, anchor, stayOf(activation, input));
			else addTo(stays.above, wrote, stayOf(activation, input));
		}
	}
	return stays;
}

const staysBlock = (items: StayItem[] | undefined): Block[] =>
	items ? [{ type: 'stays', items }] : [];

const roleOf = (message: Message, humans: ReadonlySet<string>): Role => {
	if (message.kind === 'posted') return 'posted';
	return humans.has(message.from ?? '') ? 'question' : 'said';
};

/**
 * Turn the record into the blocks the conversation shows.
 *
 * Every message shows in the open, in the order of the record. Each activation
 * of a closed exchange shows as one folded line above the first message that it
 * wrote. An activation that wrote no message shows after the last message of
 * its exchange. A closed exchange that waits on a person, or that the room
 * gave up on, adds one note after its last message and its folded lines. The
 * blocks that follow the messages come next, and a live block ends the list
 * while an exchange is open.
 */
export function buildTimeline(input: TimelineInput): Block[] {
	const dismissed = new Set(
		input.messages.flatMap((message) => (message.kind === 'dismissed' ? [message.message] : [])),
	);
	const notes = notesBySeq(input);
	const stays = staysBySeq(input);
	const blocks: Block[] = [];
	for (const message of input.messages.filter(spoken)) {
		blocks.push(
			...staysBlock(stays.above.get(message.seq)),
			{
				type: 'message',
				message,
				role: roleOf(message, input.humans),
				...(dismissed.has(message.seq) ? { dismissed: true } : {}),
			},
			...staysBlock(stays.below.get(message.seq)),
			...(notes.get(message.seq) ?? []).map((text): Block => ({ type: 'note', text })),
		);
	}
	blocks.push(...(input.tail ?? []));
	if (input.open) blocks.push(liveBlock(input.open.person, input.live ?? [], input.activity));
	return blocks;
}

function liveBlock(
	person: string | undefined,
	live: readonly LiveActivation[],
	activity?: string,
): LiveBlock {
	const work = person === undefined ? 'the room’s work' : `${person}’s question`;
	return { type: 'live', text: `Working on ${work}`, activations: [...live], detail: activity };
}
