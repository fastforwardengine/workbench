import type { Participant } from '@ambionframework/ambion';
import {
	BoxRenderable,
	bold,
	type CliRenderer,
	fg,
	StyledText,
	TextRenderable,
} from '@opentui/core';
import type { Person, RoomView } from '../../host/host.ts';
import { type Background, backgroundChip, breakoutLabel } from '../state/breakouts.ts';
import { tui as palette } from './brand.ts';
import { fitHeader } from './header-fit.ts';
import { APART, GUTTER, INSET } from './space.ts';

type Chunks = ConstructorParameters<typeof StyledText>[0];

/** The cells that the padding takes from the panel width. */
const CHROME = INSET + GUTTER;

/** True when a seat is at work or a person is present. */
function lit(participant: Participant): boolean {
	return participant.kind === 'agent'
		? participant.status === 'active'
		: participant.presence === 'present';
}

/** A participant's color: coral at work, green present, dim otherwise. */
function participantColor(participant: Participant): string {
	if (!lit(participant)) return palette.dim;
	return participant.kind === 'agent' ? palette.coral : palette.green;
}

/** A filled dot marks a lit participant, and an empty dot marks the others. The state then reads without color. */
const label = (participant: Participant, unavailable: readonly string[] = []): string =>
	`${lit(participant) ? '●' : '○'} ${participant.name}${noLogin(participant, unavailable)}`;

/** The mark beside a seat that has no login. */
function noLogin(participant: Participant, unavailable: readonly string[]): string {
	return participant.kind === 'agent' && unavailable.includes(participant.name)
		? ' (no login)'
		: '';
}

/** One row of the panel: text at the left edge, and text that stays at the right edge. */
class Row {
	readonly root: BoxRenderable;
	private readonly left: TextRenderable;
	private readonly right: TextRenderable;

	constructor(renderer: CliRenderer) {
		this.root = new BoxRenderable(renderer, { flexDirection: 'row', gap: APART });
		this.left = new TextRenderable(renderer, { content: '', flexGrow: 1, wrapMode: 'none' });
		this.right = new TextRenderable(renderer, { content: '', flexShrink: 0, wrapMode: 'none' });
		this.root.add(this.left);
		this.root.add(this.right);
	}

	set(left: Chunks, right: Chunks): void {
		this.left.content = new StyledText(left);
		this.right.content = new StyledText(right);
	}
}

/** What the header shows: who the person is, and the room that is open. */
export interface HeaderState {
	identity: Person | undefined;
	view: RoomView | undefined;
	/** The breakout rooms that run in the background of the open room. */
	background: Background;
}

/** The text at the right edge of the participants row: the parent of a breakout room, else the pattern. */
const sideText = (view: RoomView | undefined): string =>
	breakoutLabel(view) || (view?.pattern ?? '');

/**
 * The panel above the conversation. The first row holds the room name and
 * goal, with the person's identity at the right edge. The second row holds the
 * participants, with the room's pattern at the right edge.
 */
export class Header {
	readonly root: BoxRenderable;
	private readonly room: Row;
	private readonly people: Row;

	constructor(renderer: CliRenderer) {
		this.root = new BoxRenderable(renderer, {
			flexDirection: 'column',
			flexShrink: 0,
			backgroundColor: palette.panel,
			paddingLeft: INSET,
			paddingRight: GUTTER,
		});
		this.room = new Row(renderer);
		this.people = new Row(renderer);
		this.root.add(this.room.root);
		this.root.add(this.people.root);
	}

	/** Draw the state. `width` is the panel width, padding included. */
	draw(state: HeaderState, width: number): void {
		const { identity, view, background } = state;
		const who = identity
			? `as ${identity.name}, ${identity.role.toLowerCase()}`
			: 'choose a person with /user';
		const participants = view?.participants ?? [];
		const unavailable = view?.unavailable ?? [];
		const fit = fitHeader({
			width: width - CHROME,
			name: view?.name ?? '',
			goal: view?.goal ?? '',
			identity: who,
			people: participants.map((participant) => label(participant, unavailable)).join('  ').length,
			background: backgroundChip(background),
			pattern: sideText(view),
		});
		this.room.set(
			view
				? [bold(fg(palette.accent)(view.name)), fg(palette.dim)(`  ${fit.goal}`)]
				: [fg(palette.dim)('No room open')],
			[fg(palette.muted)(who)],
		);
		const chip = fit.background
			? [fg(background.working ? palette.coral : palette.dim)(fit.background)]
			: [];
		this.people.set(
			[
				...participants.map((participant) =>
					fg(participantColor(participant))(`${label(participant, unavailable)}  `),
				),
				...chip,
			],
			[fg(palette.dim)(fit.pattern)],
		);
	}
}
