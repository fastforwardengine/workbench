import type { RoomView } from '../../host/host.ts';
import { type RefItem, stayOfPick } from '../../view/refs.ts';
import { type Audience, audienceOf } from '../state/audience.ts';
import { cueLines } from '../state/cue.ts';
import { bindingLabel, KEYMAP } from '../state/keymap.ts';
import type { Mode } from '../state/mode.ts';
import type { PictureCache } from '../state/picture-cache.ts';
import { pictureRefs, stripKey, stripsBySeq } from '../state/pictures.ts';
import type { Session } from '../state/session.ts';
import { emptyText } from '../state/session-text.ts';
import { countSegments, PRIORITY, type Segment, workingSegment } from '../state/status-row.ts';
import type { Voice } from '../state/voice.ts';
import type { Composer } from '../widgets/composer.ts';
import type { Header } from '../widgets/header.ts';
import { GUTTER, INSET } from '../widgets/space.ts';
import type { Marks, Transcript } from '../widgets/transcript.ts';
import type { Dock } from './dock.ts';

/** The one hint of the footer. It names the key that opens the keys sheet. */
const KEYS_HINT = `${bindingLabel(KEYMAP.composer.bindings.keys)} keys`;

/** The hint while the dock shows on the screen. It adds the key that closes the top layer. */
const CLOSE_HINT = `${bindingLabel(KEYMAP.composer.bindings.escape)} close · ${KEYS_HINT}`;

/** The parts the painter draws into. */
export interface DrawParts {
	session: Session;
	transcript: Transcript;
	composer: Composer;
	/** The dock. The painter draws its tabs and its top layer. */
	dock: Dock;
	header: Header;
	/** Voice mode. The status line shows its phase. */
	voice: Voice;
	/** The thumbnails of the snapshot refs that the shown messages cite. */
	pictures: PictureCache;
	/** True when the terminal draws Kitty graphics. Capabilities can arrive after the start. */
	graphics: () => boolean;
	/** The height of a cell over its width. */
	cellAspect: () => number;
	/**
	 * The width the conversation has when the dock is closed. A widget gets
	 * its new width in the next layout pass, so a read right after the dock closes
	 * returns the old width.
	 */
	width: () => number;
}

/**
 * The drawing. It reads the session and paints the header, the conversation, and
 * the composer chrome. It holds the last drawn signature, so an unchanged
 * conversation does not redraw, and it holds the next message to reveal.
 */
export class Painter {
	private readonly session: Session;
	private readonly transcript: Transcript;
	private readonly composer: Composer;
	private readonly dock: Dock;
	private readonly header: Header;
	private readonly voice: Voice;
	private readonly pictures: PictureCache;
	private readonly graphics: () => boolean;
	private readonly cellAspect: () => number;
	private readonly width: () => number;
	private drawn = '';
	private reveal: string | undefined;

	constructor(parts: DrawParts) {
		this.session = parts.session;
		this.transcript = parts.transcript;
		this.composer = parts.composer;
		this.dock = parts.dock;
		this.header = parts.header;
		this.voice = parts.voice;
		this.pictures = parts.pictures;
		this.graphics = parts.graphics;
		this.cellAspect = parts.cellAspect;
		this.width = parts.width;
	}

	/** Reveal one message at the next draw, so a jump to it shows it. */
	revealMessage(seq: number): void {
		this.reveal = `message-${seq}`;
	}

	/** Reveal the folded line of one activation at the next draw, so its steps show when it expands. */
	revealStay(activation: string): void {
		this.reveal = `stay-${activation}`;
	}

	/** Force the next draw, after a change the signature does not show. */
	invalidate(): void {
		this.drawn = '';
	}

	/** Paint everything for the current mode and the chosen ref. */
	render(mode: Mode, picking?: string): void {
		this.drawTranscript(mode, picking);
		this.drawChrome(mode, picking);
		this.dock.draw();
	}

	/** Paint the composer chrome alone. A key in the composer calls it, so the one-shot flags of the conversation stay. */
	renderChrome(mode: Mode, picking?: string): void {
		this.drawChrome(mode, picking);
	}

	private marks(picking: string | undefined): Marks {
		const refs = new Map<number, RefItem[]>();
		for (const item of this.session.refItems)
			refs.set(item.seq, [...(refs.get(item.seq) ?? []), item]);
		const marks: Marks = { refs, picked: picking, focus: this.session.focus };
		// A Kitty picture draws above every cell, so it would show through a dock over the conversation.
		if (!this.graphics() || this.dock.covers) return marks;
		this.pictures.want(this.session.refItems.flatMap((item) => pictureRefs([item])));
		marks.pictures = stripsBySeq(this.session.refItems, (ref) => this.pictures.get(ref));
		marks.cellAspect = this.cellAspect();
		return marks;
	}

	private drawTranscript(mode: Mode, picking: string | undefined): void {
		const session = this.session;
		const reveal = this.reveal;
		this.reveal = undefined;
		const bottom = session.takeBottom();
		const empty = session.blocks.length === 0 && !session.notice && session.view !== undefined;
		const shown = empty && session.view ? emptyText(session.view) : session.notice;
		const marks = this.marks(mode === 'refs' ? picking : undefined);
		const signature = JSON.stringify([
			session.blocks,
			shown,
			session.noticeSeq,
			[...marks.refs.values()],
			marks.picked,
			marks.focus,
			[...(marks.pictures ?? [])].map(([seq, strips]) => [seq, strips.map(stripKey)]),
			marks.cellAspect,
		]);
		if (signature === this.drawn) return;
		this.drawn = signature;
		this.transcript.render(session.blocks, shown, reveal, bottom, marks);
	}

	private drawChrome(mode: Mode, picking: string | undefined): void {
		const session = this.session;
		this.drawHeader();
		this.composer.setChip(
			session.waiting?.toLowerCase() ?? (session.identity ? session.room || 'room' : 'who'),
			Boolean(session.view?.exchange),
			this.audience(),
		);
		this.composer.setPlaceholder(this.placeholder());
		this.composer.setCue(
			cueLines(session.pendingRefs, session.steering, this.width() - INSET - GUTTER),
		);
		this.composer.setRow(this.row(mode, picking), this.width());
	}

	/** The segments of the status row: the status, the counts of background work, and the keys hint. */
	private row(mode: Mode, picking: string | undefined): Segment[] {
		const { session } = this;
		const counts = countSegments({
			background: session.background,
			processes: session.runningProcesses,
			later: session.view?.scheduled.length ?? 0,
		});
		// The keys sheet opens from the composer only, so no other mode shows the hint.
		const keys: Segment[] =
			mode === 'compose'
				? [
						{
							key: 'keys',
							text: this.dock.onScreen ? CLOSE_HINT : KEYS_HINT,
							priority: PRIORITY.keys,
							tone: 'dim',
							side: 'right',
						},
					]
				: [];
		return [this.status(mode, picking), ...counts, ...keys];
	}

	/** Who the text of the composer reaches. A goal prompt and the person picker have no audience. */
	private audience(): Audience | undefined {
		const session = this.session;
		if (session.waiting || !session.identity) return undefined;
		return audienceOf(this.composer.text, session.host.team, session.view);
	}

	/** What the status line says about the chosen ref: why it does not open, or what Enter does. */
	private refStatus(picking: string | undefined): string {
		const stay = picking === undefined ? undefined : stayOfPick(picking);
		if (stay !== undefined)
			return this.session.unfolded?.id === stay
				? 'Enter folds this activation.'
				: 'Enter shows the steps of this activation.';
		const resolved = this.session.refItems.find((item) => item.id === picking)?.resolved;
		if (!resolved) return 'No ref is chosen.';
		if (!resolved.target)
			return `This ref does not open: ${resolved.problem ?? 'it does not resolve'}.`;
		return resolved.target.kind === 'message'
			? 'Enter jumps to this message.'
			: 'Enter opens this ref in the files layer.';
	}

	private placeholder(): string {
		const session = this.session;
		if (session.awaitingGoal) return `What is ${session.awaitingGoal} for?`;
		if (!session.identity) return 'Pick a person: type /user <name>';
		if (session.pendingRefs.length > 0) return 'Enter sends the attachments alone';
		if (this.voice.on) return this.voice.line;
		return 'Message the room, or type / for commands';
	}

	private drawHeader(): void {
		const { identity, view } = this.session;
		this.header.draw({ identity, view }, this.width());
	}

	/** What the status line says in a mode that is not the composer, or undefined. */
	private modeStatus(mode: Mode, picking: string | undefined): string | undefined {
		if (mode === 'dock') return this.dock.status;
		if (mode === 'refs') return this.refStatus(picking);
		if (mode === 'actions') return 'Choosing an action of a camera. Esc leaves.';
		return undefined;
	}

	/** The status line while a recording or a transcription runs. It is undefined in any other state. */
	private voiceStatus(): Segment | undefined {
		if (!this.voice.on || this.voice.phase === 'idle') return undefined;
		const listening = this.voice.phase === 'listening';
		return line(this.voice.line, 'muted', listening ? 'coral' : undefined);
	}

	/** The working line of the newest running activation, or undefined when none runs. */
	private workingStatus(): Segment | undefined {
		const working = this.session.working;
		if (!working) return undefined;
		return workingSegment(working, Date.now(), this.width() - INSET - GUTTER);
	}

	private status(mode: Mode, picking: string | undefined): Segment {
		const session = this.session;
		if (session.error) return line(`Error: ${session.error}`, 'red');
		if (session.offline) return line(`Cannot read the rooms: ${session.offline}`, 'red');
		const modal = this.modeStatus(mode, picking);
		if (modal !== undefined) return line(modal, 'muted');
		if (session.awaitingGoal)
			return line(
				`Type the goal for ${session.awaitingGoal}. Enter creates it. Esc cancels.`,
				'muted',
			);
		if (!session.identity) return line('Pick a person to begin.', 'muted');
		const view = session.view;
		if (!view) return line('Opening…', 'muted');
		if (view.status !== 'running')
			return line(`${view.name} is ${view.status}. Use /resume.`, 'muted');
		return this.voiceStatus() ?? this.workingStatus() ?? this.roomStatus(view);
	}

	/** The status line of a running room where nobody records and no activation runs. */
	private roomStatus(view: RoomView): Segment {
		const waiting = this.session.attention[0];
		if (waiting) return line(waiting, 'muted', 'coral');
		if (view.exchange) return line('A new message steers the open exchange', 'muted', 'coral');
		return line('Active', 'muted', 'green');
	}
}

/** The left segment of the status row: a text in a tone, with an optional dot. */
function line(text: string, tone: Segment['tone'], mark?: Segment['mark']): Segment {
	return {
		key: 'status',
		text,
		priority: PRIORITY.status,
		tone,
		side: 'left',
		...(mark ? { mark } : {}),
	};
}
