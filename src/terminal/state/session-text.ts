import type { Participant, ScheduledSay } from '@ambionframework/ambion';
import type { RoomAction, RoomView } from '../../host/host.ts';
import type { Block } from '../../view/timeline.ts';
import { COMMANDS } from './commands.ts';

/** What `/help` says about the keys. The lines about the commands come from `COMMANDS`. */
const KEY_HELP = [
	'Keys',
	'  Enter sends. Ctrl+J, Alt+Enter, and Shift+Enter add a line.',
	'  Tab browses the discussions. Up and Down choose, Enter opens or closes,',
	'  e opens all, c closes all, s shows the steps of the exchange, and Esc goes back',
	'  to the composer.',
	'  r, while browsing, chooses a ref of a shown message. Enter opens a file or a table',
	'  in the files panel, or jumps to a message. Esc goes back.',
	'  PageUp and PageDown scroll. Start a message with // to send a leading slash.',
	'  Ctrl+C clears the composer, cancels a new room that waits for its goal, and closes a',
	'  panel. On an empty composer it drops the staged attachments.',
	'  Ctrl+D on an empty composer leaves the terminal. /quit also leaves.',
	'  Start a message with @name to address one seat. The seat wakes, and the host',
	'  seats it first when it is not seated. Start with @@ to send a leading at sign.',
];

export const HELP = ['Commands', ...COMMANDS.flatMap((command) => command.help), ...KEY_HELP].join(
	'\n',
);

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

/** The agents that are at work in a room now. */
export const workingAgents = (view: RoomView | undefined): string[] =>
	(view?.participants ?? []).flatMap((participant: Participant) =>
		participant.kind === 'agent' && participant.status === 'active' ? [participant.name] : [],
	);

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
	return `${say.seat} comes back at ${time}: ${say.text} (/dismiss ${say.seq})`;
}

/** The seats that `@` completes to, each with its attention in the open room. */
export function agentChoices(
	agents: readonly { name: string }[],
	view: RoomView | undefined,
): { name: string; state: string }[] {
	return agents.map(({ name }) => {
		const seat = (view?.participants ?? []).find(
			(participant) => participant.kind === 'agent' && participant.name === name,
		);
		return { name, state: seat?.kind === 'agent' ? seat.attention : 'not seated' };
	});
}

/** The reason a mention cannot go out, or undefined when it can. */
export function mentionRefusal(
	message: { text: string; to?: string },
	agents: readonly { name: string }[],
	staged = 0,
): string | undefined {
	const known = agents.map((agent) => agent.name);
	if (!message.to || !known.includes(message.to))
		return `No seat or specialist named @${message.to}. Type @ to list them, or @@ to send an at sign.`;
	const rest = message.text.replace(/^@\S+/, '').trim();
	return rest || staged > 0 ? undefined : `Say what to ask @${message.to}.`;
}
