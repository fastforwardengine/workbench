import type { ScheduledSay } from '@ambionframework/ambion';

/** A slash command the composer understands. */
interface Command {
	name: string;
	summary: string;
	/** What the command takes after its name. A command with nothing runs at once. */
	argument?: 'room' | 'person' | 'file' | 'say' | 'text';
	/** The lines that `/help` shows for the command. A command that another line covers has none. */
	help: readonly string[];
}

/**
 * The commands, in the order that `/help` and the palette list them. The
 * session must hold a handler for each name, and the compiler checks it.
 */
export const COMMANDS = [
	{
		name: 'room',
		summary: 'Switch to another room',
		argument: 'room',
		help: ['  /room <name>      switch to another room. Ctrl+R lists the rooms.'],
	},
	{
		name: 'new',
		summary: 'Create a room: /new <name> [goal]',
		argument: 'text',
		help: ['  /new <name> [goal]  create a room. Without a goal, the next line is the goal.'],
	},
	{
		name: 'user',
		summary: 'Switch to another person',
		argument: 'person',
		help: ['  /user <name>      switch to another person'],
	},
	{
		name: 'files',
		summary: 'Search the workspace files',
		help: ['  /files            search the workspace files and read one in the dock'],
	},
	{
		name: 'open',
		summary: 'Open a workspace file in the dock',
		argument: 'file',
		help: ['  /open <path>      open the files layer of the dock on one file'],
	},
	{
		name: 'attach',
		summary: 'Attach a local file to your next message',
		argument: 'text',
		help: [
			'  /attach <path>    copy a local file into the workspace and cite it in your next message',
		],
	},
	{
		name: 'ps',
		summary: 'Show the background processes of the specialists',
		help: [
			'  /ps               show the background processes of the specialists, their output,',
			'                    and cancel one with x, twice',
		],
	},
	{
		name: 'camera',
		summary: 'Show or hide the cameras of the open room in the dock',
		help: [
			'  /camera           show the latest frame of each camera that the open room shows,',
			'                    in the dock, and hide them when they show. The',
			'                    Engineer shows a camera. Ctrl+L chooses the Look now button',
			'                    under a camera, Enter presses it, and Esc goes back. It needs',
			'                    a terminal with Kitty graphics, such as Ghostty.',
		],
	},
	{
		name: 'voice',
		summary: 'Switch voice mode on or off',
		help: [
			'  /voice            switch voice mode on or off. In voice mode, hold Space on an empty',
			'                    composer to talk, and let go to send what whisper.cpp hears.',
		],
	},
	{
		name: 'try',
		summary: 'Fill the composer with the room’s suggested question',
		help: ['  /try              fill the composer with the room’s suggested question'],
	},
	{
		name: 'abort',
		summary: 'Cancel the open exchange',
		help: ['  /abort            cancel the open exchange in this room'],
	},
	{
		name: 'dismiss',
		summary: 'Dismiss a say that waits to return: /dismiss <n>',
		argument: 'say',
		help: [
			'  /dismiss <n>      dismiss the say n that waits to return. The seat does not come back to it.',
		],
	},
	{
		name: 'stop',
		summary: 'Stop the room',
		help: ['  /stop             stop the room. /resume starts it again.'],
	},
	{ name: 'resume', summary: 'Resume the room', help: [] },
	{
		name: 'steps',
		summary: 'Show the steps of an activation: /steps [n]',
		argument: 'text',
		help: [
			'  /steps [n]        show the steps of the newest activation of exchange n, oldest first.',
			'                    Without n, the latest exchange. /steps off hides them.',
		],
	},
	{ name: 'help', summary: 'Show the commands and keys', help: [] },
	{
		name: 'quit',
		summary: 'Leave the terminal',
		help: ['  /quit             leave the terminal. The rooms stop with it.'],
	},
] as const satisfies readonly Command[];

/** The name of a command. */
export type CommandName = (typeof COMMANDS)[number]['name'];

/** The commands as the parser and the palette read them: with the optional fields typed. */
const LISTED: readonly Command[] = COMMANDS;

/** What the person typed, once read. */
export type Parsed =
	| { kind: 'message'; text: string; to?: string }
	| { kind: 'command'; name: CommandName; argument: string }
	| { kind: 'unknown'; name: string };

/** A leading `@name`. Punctuation or a space ends the name, so `@engineer, check` addresses the Engineer. */
const MENTION = /^@([a-z][a-z0-9-]*)(?![a-z0-9-])/i;

/**
 * Read one composer submission. A leading `//` sends a message that starts with
 * one slash, so a person can still write a path such as `/shared/kit.md`. A
 * leading `@name` addresses one seat, and the text keeps the mention. A leading
 * `@@` sends a message that starts with one at sign.
 */
export function parse(input: string): Parsed {
	const text = input.trim();
	if (text.startsWith('//') || text.startsWith('@@'))
		return { kind: 'message', text: text.slice(1) };
	const mention = MENTION.exec(text);
	if (mention?.[1]) return { kind: 'message', text, to: mention[1].toLowerCase() };
	if (!text.startsWith('/') || text.includes('\n')) return { kind: 'message', text };
	const [head = '', ...rest] = text.slice(1).split(/\s+/);
	const name = head.toLowerCase();
	const command = COMMANDS.find((candidate) => candidate.name === name);
	if (!command) return { kind: 'unknown', name };
	return { kind: 'command', name: command.name, argument: rest.join(' ').trim() };
}

/** A room the person can switch to. */
export interface RoomChoice {
	name: string;
	status: string;
	working: boolean;
}

/** A person the terminal can act as. */
interface PersonChoice {
	name: string;
	role: string;
}

/** A workspace file the person can open. */
interface FileChoice {
	path: string;
	size: number;
}

/** A seat that a message can address. `state` is its attention in the open room, or `not seated`. */
interface SeatChoice {
	name: string;
	state: string;
}

/** Everything a command argument can complete to. */
export interface Choices {
	/** The seats that `@` completes to. */
	seats: readonly SeatChoice[];
	rooms: readonly RoomChoice[];
	people: readonly PersonChoice[];
	files: readonly FileChoice[];
	/** The says of the open room that wait to return. */
	says: readonly ScheduledSay[];
}

/** What a palette row completes to. It names the palette. */
type Kind = 'command' | 'room' | 'person' | 'file' | 'say' | 'seat';

/** The palette of each command that takes a choice. `/room` lists the rooms, and any other command completes to nothing. */
const KINDS: Readonly<Record<string, Kind>> = { user: 'person', open: 'file', dismiss: 'say' };

/** One row of the palette above the composer. */
export interface Suggestion {
	kind: Kind;
	label: string;
	detail: string;
	/** The text the composer holds after the person accepts this row. */
	insert: string;
	/** True when accepting the row runs the command, not only completes it. */
	run: boolean;
}

const bytes = (size: number): string =>
	size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;

function commandSuggestions(prefix: string): Suggestion[] {
	return LISTED.filter((command) => command.name.startsWith(prefix.toLowerCase())).map(
		(command) => ({
			kind: 'command' as const,
			label: `/${command.name}`,
			detail: command.summary,
			insert: command.argument ? `/${command.name} ` : `/${command.name}`,
			run: command.argument === undefined,
		}),
	);
}

function seatSuggestions(prefix: string, choices: Choices): Suggestion[] {
	return choices.seats
		.filter((seat) => seat.name.startsWith(prefix.toLowerCase()))
		.map((seat) => ({
			kind: 'seat' as const,
			label: `@${seat.name}`,
			detail: seat.state,
			insert: `@${seat.name} `,
			run: false,
		}));
}

function argumentSuggestions(name: string, wanted: string, choices: Choices): Suggestion[] {
	const text = wanted.trim().toLowerCase();
	const kind: Kind = KINDS[name] ?? 'room';
	const row = (label: string, detail: string): Suggestion => ({
		kind,
		label,
		detail,
		insert: `/${name} ${label}`,
		run: true,
	});
	if (name === 'room')
		return choices.rooms
			.filter((room) => room.name.toLowerCase().startsWith(text))
			.map((room) => row(room.name, room.working ? 'working' : room.status));
	if (name === 'user')
		return choices.people
			.filter((person) => person.name.toLowerCase().startsWith(text))
			.map((person) => row(person.name, person.role));
	if (name === 'open')
		return choices.files
			.filter((file) => file.path.toLowerCase().includes(text))
			.map((file) => row(file.path, bytes(file.size)));
	if (name === 'dismiss')
		return choices.says
			.filter((say) => String(say.seq).startsWith(text))
			.map((say) => row(String(say.seq), `${say.seat}: ${say.text}`));
	return [];
}

/**
 * The rows the palette shows for what the person has typed so far. Only a single
 * line that starts with a slash or with `@name` opens the palette. `/room `, `/user `, `/open `,
 * and `/dismiss ` list what they can take.
 */
export function suggest(input: string, choices: Choices): Suggestion[] {
	if (/^@[a-z0-9-]*$/i.test(input)) return seatSuggestions(input.slice(1), choices);
	if (!input.startsWith('/') || input.startsWith('//') || input.includes('\n')) return [];
	const space = input.indexOf(' ');
	if (space === -1) return commandSuggestions(input.slice(1));
	return argumentSuggestions(input.slice(1, space).toLowerCase(), input.slice(space + 1), choices);
}
