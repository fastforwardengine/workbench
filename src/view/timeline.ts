import type {
	Exchange,
	ExchangeActivation,
	Message,
	SaidMessage,
	SystemMessage,
} from '@ambionframework/ambion';
import { endedLine, type LiveActivation, type StepTotals } from './live.ts';
import { type ActivationSteps, formatUsage, type PassView, stepsView } from './steps.ts';

type ClosedView = Extract<Exchange, { status: 'closed' }>;

/**
 * How a message reads in the conversation. A system message is one that the
 * host posted, or one that gives the say of a seat back to it.
 */
export type Role = 'question' | 'said' | 'system';

export interface MessageBlock {
	type: 'message';
	message: Message;
	role: Role;
	/** Set on a scheduled say that its seat or the host dismissed. It does not return. */
	dismissed?: true;
	/** Set on a system message that the person opened. Any other system message shows as one folded row. */
	open?: true;
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
	/** The totals of the steps that this process read, by activation id. They give a stay its calls and its duration. */
	totals?: ReadonlyMap<string, StepTotals>;
	/** The stay that the person expanded, and the steps that the host holds for it. */
	expanded?: { id: string; read: ActivationSteps | undefined };
	/** The seqs of the system messages that the person opened. */
	opened?: ReadonlySet<number>;
}

const spoken = (message: Message): message is SaidMessage | SystemMessage =>
	message.kind === 'said' || message.kind === 'system';

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

/** The last of the ascending `seqs` that is at most `limit`, by binary search. */
function lastAtMost(seqs: readonly number[], limit: number): number | undefined {
	let low = 0;
	let high = seqs.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((seqs[middle] ?? 0) <= limit) low = middle + 1;
		else high = middle;
	}
	return seqs[low - 1];
}

/**
 * The seq of the message that an exchange note follows, by closed exchange:
 * the last spoken message in the range of the exchange, or its opening when
 * none is spoken. The record lists messages by seq, so one search for each
 * exchange finds the last spoken seq that is at most `through`.
 */
function anchorsOf(input: TimelineInput): Map<ClosedView, number> {
	const seqs = input.messages.filter(spoken).map((message) => message.seq);
	const anchors = new Map<ClosedView, number>();
	for (const exchange of input.exchanges) {
		if (exchange.status !== 'closed') continue;
		const last = lastAtMost(seqs, exchange.through);
		anchors.set(exchange, last !== undefined && last >= exchange.from ? last : exchange.from);
	}
	return anchors;
}

const addTo = <T>(map: Map<number, T[]>, seq: number, item: T): void => {
	map.set(seq, [...(map.get(seq) ?? []), item]);
};

/** The notes of the closed exchanges, by the seq of the message that each follows. */
function notesBySeq(
	input: TimelineInput,
	anchors: ReadonlyMap<ClosedView, number>,
): Map<number, string[]> {
	const notes = new Map<number, string[]>();
	for (const exchange of input.exchanges) {
		if (exchange.status !== 'closed') continue;
		const text = noteFor(exchange, input.failures);
		if (!text) continue;
		addTo(notes, anchors.get(exchange) ?? exchange.from, text);
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
		input.totals?.get(activation.id),
		input.failures?.get(activation.id),
	);
	const { expanded } = input;
	const open =
		expanded?.id === activation.id
			? { open: { passes: expanded.read ? stepsView(expanded.read) : [] } }
			: {};
	return { id: activation.id, ...line, ...open };
}

/** Where the folded activations of the closed exchanges go, by the seq of a message. */
interface Stays {
	/** The stays that go above a message: it is the first message that the activation wrote. */
	above: Map<number, StayItem[]>;
	/** The stays of an activation that wrote no message. They go after the last message of the exchange. */
	below: Map<number, StayItem[]>;
}

function staysBySeq(input: TimelineInput, anchors: ReadonlyMap<ClosedView, number>): Stays {
	const first = firstMessages(input.messages);
	const stays: Stays = { above: new Map(), below: new Map() };
	for (const exchange of input.exchanges) {
		if (exchange.status !== 'closed') continue;
		const anchor = anchors.get(exchange) ?? exchange.from;
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
	if (message.kind === 'system') return 'system';
	return humans.has(message.from ?? '') ? 'question' : 'said';
};

/**
 * Turn the record into the blocks the conversation shows.
 *
 * Every message shows in the open, in the order of the record. Each activation
 * of a closed exchange shows as one folded line above the first message that it
 * wrote. An activation that wrote no message shows after the last message of
 * its exchange. A system message shows as a folded row until the person opens it. A closed exchange that waits on a person, or that the room
 * gave up on, adds one note after its last message and its folded lines. The
 * blocks that follow the messages come next, and a live block ends the list
 * while an exchange is open.
 */
export function buildTimeline(input: TimelineInput): Block[] {
	const dismissed = new Set(
		input.messages.flatMap((message) => (message.kind === 'dismissed' ? [message.message] : [])),
	);
	const anchors = anchorsOf(input);
	const notes = notesBySeq(input, anchors);
	const stays = staysBySeq(input, anchors);
	const blocks: Block[] = [];
	for (const message of input.messages.filter(spoken)) {
		blocks.push(
			...staysBlock(stays.above.get(message.seq)),
			{
				type: 'message',
				message,
				role: roleOf(message, input.humans),
				...(dismissed.has(message.seq) ? { dismissed: true } : {}),
				...(message.kind === 'system' && input.opened?.has(message.seq) ? { open: true } : {}),
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
