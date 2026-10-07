import type { ExchangeActivation, TraceStep } from '@ambionframework/ambion';
import { type ActivationSteps, formatUsage, nested } from './steps.ts';
import { brief, clock, firstLine } from './text.ts';
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
	/**
	 * What a running activation does now: the phrase of the call that has no result, else the
	 * first line of its newest thinking or text. Absent when it has done nothing yet, and on an
	 * ended activation.
	 */
	step?: string;
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

/** The steps of an activation, in order. */
const stepsOf = (read: ActivationSteps | undefined): TraceStep[] =>
	read?.passes.flatMap((pass) => [...pass.steps]) ?? [];

/** The calls of an activation, in order, each paired with its result by call id. */
function callsOf(steps: readonly TraceStep[]): LiveCall[] {
	const calls = new Map<string, ToolCall>();
	const results = new Map<string, ToolResult>();
	for (const step of steps)
		if (step.type === 'tool_call') calls.set(step.call, step);
		else if (step.type === 'tool_result') results.set(step.call, step);
	return [...calls.values()].map((call) => liveCall(call, results.get(call.call)));
}

/** The words of a step of the model, or undefined for any other step. */
const wordsOf = (step: TraceStep): string | undefined =>
	step.type === 'thinking' || step.type === 'text' ? brief(firstLine(step.text)) : undefined;

/**
 * What an activation does now: the newest call of the newest pass that has no
 * result, else the first line of the newest thinking or text. A call of an
 * earlier pass that has no result does not count, because the seat has gone on
 * from it. The text is empty before the first step.
 */
function currentStep(read: ActivationSteps | undefined): string {
	const latest = read?.passes.at(-1)?.steps ?? [];
	const answered = new Set(
		latest.flatMap((step) => (step.type === 'tool_result' ? [step.call] : [])),
	);
	const pending = latest.findLast((step) => step.type === 'tool_call' && !answered.has(step.call));
	if (pending?.type === 'tool_call') return callPhrase(pending.name, pending.input);
	return (
		stepsOf(read)
			.map(wordsOf)
			.findLast((words) => words) ?? ''
	);
}

const failedEnd = (activation: ExchangeActivation): boolean =>
	activation.outcome.kind === 'failed' || activation.outcome.kind === 'abandoned';

/** What the title of an ended activation counts from its steps: its calls and its span of time. */
export interface StepTotals {
	/** How many tool calls the activation made. */
	calls: number;
	/** Milliseconds from its first step to its last. It is zero when the steps hold no time. */
	span: number;
}

/** The totals of the steps of an activation. They stay small, and the steps themselves can go. */
export function totalsOf(read: ActivationSteps | undefined): StepTotals {
	const steps = stepsOf(read);
	const times = steps.map((step) => Date.parse(step.at)).filter((time) => !Number.isNaN(time));
	return {
		calls: steps.filter((step) => step.type === 'tool_call').length,
		span: times.length > 1 ? Math.max(...times) - Math.min(...times) : 0,
	};
}

/** `1 call`, or `6 calls`. It is empty when the activation made none. */
function callCount({ calls }: StepTotals): string {
	return calls === 0 ? '' : `${calls} call${calls === 1 ? '' : 's'}`;
}

/** How long an activation took, as `m:ss`. It is empty when the span is under one second. */
function duration({ span }: StepTotals): string {
	return span >= 1000 ? clock(span) : '';
}

/**
 * The parts of the title: seat, purpose, and the attempt after the first. An
 * ended activation adds its calls, its duration, and its cost. A part that is
 * zero or unknown is left out.
 */
function titleParts(activation: ExchangeActivation, totals: StepTotals): string[] {
	const running = activation.outcome.kind === 'running';
	const spent = running ? [] : [callCount(totals), duration(totals), formatUsage(activation.usage)];
	return [
		activation.seat,
		activation.purpose,
		...(activation.attempt > 1 ? [`attempt ${activation.attempt}`] : []),
		...spent.filter((part) => part !== ''),
	];
}

/** The reason that a failed activation ended, when this process heard it. */
const reasonOf = (activation: ExchangeActivation, reason: string | undefined) =>
	failedEnd(activation) && reason ? reason : undefined;

/** The title: its parts, and the reason of a failed activation, joined with ` · `. */
function titleOf(
	activation: ExchangeActivation,
	totals: StepTotals,
	reason: string | undefined,
): string {
	const why = reasonOf(activation, reason);
	return [...titleParts(activation, totals), ...(why ? [why] : [])].join(' · ');
}

/** One ended activation as the line that stays in the conversation. */
export interface EndedLine {
	state: 'done' | 'failed';
	/** The title of the live block, without the reason. */
	title: string;
	/** Why a failed activation failed, when this process heard it. */
	reason?: string;
}

/**
 * The line of an activation of a closed exchange. It has the title that the
 * live block shows for an ended activation. Without the totals of its steps,
 * the title has no calls and no duration.
 */
export function endedLine(
	activation: ExchangeActivation,
	totals: StepTotals | undefined,
	reason: string | undefined,
): EndedLine {
	const why = reasonOf(activation, reason);
	return {
		state: failedEnd(activation) ? 'failed' : 'done',
		title: titleParts(activation, totals ?? { calls: 0, span: 0 }).join(' · '),
		...(why ? { reason: why } : {}),
	};
}

function liveActivation(
	activation: ExchangeActivation,
	read: ActivationSteps | undefined,
	reason: string | undefined,
	processes: readonly LiveProcess[] = [],
): LiveActivation {
	const steps = stepsOf(read);
	const title = titleOf(activation, totalsOf(read), reason);
	const { id } = activation;
	if (activation.outcome.kind !== 'running')
		return { id, state: failedEnd(activation) ? 'failed' : 'done', title, calls: [], earlier: 0 };
	const calls = callsOf(steps);
	const step = currentStep(read);
	return {
		id,
		state: 'running',
		title,
		...(step ? { step } : {}),
		calls: calls.slice(-CALLS),
		earlier: Math.max(0, calls.length - CALLS),
		...(processes.length > 0 ? { processes: [...processes] } : {}),
	};
}

/**
 * The activations of the open exchange for the live block, in the order of the
 * exchange. Every running activation shows, with its latest calls. An ended
 * activation folds to its title, and only the latest few show. `reads` holds
 * the steps of the activations by id, `failures` the reason of each
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
