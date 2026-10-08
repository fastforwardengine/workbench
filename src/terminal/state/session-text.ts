import type { ScheduledSay } from '@ambionframework/ambion';
import { withoutVoiceTags } from '../../domain/voice.ts';
import type { RoomAction, RoomView } from '../../host/host.ts';
import type { Block } from '../../view/timeline.ts';
import { COMMANDS } from './commands.ts';
import { bindingLabel, KEYMAP } from './keymap.ts';

/** What `/help` says about messages and keys. The lines about the commands come from `COMMANDS`. */
const MESSAGE_HELP = [
	'Messages',
	'  Start a message with // to send a leading slash.',
	'  Start a message with @name to address one seat. The seat wakes, and the host',
	'  seats it first when it is not seated. Start with @@ to send a leading at sign.',
	'Keys',
	`  Press ${bindingLabel(KEYMAP.composer.bindings.keys)} on an empty composer to open the keys sheet.`,
];

export const HELP = [
	'Commands',
	...COMMANDS.flatMap((command) => command.help),
	...MESSAGE_HELP,
].join('\n');

export const DONE: Record<RoomAction, (room: string) => string> = {
	abort: (room) => `Aborted the open exchange in ${room}.`,
	stop: (room) => `Stopped ${room}. Use /resume to start it again.`,
	resume: (room) => `Resumed ${room}.`,
};

/** The reason an action does not apply to the room, or undefined when it does. */
export function refusal(action: RoomAction, view: RoomView | undefined): string | undefined {
	if (!view) return 'No room is open.';
	if (action === 'abort') {
		if (view.status !== 'running') return `${view.name} is not running. Use /resume first.`;
		return view.exchange ? undefined : `Nothing to abort. ${view.name} has no open exchange.`;
	}
	if (action === 'stop')
		return view.status === 'stopped' ? `${view.name} is already stopped.` : undefined;
	return view.status === 'running' ? `${view.name} is already running.` : undefined;
}

/** What an empty room shows, with the room's suggested first question. */
export function emptyText(view: RoomView): string {
	const start = 'Nothing here yet. Ask a question below, or type / for commands.';
	return view.prompt ? `${start}\nTry: ${view.prompt}  (type /try to use it)` : start;
}

/** The notes after the closed exchanges: what waits on the person, then each say that waits. */
export function notesOf(attention: readonly string[], view: RoomView): Block[] {
	const notes = [...attention, ...view.scheduled.map(pendingLine)];
	return notes.map((text) => ({ type: 'note', text }));
}

/** One say that waits to return, as the conversation notes it. */
function pendingLine(say: ScheduledSay): string {
	const due = new Date(say.due);
	const later = due.valueOf() - Date.now() > 86_400_000;
	const time = Number.isNaN(due.valueOf())
		? say.due
		: due.toLocaleString([], {
				...(later ? { month: 'short', day: 'numeric' } : {}),
				hour: '2-digit',
				minute: '2-digit',
			});
	return `${say.seat} comes back at ${time}: ${withoutVoiceTags(say.text)} (/dismiss ${say.seq})`;
}

/** The agents that a view seats, with the attention of each. */
export const seatedAgents = (view: RoomView | undefined): { name: string; attention: string }[] =>
	(view?.participants ?? []).flatMap((seat) =>
		seat.kind === 'agent' ? [{ name: seat.name, attention: seat.attention }] : [],
	);

/**
 * The seats that `@` completes to, each with its attention in the open room. A root room
 * offers every specialist. A breakout room offers the agents it seats.
 */
export function seatChoices(
	team: readonly { name: string }[],
	view: RoomView | undefined,
): { name: string; state: string }[] {
	const seated = seatedAgents(view);
	if (view?.breakout) return seated.map(({ name, attention }) => ({ name, state: attention }));
	return team.map(({ name }) => ({
		name,
		state: seated.find((seat) => seat.name === name)?.attention ?? 'not seated',
	}));
}

/** The reason a mention cannot go out, or undefined when it can. */
export function mentionRefusal(
	message: { text: string; to?: string },
	seats: readonly { name: string }[],
	staged = 0,
): string | undefined {
	const known = seats.map((seat) => seat.name);
	if (!message.to || !known.includes(message.to))
		return `No seat or specialist named @${message.to}. Type @ to list them, or @@ to send an at sign.`;
	const rest = message.text.replace(/^@\S+/, '').trim();
	return rest || staged > 0 ? undefined : `Say what to ask @${message.to}.`;
}
