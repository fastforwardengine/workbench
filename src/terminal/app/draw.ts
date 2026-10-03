import { fg, StyledText } from '@opentui/core';
import type { RefItem } from '../../view/refs.ts';
import { stagedCue } from '../state/attachments.ts';
import { isPanel, type Mode, type PanelMode } from '../state/mode.ts';
import type { PictureCache } from '../state/picture-cache.ts';
import { pictureRefs, stripKey, stripsBySeq } from '../state/pictures.ts';
import type { Session } from '../state/session.ts';
import { emptyText } from '../state/session-text.ts';
import { tui as palette } from '../widgets/brand.ts';
import type { Composer } from '../widgets/composer.ts';
import type { Header } from '../widgets/header.ts';
import type { Marks, Transcript } from '../widgets/transcript.ts';
import type { Surface } from './surface.ts';

const HINTS: Partial<Record<Mode, string>> = {
	compose: 'Enter sends   Ctrl+J newline   / commands   Ctrl+R rooms   Tab refs',
	refs: 'Up/Down choose a ref   Enter opens it   Esc back',
};

/** At this width or wider, the composer shows its hint line. */
const ROOMY = 96;

/** The parts the painter draws into. */
export interface DrawParts {
	session: Session;
	transcript: Transcript;
	composer: Composer;
	/** The side panels, by mode. The painter draws the one that is open. */
	surfaces: Readonly<Record<PanelMode, Surface>>;
	header: Header;
	/** The thumbnails of the snapshot refs that the shown messages cite. */
	pictures: PictureCache;
	/** True when the terminal draws Kitty graphics. Capabilities can arrive after the start. */
	graphics: () => boolean;
	/** The height of a cell over its width. */
	cellAspect: () => number;
	/**
	 * The width the conversation has when the files panel is closed. A widget gets
	 * its new width in the next layout pass, so a read right after the panel closes
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
	private readonly surfaces: Readonly<Record<PanelMode, Surface>>;
	private readonly header: Header;
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
		this.surfaces = parts.surfaces;
		this.header = parts.header;
		this.pictures = parts.pictures;
		this.graphics = parts.graphics;
		this.cellAspect = parts.cellAspect;
		this.width = parts.width;
	}

	/** Reveal one message at the next draw, so a jump to it shows it. */
	revealMessage(seq: number): void {
		this.reveal = `message-${seq}`;
	}

	/** Force the next draw, after a change the signature does not show. */
	invalidate(): void {
		this.drawn = '';
	}

	/** Paint everything for the current mode and the chosen ref. */
	render(mode: Mode, picking?: string): void {
		this.drawTranscript(mode, picking);
		this.drawChrome(mode, picking);
		if (isPanel(mode)) this.surfaces[mode].draw();
	}

	private marks(picking: string | undefined): Marks {
		const refs = new Map<number, RefItem[]>();
		for (const item of this.session.refItems)
			refs.set(item.seq, [...(refs.get(item.seq) ?? []), item]);
		const marks: Marks = { refs, picked: picking, focus: this.session.focus };
		if (!this.graphics()) return marks;
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
		);
		this.composer.setPlaceholder(this.placeholder());
		this.composer.setStatus(new StyledText(this.statusChunks(mode, picking)));
		this.composer.setCue(stagedCue(session.pendingRefs));
		const roomy = this.width() >= ROOMY;
		// A side panel draws its own hints, so its mode has none here.
		const quiet = session.error || session.offline || !roomy;
		this.composer.setHints(quiet ? '' : (HINTS[mode] ?? ''));
	}

	/** What the status line says about the chosen ref: why it does not open, or what Enter does. */
	private refStatus(picking: string | undefined): string {
		const resolved = this.session.refItems.find((item) => item.id === picking)?.resolved;
		if (!resolved) return 'No ref is chosen.';
		if (!resolved.target)
			return `This ref does not open: ${resolved.problem ?? 'it does not resolve'}.`;
		return resolved.target.kind === 'message'
			? 'Enter jumps to this message.'
			: 'Enter opens this ref in the files panel.';
	}

	private placeholder(): string {
		const session = this.session;
		if (session.awaitingGoal) return `What is ${session.awaitingGoal} for?`;
		if (!session.identity) return 'Pick a person: type /user <name>';
		if (session.pendingRefs.length > 0) return 'Enter sends the attachments alone';
		return 'Message the room, or type / for commands';
	}

	private drawHeader(): void {
		this.header.draw({ identity: this.session.identity, view: this.session.view }, this.width());
	}

	private statusChunks(mode: Mode, picking: string | undefined) {
		const session = this.session;
		if (session.error) return [fg(palette.red)(`Error: ${session.error}`)];
		if (session.offline) return [fg(palette.red)(`Cannot read the rooms: ${session.offline}`)];
		if (isPanel(mode)) return [fg(palette.muted)(this.surfaces[mode].status)];
		if (mode === 'refs') return [fg(palette.muted)(this.refStatus(picking))];
		if (session.awaitingGoal)
			return [
				fg(palette.muted)(
					`Type the goal for ${session.awaitingGoal}. Enter creates it. Esc cancels.`,
				),
			];
		if (!session.identity) return [fg(palette.muted)('Pick a person to begin.')];
		const view = session.view;
		if (!view) return [fg(palette.muted)('Opening…')];
		if (view.status !== 'running')
			return [fg(palette.muted)(`${view.name} is ${view.status}. Use /resume.`)];
		const waiting = session.attention[0];
		if (waiting) return [fg(palette.coral)('● '), fg(palette.muted)(waiting)];
		if (view.exchange)
			return [fg(palette.coral)('● '), fg(palette.muted)('A new message steers the open exchange')];
		return [fg(palette.green)('● '), fg(palette.muted)('Active')];
	}
}
