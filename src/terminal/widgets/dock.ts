import {
	BoxRenderable,
	bold,
	type CliRenderer,
	fg,
	type Renderable,
	StyledText,
	TextRenderable,
} from '@opentui/core';
import type { LayerId } from '../state/layers.ts';
import { tui as palette } from './brand.ts';

/** The share of the width that the dock takes beside the conversation. */
const SHARE = '50%';

/** The share of the terminal width that the dock takes over the conversation. */
const OVERLAY_SHARE = 0.8;

/** The fewest columns of the dock. */
const MIN_WIDTH = 40;

/** The zIndex of the dock. It draws above the conversation. */
const ABOVE = 10;

/** The width in columns of the dock over the conversation: 80% of the terminal, 40 columns at least, and no more than the terminal. */
export const overlayWidth = (columns: number): number =>
	Math.min(columns, Math.max(MIN_WIDTH, Math.floor(columns * OVERLAY_SHARE)));

/** How the dock sits in the terminal. */
export interface DockLayout {
	/** True while the dock draws. */
	visible: boolean;
	/** The width in columns when the dock draws over the right part of the conversation. Undefined when it sits beside the conversation. */
	overlay: number | undefined;
	/** True while the dock has the keys. The line at its edge turns to the accent. */
	keyed: boolean;
}

/**
 * The box at the right of the conversation, beside it or over it. It has the `panel` background, one
 * line at its left edge, and a tabs line that names the open layers. The top
 * layer fills the rest. The box has no other border.
 */
export class DockPanel {
	readonly root: BoxRenderable;
	private readonly tabs: TextRenderable;
	private readonly body: BoxRenderable;

	constructor(renderer: CliRenderer) {
		this.root = new BoxRenderable(renderer, {
			flexDirection: 'column',
			width: SHARE,
			minWidth: MIN_WIDTH,
			flexShrink: 0,
			zIndex: ABOVE,
			border: ['left'],
			borderColor: palette.line,
			backgroundColor: palette.panel,
			paddingLeft: 1,
			paddingRight: 1,
			visible: false,
		});
		this.tabs = new TextRenderable(renderer, {
			content: '',
			flexShrink: 0,
			wrapMode: 'none',
			marginBottom: 1,
		});
		this.body = new BoxRenderable(renderer, { flexDirection: 'column', flexGrow: 1, minHeight: 0 });
		this.root.add(this.tabs);
		this.root.add(this.body);
	}

	/** Put the box of a layer in the dock. The dock shows one box at a time. */
	add(layer: Renderable): void {
		this.body.add(layer);
	}

	layout({ visible, overlay, keyed }: DockLayout): void {
		this.root.visible = visible;
		// An overlay sits at the right edge of the body and takes its height. Its box leaves the row of the conversation.
		const edge = overlay === undefined ? undefined : 0;
		this.root.position = overlay === undefined ? 'relative' : 'absolute';
		this.root.width = overlay ?? SHARE;
		this.root.minWidth = overlay === undefined ? MIN_WIDTH : 0;
		this.root.right = edge;
		this.root.top = edge;
		this.root.bottom = edge;
		this.root.borderColor = keyed ? palette.accent : palette.line;
	}

	/** Name the open layers, with the top one marked. */
	draw(open: readonly LayerId[], top: LayerId | undefined): void {
		this.tabs.content = new StyledText(
			open.flatMap((id, at) => [
				...(at > 0 ? [fg(palette.dim)(' · ')] : []),
				id === top ? bold(fg(palette.accent)(id)) : fg(palette.dim)(id),
			]),
		);
	}
}
