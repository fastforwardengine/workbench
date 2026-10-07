import type { ExchangeActivation, TraceStep } from '@ambionframework/ambion';
import { type ActivationSteps, formatUsage, nested } from './steps.ts';
import { callPhrase, failurePhrase, resultPhrase } from './tool-phrases.ts';

/** One tool call of a running activation, as the live block draws it. */
export interface LiveCall {
	state: 'running' | 'done' | 'failed';
	/** The call as its tool phrase reads: an icon, then words from the input. */
	text: string;
	/** What the call gave back. It is empty while the call runs. */
	result: string;
}

/** One running background process of the seat of an activation, as the live block draws it. */
export interface LiveProcess {
	/** The name of the process, or its handle when it has no name. */
	name: string;
	/** How long the process has run, such as `0:42`. */
	runs: string;
	/** The newest line of its output that holds a character. It is empty while the output has none. */
	line: string;
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
	/** The processes of the seat that run in the open room, newest first. Absent when none. */
	processes?: LiveProcess[];
}

type ToolCall = Extract<TraceStep, { type: 'tool_call' }>;
type ToolResult = Extract<TraceStep, { type: 'tool_result' }>;

/** The most calls that a running activation shows. */
const CALLS = 5;
/** The most ended activations that the live block keeps. */
const ENDED = 3;

function liveCall(call: ToolCall, result: ToolResult | undefined): LiveCall {
	const text = `${nested(call)}${callPhrase(call.name, call.input)}`;
	if (!result) return { state: 'running', text, result: '' };
	if (result.error)
		return { state: 'failed', text, result: failurePhrase(call.name, result.error) };
	return { state: 'done', text, result: resultPhrase(call.name, result.output) };
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
	processes: readonly LiveProcess[] = [],
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
		...(processes.length > 0 ? { processes: [...processes] } : {}),
	};
}

/**
 * The activations of the open exchange for the live block, in the order of the
 * exchange. Every running activation shows, with its latest calls. An ended
 * activation folds to its title, and only the latest few show. `reads` holds
 * the steps of the running activations by id, `failures` the reason of each
 * failed activation, and `processes` the lines of the background processes of
 * each seat, which a running activation of that seat shows.
 */
export function liveActivations(
	activations: readonly ExchangeActivation[],
	reads: ReadonlyMap<string, ActivationSteps>,
	failures?: ReadonlyMap<string, string>,
	processes?: ReadonlyMap<string, readonly LiveProcess[]>,
): LiveActivation[] {
	const ended = activations.filter((activation) => activation.outcome.kind !== 'running');
	const kept = new Set(ended.slice(-ENDED).map((activation) => activation.id));
	return activations
		.filter((activation) => activation.outcome.kind === 'running' || kept.has(activation.id))
		.map((activation) =>
			liveActivation(
				activation,
				reads.get(activation.id),
				failures?.get(activation.id),
				processes?.get(activation.seat),
			),
		);
}
