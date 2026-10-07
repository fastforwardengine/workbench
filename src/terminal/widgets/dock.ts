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

/** The fewest columns of the dock beside the conversation. */
const MIN_WIDTH = 40;

/** How the dock sits in the terminal. */
export interface DockLayout {
	/** True while the dock draws. */
	visible: boolean;
	/** True when the dock takes the whole width, because it replaces the conversation. */
	whole: boolean;
	/** True while the dock has the keys. The line at its edge turns to the accent. */
	keyed: boolean;
}

/**
 * The box at the right of the conversation. It has the `panel` background, one
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

	layout({ visible, whole, keyed }: DockLayout): void {
		this.root.visible = visible;
		this.root.width = whole ? '100%' : SHARE;
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
