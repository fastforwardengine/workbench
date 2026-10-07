import {
	BoxRenderable,
	type CliRenderer,
	fg,
	type Renderable,
	ScrollBoxRenderable,
	StyledText,
	TextRenderable,
} from '@opentui/core';
import { tui as palette } from './brand.ts';

/** How many rows of the list a side panel shows. */
export const LIST_ROWS = 8;

/** The rows to show: a window of the matches that keeps the chosen row in view. */
export function windowStart(index: number, count: number): number {
	return Math.max(0, Math.min(index - Math.floor(LIST_ROWS / 2), count - LIST_ROWS));
}

/** A line of the panel that never shrinks and never wraps: a heading, a search box, or a tab line. */
export function lineText(renderer: CliRenderer): TextRenderable {
	return new TextRenderable(renderer, { content: '', flexShrink: 0, wrapMode: 'none' });
}

/** The list of a side panel: `LIST_ROWS` rows, one line each. */
export function listText(renderer: CliRenderer): TextRenderable {
	return new TextRenderable(renderer, {
		content: '',
		flexShrink: 0,
		height: LIST_ROWS,
		wrapMode: 'none',
	});
}

/**
 * What the files panel and the processes panel share: a box beside the
 * conversation that stays hidden until it opens, a scrolling body, a message line
 * that shows only while it has text, and the keys' access to scrolling and to the
 * clipboard. A subclass makes its own heading, list, and title, then adds them to
 * `root` in order, with `scroll` last. A panel that shows messages adds `message`
 * after `scroll`.
 */
export abstract class SidePanel {
	readonly root: BoxRenderable;
	protected readonly renderer: CliRenderer;
	protected readonly scroll: ScrollBoxRenderable;
	protected readonly message: TextRenderable;
	/** The share of the width that the panel takes beside the conversation. */
	private readonly share: `${number}%`;

	/**
	 * `sticky` keeps the body at its end while it grows, as a log does. `share`
	 * is the width beside the conversation.
	 */
	protected constructor(renderer: CliRenderer, sticky = false, share: `${number}%` = '55%') {
		this.renderer = renderer;
		this.share = share;
		this.root = new BoxRenderable(renderer, {
			flexDirection: 'column',
			width: share,
			flexShrink: 0,
			minWidth: 40,
			border: true,
			borderColor: palette.line,
			backgroundColor: palette.panel,
			paddingLeft: 1,
			paddingRight: 1,
			visible: false,
		});
		this.scroll = new ScrollBoxRenderable(renderer, {
			flexGrow: 1,
			scrollY: true,
			...(sticky ? { stickyScroll: true, stickyStart: 'bottom' as const } : {}),
			backgroundColor: palette.panel,
			scrollbarOptions: {
				trackOptions: { backgroundColor: palette.bg, foregroundColor: palette.line },
			},
		});
		this.message = new TextRenderable(renderer, {
			content: '',
			flexShrink: 0,
			wrapMode: 'word',
			visible: false,
		});
	}

	/** Put the body in the scroll area. The padding keeps the text clear of the scrollbar. */
	protected addBody(...parts: Renderable[]): void {
		const padded = new BoxRenderable(this.renderer, { paddingRight: 2, width: '100%' });
		for (const part of parts) padded.add(part);
		this.scroll.add(padded);
	}

	/** Show a short message under the body, such as the result of a copy. Without text, the line hides. */
	protected showMessage(text: string | undefined): void {
		this.message.visible = Boolean(text);
		this.message.content = new StyledText(text ? [fg(palette.note)(text)] : []);
	}

	/** Give the panel the whole width, or a share of it beside the conversation. */
	fill(whole: boolean): void {
		this.root.width = whole ? '100%' : this.share;
	}

	scrollBy(lines: number): void {
		this.scroll.scrollBy(lines);
	}

	get page(): number {
		return Math.max(4, this.scroll.height - 1);
	}

	/** Copy text to the clipboard through the terminal. Return false when it cannot. */
	copy(text: string): boolean {
		return this.renderer.isOsc52Supported() && this.renderer.copyToClipboardOSC52(text);
	}
}
