import { BoxRenderable, type CliRenderer, fg, StyledText, TextRenderable } from '@opentui/core';
import { type Binding, bindingLabel, KEYMAP } from '../state/keymap.ts';
import { tui as palette } from './brand.ts';
import { SidePanel } from './side-panel.ts';
import { GAP } from './space.ts';

/** One line of the sheet: a title, or a note. */
function textLine(
	renderer: CliRenderer,
	text: string,
	color: string,
	marginTop = 0,
): TextRenderable {
	return new TextRenderable(renderer, {
		content: new StyledText([fg(color)(text)]),
		flexShrink: 0,
		wrapMode: 'word',
		marginTop,
	});
}

/** The width of the column of keys. A wider label takes a row of its own. */
const KEY_COLUMN = 14;

/**
 * One row of the sheet: the keys at the left, and what they do beside them. A
 * label wider than the column puts what the keys do on the next row.
 */
function bindingRow(renderer: CliRenderer, label: string, does: string): BoxRenderable {
	const wide = label.length >= KEY_COLUMN;
	const row = new BoxRenderable(renderer, {
		flexDirection: wide ? 'column' : 'row',
		width: '100%',
		flexShrink: 0,
	});
	row.add(
		new TextRenderable(renderer, {
			content: new StyledText([fg(palette.text)(label)]),
			width: wide ? undefined : KEY_COLUMN,
			flexShrink: 0,
			wrapMode: 'none',
		}),
	);
	row.add(
		new TextRenderable(renderer, {
			content: new StyledText([fg(palette.muted)(does)]),
			flexGrow: 1,
			marginLeft: wide ? KEY_COLUMN : 0,
			wrapMode: 'word',
		}),
	);
	return row;
}

/** The keys sheet: every section of the key table, in a scrolling layer. */
export class KeysPanel extends SidePanel {
	constructor(renderer: CliRenderer) {
		super(renderer);
		const sheet = new BoxRenderable(renderer, { flexDirection: 'column', width: '100%' });
		Object.values(KEYMAP).forEach((section, index) => {
			const bindings: readonly Binding[] = Object.values(section.bindings);
			// A gap separates the sections. The first title has none above it.
			sheet.add(textLine(renderer, section.title, palette.accent, index > 0 ? GAP : 0));
			if ('note' in section) sheet.add(textLine(renderer, section.note, palette.dim));
			for (const binding of bindings)
				sheet.add(bindingRow(renderer, bindingLabel(binding), binding.does));
		});
		this.addBody(sheet);
		this.root.add(this.scroll);
	}
}
