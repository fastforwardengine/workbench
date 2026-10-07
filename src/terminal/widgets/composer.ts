import {
	BoxRenderable,
	bg,
	bold,
	type CliRenderer,
	decodePasteBytes,
	fg,
	type PasteEvent,
	StyledText,
	stripAnsiSequences,
	type TextareaOptions,
	TextareaRenderable,
	type TextChunk,
	TextRenderable,
} from '@opentui/core';
import { pastedImagePath } from '../state/attachments.ts';
import type { Audience } from '../state/audience.ts';
import type { Suggestion } from '../state/commands.ts';
import type { CueLine } from '../state/cue.ts';
import { KEYMAP } from '../state/keymap.ts';
import { fitSegments, MARK, SEPARATOR, type Segment, type Tone } from '../state/status-row.ts';
import { tui as palette } from './brand.ts';
import { APART, GUTTER, INSET } from './space.ts';

/**
 * A textarea that offers a pasted line to `onPastedLine` before it inserts the
 * paste as text. Returning `true` consumes the paste: the line never lands in
 * the message, because the composer offered `/attach` in its place.
 */
class PasteAwareTextarea extends TextareaRenderable {
	private readonly onPastedLine?: (line: string) => boolean;

	constructor(
		renderer: CliRenderer,
		options: TextareaOptions & { onPastedLine?: (line: string) => boolean },
	) {
		super(renderer, options);
		this.onPastedLine = options.onPastedLine;
	}

	override handlePaste(event: PasteEvent): void {
		const line = stripAnsiSequences(decodePasteBytes(event.bytes));
		if (this.onPastedLine?.(line)) return;
		super.handlePaste(event);
	}
}

/** The palette's title, by what its rows complete to. */
const TITLES = {
	command: 'Commands',
	room: 'Rooms',
	person: 'People',
	file: 'Files',
	say: 'Says that wait',
	seat: 'Seats',
} as const;

/** The color of the left rail while the composer has the keys, by the mode of the text. */
const RAIL: Record<Audience['mode'], string> = {
	plain: palette.accent,
	command: palette.note,
	mention: palette.coral,
};

/** The color of each tone of a status segment. */
const TONES: Record<Tone, string> = {
	muted: palette.muted,
	dim: palette.dim,
	coral: palette.coral,
	green: palette.green,
	red: palette.red,
};

/** The cells that the padding of the status row takes from its width. */
const ROW_PADDING = INSET + GUTTER;

const MAX_INPUT_LINES = 6;
const MAX_PALETTE_ROWS = 6;

/** The chunks of segments of one side: each segment in its tone, with a dim separator between them. */
function chunksOf(segments: readonly Segment[]): TextChunk[] {
	return segments.flatMap((segment, at) => [
		...(at > 0 ? [fg(palette.dim)(SEPARATOR)] : []),
		...(segment.mark ? [fg(TONES[segment.mark])(MARK)] : []),
		fg(TONES[segment.tone])(segment.text),
	]);
}

export interface ComposerEvents {
	/** The person pressed Enter. */
	submit: () => void;
	/** The text changed. */
	change: () => void;
}

/**
 * The composer. It holds the room chip and a multi-line input, a palette of
 * commands or rooms above them, and a status line below.
 */
export class Composer {
	readonly root: BoxRenderable;
	readonly input: PasteAwareTextarea;
	private readonly chip: TextRenderable;
	private focused = false;
	private mode: Audience['mode'] = 'plain';
	private readonly frame: BoxRenderable;
	private readonly paletteBox: BoxRenderable;
	private readonly paletteTitle: TextRenderable;
	private readonly paletteText: TextRenderable;
	private readonly cue: TextRenderable;
	private readonly cueRow: BoxRenderable;
	private readonly status: TextRenderable;
	private readonly right: TextRenderable;
	private readonly events: ComposerEvents;

	constructor(renderer: CliRenderer, events: ComposerEvents) {
		this.events = events;
		this.root = new BoxRenderable(renderer, { flexDirection: 'column', flexShrink: 0 });
		this.paletteText = new TextRenderable(renderer, { content: '' });
		this.paletteTitle = new TextRenderable(renderer, { content: '', wrapMode: 'none' });
		this.paletteBox = new BoxRenderable(renderer, {
			flexDirection: 'column',
			backgroundColor: palette.panel,
			paddingLeft: INSET,
			visible: false,
		});
		this.paletteBox.add(this.paletteTitle);
		this.paletteBox.add(this.paletteText);
		this.cue = new TextRenderable(renderer, { content: '', wrapMode: 'none' });
		this.cueRow = new BoxRenderable(renderer, {
			paddingLeft: INSET,
			height: 1,
			backgroundColor: palette.panel,
			visible: false,
		});
		this.cueRow.add(this.cue);
		this.chip = new TextRenderable(renderer, { content: '', flexShrink: 0 });
		this.input = new PasteAwareTextarea(renderer, {
			flexGrow: 1,
			height: 1,
			placeholder: 'Message the room, or type / for commands',
			placeholderColor: palette.dim,
			textColor: palette.text,
			focusedTextColor: palette.text,
			backgroundColor: palette.panel,
			focusedBackgroundColor: palette.panel,
			keyBindings: [
				...KEYMAP.composer.bindings.send.keys.map((chord) => ({
					...chord,
					action: 'submit' as const,
				})),
				...KEYMAP.composer.bindings.newline.keys.map((chord) => ({
					...chord,
					action: 'newline' as const,
				})),
			],
			onSubmit: () => events.submit(),
			onContentChange: () => {
				this.resize();
				events.change();
			},
			onPastedLine: (line) => this.suggestAttach(line),
		});
		this.frame = new BoxRenderable(renderer, {
			flexDirection: 'row',
			gap: GUTTER,
			border: ['left'],
			borderColor: palette.line,
			backgroundColor: palette.panel,
			paddingLeft: GUTTER,
		});
		this.frame.add(this.chip);
		this.frame.add(this.input);
		this.status = new TextRenderable(renderer, { content: '', flexGrow: 1 });
		this.right = new TextRenderable(renderer, { content: '', flexShrink: 0 });
		const row = new BoxRenderable(renderer, {
			flexDirection: 'row',
			gap: APART,
			paddingLeft: INSET,
			paddingRight: GUTTER,
		});
		row.add(this.status);
		row.add(this.right);
		this.root.add(this.paletteBox);
		this.root.add(this.cueRow);
		this.root.add(this.frame);
		this.root.add(row);
	}

	get text(): string {
		return this.input.plainText;
	}

	/** Replace the text. The input reports typed edits only, so this reports its own change. */
	setText(text: string): void {
		this.input.setText(text);
		this.input.gotoBufferEnd();
		this.resize();
		this.events.change();
	}

	/**
	 * A paste into an empty composer that names one picture, absolute or under
	 * `~/`, fills `/attach` in place of the raw path. True consumes the paste.
	 * False lets a paste into a message that the person has started land as typed.
	 */
	private suggestAttach(line: string): boolean {
		if (this.text.trim() !== '') return false;
		const path = pastedImagePath(line);
		if (path === undefined) return false;
		this.setText(`/attach ${path}`);
		return true;
	}

	focus(): void {
		this.input.focus();
		this.focused = true;
		this.paintRail();
	}

	blur(): void {
		this.input.blur();
		this.focused = false;
		this.paintRail();
	}

	/** A focused rail takes the color of the mode of the text. A blurred rail is a line. */
	private paintRail(): void {
		this.frame.borderColor = this.focused ? RAIL[this.mode] : palette.line;
	}

	/**
	 * Show what the composer sends to, such as a room. A dot means the room is working.
	 * The audience follows the room: the seats that hear the message, and a note on one named seat.
	 */
	setChip(label: string, working: boolean, audience?: Audience): void {
		const dot = working ? fg(palette.coral)('● ') : fg(palette.dim)('');
		const names = audience?.names.join(', ');
		this.chip.content = new StyledText([
			dot,
			bold(fg(palette.accent)(`${label} ›`)),
			...(names ? [fg(palette.muted)(` ${names}`)] : []),
			...(audience?.note ? [fg(palette.dim)(` (${audience.note})`)] : []),
		]);
		this.mode = audience?.mode ?? 'plain';
		this.paintRail();
	}

	setPlaceholder(text: string): void {
		this.input.placeholder = text;
	}

	/** Show the lines of the cue above the input, one row each. No line hides the cue. */
	setCue(lines: readonly CueLine[]): void {
		this.cueRow.visible = lines.length > 0;
		this.cueRow.height = Math.max(1, lines.length);
		this.cue.content = new StyledText(
			lines.flatMap((line, at) => [
				...(at > 0 ? [fg(palette.muted)('\n')] : []),
				fg(TONES[line.markTone])(`${line.mark} `),
				fg(TONES[line.tone])(line.text),
			]),
		);
	}

	/**
	 * Show the status row. `width` is the width of the row with its padding. The
	 * row drops the segments with the lowest priority until the rest fits. The left
	 * segments grow from the left edge, and the right segments keep their width.
	 */
	setRow(segments: readonly Segment[], width: number): void {
		const kept = fitSegments(segments, width - ROW_PADDING, APART);
		this.status.content = new StyledText(
			chunksOf(kept.filter((segment) => segment.side === 'left')),
		);
		this.right.content = new StyledText(
			chunksOf(kept.filter((segment) => segment.side === 'right')),
		);
	}

	/** Show the palette rows, with one picked. An empty list hides the palette. */
	setPalette(rows: readonly Suggestion[], pick: number): void {
		this.paletteBox.visible = rows.length > 0;
		if (rows.length === 0) return;
		const first = Math.max(
			0,
			Math.min(pick - (MAX_PALETTE_ROWS - 1), rows.length - MAX_PALETTE_ROWS),
		);
		const shown = rows.slice(first, first + MAX_PALETTE_ROWS);
		const width = Math.max(...rows.map((row) => row.label.length)) + 2;
		this.paletteTitle.content = new StyledText([
			fg(palette.muted)(TITLES[rows[0]?.kind ?? 'command']),
		]);
		this.paletteBox.height = shown.length + 1;
		const chunks = shown.flatMap((row, index) => {
			const chosen = first + index === pick;
			const fill = chosen ? palette.selected : palette.panel;
			const label = row.label.padEnd(width);
			const line = [
				bg(fill)(fg(chosen ? palette.text : palette.accent)(label)),
				bg(fill)(fg(palette.muted)(row.detail)),
			];
			return index < shown.length - 1
				? [...line, bg(palette.panel)(fg(palette.muted)('\n'))]
				: line;
		});
		this.paletteText.content = new StyledText(chunks);
	}

	/** Grow the input with its text, up to a few lines. */
	private resize(): void {
		// virtualLineCount lags the edit until the next layout, so also count the lines typed.
		const lines = Math.max(this.input.lineCount, this.input.virtualLineCount);
		this.input.height = Math.max(1, Math.min(MAX_INPUT_LINES, lines));
	}
}
