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

/** The state of one process, as a result names it. */
interface ProcessState {
	handle: string;
	/** `running`, `exit 0`, `timed out`, `cancelled`, or `failed`. */
	state: string;
}

const PROCESS_LINE =
	/Process (\S+)(?: \([^)]*\))? (is running|exited with code (-?\d+)|timed out|is cancelled|failed)/g;

/** The state of a process in the words of its state line. */
function stateOf(what: string, code: string | undefined): string {
	if (code !== undefined) return `exit ${code}`;
	if (what === 'is running') return 'running';
	return what === 'is cancelled' ? 'cancelled' : what;
}

/** Every state line in a text, such as `Process bash-1 exited with code 0.`, in order. */
function stateLines(text: string | undefined): ProcessState[] {
	return [...(text ?? '').matchAll(PROCESS_LINE)].map(([, handle = '', what = '', code]) => ({
		handle,
		state: stateOf(what, code),
	}));
}

/** The state of a process in the facts that a result holds in its details. */
function factsState(facts: unknown): ProcessState | undefined {
	if (!isRecord(facts) || typeof facts.handle !== 'string') return undefined;
	switch (facts.state) {
		case 'running':
			return { handle: facts.handle, state: 'running' };
		case 'exited':
			return { handle: facts.handle, state: `exit ${facts.exitCode}` };
		case 'timed_out':
			return { handle: facts.handle, state: 'timed out' };
		case 'cancelled':
		case 'failed':
			return { handle: facts.handle, state: facts.state };
		default:
			return undefined;
	}
}

/**
 * The processes that a result reports. The details hold them: one in
 * `process`, and several in `processes`. A result without details has the
 * state lines of its text. The state line of a process comes after its output,
 * so the last lines are the ones that the tool wrote.
 */
function reported({ text, details }: Output): ProcessState[] {
	const facts = Array.isArray(details.processes) ? details.processes : [details.process];
	const known = facts.map(factsState).filter((state) => state !== undefined);
	return known.length > 0 ? known : stateLines(text);
}

/** The result of `bash`: the handle while the process runs, else the end of the process. */
function bashResult(output: Output): string | undefined {
	const found = reported(output).at(-1);
	if (!found) return undefined;
	return found.state === 'running' ? `→ ${found.handle}` : found.state;
}

/** The result of `wait` and `cancel`: the state of the process, or of each process of a wait on several. */
function stateResult(output: Output): string | undefined {
	const found = reported(output);
	if (found.length < 2) return found[0]?.state;
	return found.map(({ handle, state }) => `${handle} ${state}`).join(', ');
}

/** Whether a process ended badly: a code other than 0, a timeout, or a failure. */
const endedBadly = ({ state }: ProcessState): boolean =>
	state === 'timed out' || state === 'failed' || (state.startsWith('exit ') && state !== 'exit 0');

/**
 * The first process of an error text that ended badly. A wait on several
 * handles lists the processes in the order of the handles, and the ones that
 * ended well come first as often as last.
 */
const processFailure = (error: string): string | undefined =>
	stateLines(error).find(endedBadly)?.state;

/** Whether a view of lines `from` to `to` holds some lines of a file of `lines` lines, and not all. */
const partOfFile = (from: unknown, to: unknown, lines: unknown): boolean =>
	typeof from === 'number' &&
	typeof to === 'number' &&
	typeof lines === 'number' &&
	to >= from &&
	(from > 1 || to < lines);

/** The lines of a file: the count in the details, else the lines of the text. */
function readResult({ text, details }: Output): string | undefined {
	if (isRecord(details.image)) return 'image';
	const { from, to, lines } = details;
	if (partOfFile(from, to, lines)) return `lines ${from}-${to} of ${lines}`;
	if (typeof lines === 'number') return counted(lines, 'line');
	if (text === undefined) return undefined;
	return counted(text.replace(/\n$/, '').split('\n').length, 'line');
}

/** `Successfully replaced 2 block(s) in /a.` as `2 blocks`. */
function editResult({ text }: Output): string | undefined {
	const found = /replaced (\d+) block/.exec(text ?? '');
	return found ? counted(Number(found[1]), 'block') : undefined;
}

const PATCH_HEADER = /^\*\*\* (Add File|Delete File|Update File|Move to):[ \t]*(\S.*)$/;

/** The header lines of a patch: the operation of each one, and its path. */
function patchHeaders(patch: string): { header: string; path: string }[] {
	const found = patch.split(/\r?\n/).map((line) => PATCH_HEADER.exec(line.trimEnd()));
	return found.flatMap((parts) =>
		parts === null ? [] : [{ header: parts[1] ?? '', path: parts[2] ?? '' }],
	);
}

/**
 * The files that a patch names, in order. A `Move to` line joins the file
 * of the header before it as `old -> new`. A file that the patch names twice shows once.
 */
function patchFiles(patch: string): string[] {
	const names: string[] = [];
	let last = -1;
	for (const { header, path } of patchHeaders(patch)) {
		if (header === 'Move to') {
			if (last >= 0) names[last] = `${names[last]} -> ${path}`;
		} else {
			if (!names.includes(path)) names.push(path);
			last = names.indexOf(path);
		}
	}
	return names;
}

/** `patch a.ts, b.ts`, or `patch 4 files` when the patch names more than three. */
function patchWords(input: Fields): string | undefined {
	const names = patchFiles(stringOf(input.input) ?? '');
	if (names.length === 0) return undefined;
	return names.length > 3
		? `patch ${counted(names.length, 'file')}`
		: brief(`patch ${names.join(', ')}`);
}

const PATCH_ACTIONS = [
	['add', 'added'],
	['update', 'updated'],
	['delete', 'deleted'],
	['move', 'moved'],
] as const;

/** `2 updated, 1 added`: the operations of a patch, from the files in the details. */
function patchResult({ details }: Output): string | undefined {
	const { files } = details;
	if (!Array.isArray(files)) return undefined;
	const parts = PATCH_ACTIONS.flatMap(([action, word]) => {
		const count = files.filter((file) => isRecord(file) && file.action === action).length;
		return count > 0 ? [`${count} ${word}`] : [];
	});
	return parts.length > 0 ? parts.join(', ') : undefined;
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

/** The seq of the message that a post landed as, from the details of the result. */
function postedResult({ details }: Output): string | undefined {
	return typeof details.from === 'number' ? `#${details.from}` : undefined;
}

/** The full name of the breakout room that a result names. */
const roomResult = ({ details }: Output): string | undefined => stringOf(details.room);

/** `breakout <name>: <goal>`: the short name of the room, then its goal. */
function breakoutWords(input: Fields): string | undefined {
	const name = lineOf(input.name);
	if (name === undefined) return undefined;
	const goal = lineOf(input.goal);
	return goal === undefined ? `breakout ${name}` : `breakout ${name}: ${goal}`;
}

/** `archive <room> done`: the room, then how it closed. */
function archiveWords(input: Fields): string | undefined {
	const room = lineOf(input.room);
	if (room === undefined) return undefined;
	const result = stringOf(input.result);
	return result === undefined ? `archive ${room}` : `archive ${room} ${result}`;
}

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
	['apply_patch', { icon: '✎', words: patchWords, result: patchResult }],
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
	['breakout', { icon: '⇉', words: breakoutWords, result: roomResult }],
	['tell', { icon: '⇢', words: verb('tell', 'room'), result: postedResult }],
	['archive', { icon: '⇥', words: archiveWords, result: () => '' }],
	['report', { icon: '⇇', words: verb('report', 'text'), result: postedResult }],
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
	const reason = TOOLS.get(name)?.failure?.(error) ?? brief(error);
	return reason === 'failed' ? reason : `failed: ${reason}`;
}
