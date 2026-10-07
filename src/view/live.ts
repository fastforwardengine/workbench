import type { ExchangeActivation, TraceStep } from '@ambionframework/ambion';
import { type ActivationSteps, brief, formatUsage, nested, render } from './steps.ts';

/** One tool call of a running activation, as the live block draws it. */
export interface LiveCall {
	state: 'running' | 'done' | 'failed';
	/** The call: the tool name, then its input. */
	text: string;
	/** What the call gave back. It is empty while the call runs. */
	result: string;
}

/** One activation of the open exchange, as the live block draws it. */
export interface LiveActivation {
	id: string;
	state: 'running' | 'done' | 'failed';
	title: string;
	/** The latest calls of a running activation. An ended activation has none. */
	calls: LiveCall[];
	/** How many older calls of a running activation `calls` leaves out. */
	earlier: number;
}

type ToolCall = Extract<TraceStep, { type: 'tool_call' }>;
type ToolResult = Extract<TraceStep, { type: 'tool_result' }>;

/** The most calls that a running activation shows. */
const CALLS = 5;
/** The most ended activations that the live block keeps. */
const ENDED = 3;

/** The first line of a text that holds a character, or an empty text. */
const firstLine = (text: string): string =>
	text.split('\n').find((line) => line.trim() !== '') ?? '';

/**
 * The input of a call as one short text. An object whose values hold exactly
 * one string shows that string, as the command of a `bash` call. Any other
 * input shows as compact JSON.
 */
function inputText(input: unknown): string {
	if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
		const strings = Object.values(input).filter((value) => typeof value === 'string');
		if (strings.length === 1) return brief(firstLine(String(strings[0])));
	}
	return input === undefined ? '' : render(input);
}

/** The text of the first text item of a tool output, or undefined when it has none. */
function itemText(output: unknown): string | undefined {
	const content = (output as { content?: unknown } | null)?.content;
	if (!Array.isArray(content)) return undefined;
	const item = content.find(
		(entry): entry is { type: 'text'; text: string } =>
			entry?.type === 'text' && typeof entry.text === 'string',
	);
	return item?.text;
}

/** What a successful call gave back, as one line. */
function outputText(output: unknown): string {
	const text = itemText(output);
	return text === undefined ? render(output) : brief(firstLine(text));
}

function liveCall(call: ToolCall, result: ToolResult | undefined): LiveCall {
	const text = `${nested(call)}${call.name} ${inputText(call.input)}`.trim();
	if (!result) return { state: 'running', text, result: '' };
	if (result.error) return { state: 'failed', text, result: `failed: ${brief(result.error)}` };
	return { state: 'done', text, result: outputText(result.output) };
}

/** The calls of an activation, in order, each paired with its result by call id. */
function callsOf(read: ActivationSteps | undefined): LiveCall[] {
	const calls = new Map<string, ToolCall>();
	const results = new Map<string, ToolResult>();
	for (const pass of read?.passes ?? [])
		for (const step of pass.steps) {
			if (step.type === 'tool_call') calls.set(step.call, step);
			else if (step.type === 'tool_result') results.set(step.call, step);
		}
	return [...calls.values()].map((call) => liveCall(call, results.get(call.call)));
}

const failedEnd = (activation: ExchangeActivation): boolean =>
	activation.outcome.kind === 'failed' || activation.outcome.kind === 'abandoned';

/** The title: seat, purpose, attempt, and the cost once the activation ended. */
function titleOf(activation: ExchangeActivation, reason: string | undefined): string {
	const running = activation.outcome.kind === 'running';
	const cost = running ? '' : formatUsage(activation.usage);
	const parts = [
		activation.seat,
		activation.purpose,
		...(activation.attempt > 1 ? [`attempt ${activation.attempt}`] : []),
		...(cost ? [cost] : []),
	];
	const title = parts.join(' · ');
	return failedEnd(activation) && reason ? `${title}: ${reason}` : title;
}

function liveActivation(
	activation: ExchangeActivation,
	read: ActivationSteps | undefined,
	reason: string | undefined,
): LiveActivation {
	const title = titleOf(activation, reason);
	const { id } = activation;
	if (activation.outcome.kind !== 'running')
		return { id, state: failedEnd(activation) ? 'failed' : 'done', title, calls: [], earlier: 0 };
	const calls = callsOf(read);
	return {
		id,
		state: 'running',
		title,
		calls: calls.slice(-CALLS),
		earlier: Math.max(0, calls.length - CALLS),
	};
}

/**
 * The activations of the open exchange for the live block, in the order of the
 * exchange. Every running activation shows, with its latest calls. An ended
 * activation folds to its title, and only the latest few show. `reads` holds
 * the steps of the running activations by id, and `failures` the reason of each
 * failed activation.
 */
export function liveActivations(
	activations: readonly ExchangeActivation[],
	reads: ReadonlyMap<string, ActivationSteps>,
	failures?: ReadonlyMap<string, string>,
): LiveActivation[] {
	const ended = activations.filter((activation) => activation.outcome.kind !== 'running');
	const kept = new Set(ended.slice(-ENDED).map((activation) => activation.id));
	return activations
		.filter((activation) => activation.outcome.kind === 'running' || kept.has(activation.id))
		.map((activation) =>
			liveActivation(activation, reads.get(activation.id), failures?.get(activation.id)),
		);
}
