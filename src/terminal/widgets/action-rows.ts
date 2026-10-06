import {
	BoxRenderable,
	bg,
	type CliRenderer,
	fg,
	StyledText,
	type TextChunk,
	TextRenderable,
} from '@opentui/core';
import type { Row, Tone } from '../state/action-pad.ts';
import { tui as palette } from './brand.ts';

const TONES: Record<Tone, string> = {
	dim: palette.dim,
	info: palette.muted,
	error: palette.red,
};

/** One row as a styled line. A button is a label in brackets, and the focused one is marked. */
function chunksOf(row: Row): TextChunk[] {
	if (row.type === 'note') return [fg(TONES[row.tone])(row.text)];
	if (row.done) return [fg(palette.dim)(`  ✓ ${row.label}  done`)];
	if (row.blocked !== undefined)
		return [fg(palette.dim)(`${row.focused ? '▸' : ' '} [ ${row.label} ]  ${row.blocked}`)];
	if (row.focused) return [bg(palette.selected)(fg(palette.accent)(`▸ [ ${row.label} ]`))];
	return [fg(palette.text)(`  [ ${row.label} ]`)];
}

/**
 * The actions of one camera, drawn as lines under its box: each action as a button, and the
 * last result. It holds no state. `draw` takes the rows that an `ActionPad` gives.
 */
export class ActionRows {
	readonly root: BoxRenderable;
	private readonly renderer: CliRenderer;
	private drawn = '';

	constructor(renderer: CliRenderer) {
		this.renderer = renderer;
		this.root = new BoxRenderable(renderer, {
			flexDirection: 'column',
			width: '100%',
			flexShrink: 0,
			visible: false,
		});
	}

	/** Draw the rows. An unchanged list draws nothing. */
	draw(rows: readonly Row[]): void {
		this.root.visible = rows.length > 0;
		const signature = JSON.stringify(rows);
		if (signature === this.drawn) return;
		this.drawn = signature;
		for (const old of this.root.getChildren()) {
			this.root.remove(old);
			old.destroyRecursively();
		}
		for (const row of rows)
			this.root.add(
				new TextRenderable(this.renderer, {
					content: new StyledText(chunksOf(row)),
					flexShrink: 0,
					wrapMode: row.type === 'button' ? 'none' : 'word',
					width: '100%',
				}),
			);
	}
}
