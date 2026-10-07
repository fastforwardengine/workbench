import { brief, firstLine, render } from './text.ts';

/** The fields of a tool input, or of the details of a tool output. */
type Fields = Readonly<Record<string, unknown>>;

/** What a tool output holds: the text of its first text item, and its details. */
interface Output {
	text: string | undefined;
	details: Fields;
}

/**
 * How one tool reads in the live block and in `/steps`. The icon starts the
 * line, and `words` gives the rest from the input. `result` gives a short
 * result from the output. `failure` gives a short reason from the text of an
 * error. Each function returns undefined when it has nothing to say, and the
 * plain form takes over.
 */
interface Phrase {
	icon: string;
	words: (input: Fields) => string | undefined;
	result?: (output: Output) => string | undefined;
	failure?: (error: string) => string | undefined;
}

const isRecord = (value: unknown): value is Fields =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** The value when it is a text that holds a character. */
const stringOf = (value: unknown): string | undefined =>
	typeof value === 'string' && value.trim() !== '' ? value : undefined;

const isTextItem = (entry: unknown): entry is { type: 'text'; text: string } =>
	isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string';

/** `1 line`, or `3 lines`. */
const counted = (count: number, noun: string): string =>
	`${count} ${noun}${count === 1 ? '' : 's'}`;

/** The text of the first text item of an output, and its details. */
function outputOf(output: unknown): Output {
	if (typeof output === 'string') return { text: output, details: {} };
	const content = isRecord(output) ? output.content : output;
	const item = Array.isArray(content) ? content.find(isTextItem) : undefined;
	const details = isRecord(output) && isRecord(output.details) ? output.details : {};
	return { text: item?.text, details };
}

/** The state that a process line of a result names. */
interface ProcessState {
	handle: string;
	/** `running`, `exit 0`, `timed out`, `cancelled`, or `failed`. */
	state: string;
}

const PROCESS_LINE =
	/Process (\S+)(?: \([^)]*\))? (is running|exited with code (-?\d+)|timed out|is cancelled|failed)/;

/** The state line of a process in a text, such as `Process bash-1 exited with code 0.`. */
function processState(text: string | undefined): ProcessState | undefined {
	const found = PROCESS_LINE.exec(text ?? '');
	if (!found) return undefined;
	const [, handle = '', what = '', code] = found;
	if (code !== undefined) return { handle, state: `exit ${code}` };
	if (what === 'is running') return { handle, state: 'running' };
	return { handle, state: what === 'is cancelled' ? 'cancelled' : what };
}

/** The result of `bash`: the handle while the process runs, else the end of the process. */
function bashResult({ text }: Output): string | undefined {
	const found = processState(text);
	if (!found) return undefined;
	return found.state === 'running' ? `→ ${found.handle}` : found.state;
}

/** The result of `wait` and `cancel`: the state of the process. */
const stateResult = ({ text }: Output): string | undefined => processState(text)?.state;

const processFailure = (error: string): string | undefined => processState(error)?.state;

/** The lines of a file: the count in the details, else the lines of the text. */
function readResult({ text, details }: Output): string | undefined {
	if (isRecord(details.image)) return 'image';
	if (typeof details.lines === 'number') return counted(details.lines, 'line');
	if (text === undefined) return undefined;
	return counted(text.replace(/\n$/, '').split('\n').length, 'line');
}

/** `Successfully replaced 2 block(s) in /a.` as `2 blocks`. */
function editResult({ text }: Output): string | undefined {
	const found = /replaced (\d+) block/.exec(text ?? '');
	return found ? counted(Number(found[1]), 'block') : undefined;
}

/** The rows of a query: the count in the details, else the count that the text names. */
function sqlResult({ text, details }: Output): string | undefined {
	if (typeof details.count === 'number') return counted(details.count, 'row');
	if (text === undefined) return undefined;
	if (/\bNo rows\b/.test(text)) return '0 rows';
	const last = [...text.matchAll(/\b(\d+) rows?\b/g)].at(-1);
	return last ? counted(Number(last[1]), 'row') : undefined;
}

/** The HTTP status of a fetch. */
function fetchResult({ text, details }: Output): string | undefined {
	if (typeof details.status === 'number') return String(details.status);
	return /\): (\d{3}),/.exec(text ?? '')?.[1];
}

/** The count of the running processes. */
function psResult({ text, details }: Output): string | undefined {
	const count = Array.isArray(details.processes) ? details.processes.length : undefined;
	if (count !== undefined) return count === 0 ? 'none' : `${count} running`;
	if (/No running processes/.test(text ?? '')) return 'none';
	const found = /(\d+) running process/.exec(text ?? '');
	return found ? `${found[1]} running` : undefined;
}

/** The first line of a text field of the input. */
const lineOf = (value: unknown): string | undefined => {
	const text = stringOf(value);
	return text === undefined ? undefined : brief(firstLine(text));
};

const handlesOf = (value: unknown): string | undefined =>
	Array.isArray(value) && value.every((handle) => typeof handle === 'string') && value.length > 0
		? value.join(', ')
		: undefined;

/** A phrase of a tool that names a verb and one field of the input. */
const verb = (name: string, field: string): Phrase['words'] => {
	return (input) => {
		const value = lineOf(input[field]);
		return value === undefined ? undefined : `${name} ${value}`;
	};
};

/** The tools of the seats that have a phrase of their own, by name. */
const TOOLS: ReadonlyMap<string, Phrase> = new Map<string, Phrase>([
	[
		'bash',
		{
			icon: '$',
			words: (input) => lineOf(input.command),
			result: bashResult,
			failure: processFailure,
		},
	],
	['read', { icon: '→', words: verb('read', 'path'), result: readResult }],
	['write', { icon: '✎', words: verb('write', 'path'), result: () => '' }],
	['edit', { icon: '✎', words: verb('edit', 'path'), result: editResult }],
	['sql', { icon: '◇', words: verb('sql', 'sql'), result: sqlResult }],
	[
		'fetch',
		{
			icon: '⇄',
			words: (input) => {
				const [target, path] = [lineOf(input.process), lineOf(input.path)];
				return target === undefined || path === undefined ? undefined : `fetch ${target} ${path}`;
			},
			result: fetchResult,
		},
	],
	['ps', { icon: '⋯', words: () => 'ps', result: psResult }],
	[
		'wait',
		{
			icon: '⋯',
			words: (input) => {
				const handles = handlesOf(input.handles);
				return handles === undefined ? undefined : `wait ${handles}`;
			},
			result: stateResult,
			failure: processFailure,
		},
	],
	[
		'cancel',
		{
			icon: '⋯',
			words: verb('cancel', 'handle'),
			result: stateResult,
			failure: processFailure,
		},
	],
]);

/**
 * The input of a call as one short text. An object whose values hold exactly
 * one string shows that string, as the command of a `bash` call. Any other
 * input shows as compact JSON.
 */
function inputText(input: unknown): string {
	if (isRecord(input)) {
		const strings = Object.values(input).filter((value) => typeof value === 'string');
		if (strings.length === 1) return brief(firstLine(String(strings[0])));
	}
	return input === undefined ? '' : render(input);
}

/**
 * A call as one short phrase: the icon of its tool, then words from its
 * input, as `$ make test` or `→ read /notes/board.md`. A tool with no phrase
 * shows its name and its input.
 */
export function callPhrase(name: string, input: unknown): string {
	const phrase = TOOLS.get(name);
	const words = phrase?.words(isRecord(input) ? input : {});
	if (phrase && words !== undefined) return `${phrase.icon} ${words}`;
	return `${name} ${inputText(input)}`.trim();
}

/** What a successful call gave back, as one short line. */
export function resultPhrase(name: string, output: unknown): string {
	const read = outputOf(output);
	const short = TOOLS.get(name)?.result?.(read);
	if (short !== undefined) return short;
	return read.text === undefined ? render(output) : brief(firstLine(read.text));
}

/** What a failed call reports, as one short line that starts with `failed:`. */
export function failurePhrase(name: string, error: string): string {
	return `failed: ${TOOLS.get(name)?.failure?.(error) ?? brief(error)}`;
}
