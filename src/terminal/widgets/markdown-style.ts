import {
	BoxRenderable,
	CodeRenderable,
	fg,
	MarkdownRenderable,
	type Renderable,
	type RenderContext,
	StyledText,
	SyntaxStyle,
	TextRenderable,
} from '@opentui/core';
import { tui as palette } from './brand.ts';

let shared: SyntaxStyle | undefined;

/**
 * The colors of a Markdown body, built from the terminal palette. The style
 * holds a native handle, so the module builds it once, at the first call, and
 * every message body shares it. Each heading level has its own style. The
 * plain `markup.heading` style marks the header row of a table.
 */
function markdownStyle(): SyntaxStyle {
	shared ??= SyntaxStyle.fromStyles({
		default: { fg: palette.text },
		conceal: { fg: palette.dim },
		'markup.heading': { fg: palette.text, bold: true, underline: true },
		'markup.heading.1': { fg: palette.accent, bold: true, underline: true },
		'markup.heading.2': { fg: palette.accent, bold: true },
		'markup.heading.3': { fg: palette.text, bold: true },
		'markup.heading.4': { fg: palette.muted, bold: true },
		'markup.heading.5': { fg: palette.muted, bold: true },
		'markup.heading.6': { fg: palette.muted, bold: true },
		'markup.strong': { bold: true },
		'markup.italic': { italic: true },
		'markup.strikethrough': { fg: palette.dim },
		'markup.raw': { fg: palette.note },
		'markup.raw.block': { fg: palette.note },
		'markup.link': { fg: palette.accent },
		'markup.link.label': { fg: palette.accent, underline: true },
		'markup.link.url': { fg: palette.accent, underline: true },
		'markup.list': { fg: palette.muted },
		'markup.quote': { fg: palette.muted },
	});
	return shared;
}

/**
 * A message body as Markdown with the markers concealed. A code block sits on
 * the raised tone. A list shows `•` bullets and task boxes. `fill` is the
 * background of the message, when it has one.
 *
 * The top-level block mode gives each block its own node and puts one empty
 * line around each heading, list, code block, table, and quote. OpenTUI marks
 * this option as internal, and `test/markdown.test.ts` holds its behavior.
 */
export function markdownBody(
	renderer: RenderContext,
	content: string,
	fill: string | undefined,
): MarkdownRenderable {
	return new MarkdownRenderable(renderer, {
		content,
		syntaxStyle: markdownStyle(),
		width: '100%',
		fg: palette.text,
		bg: fill,
		conceal: true,
		internalBlockMode: 'top-level',
		tableOptions: { style: 'columns', wrapMode: 'word' },
		renderNode: (token, context) => {
			if (token.type === 'code') return codeBlock(renderer, context.defaultRender());
			if (token.type === 'list') return list(renderer, token as unknown as ListToken, fill);
			return undefined;
		},
	});
}

/** The default code block on the raised tone, with one cell of space at each side. */
function codeBlock(renderer: RenderContext, code: Renderable | null): Renderable | undefined {
	if (!(code instanceof CodeRenderable)) return undefined;
	const box = new BoxRenderable(renderer, {
		width: '100%',
		flexShrink: 0,
		paddingX: 1,
		marginTop: 0,
		backgroundColor: palette.raised,
	});
	code.bg = palette.raised;
	code.marginTop = 0;
	box.add(code);
	return box;
}

/** The parts of a Markdown list that the list draws, as the parser gives them. */
interface ListToken {
	ordered: boolean;
	start: number | '';
	loose: boolean;
	items: ItemToken[];
}

/** One item of a list. A nested list is one of its tokens. */
interface ItemToken {
	task: boolean;
	checked?: boolean;
	loose: boolean;
	tokens: { type: string; raw: string }[];
}

/** The marker of one item, with a space after it: a task box, the number of an ordered item, or a bullet. */
function marker(
	renderer: RenderContext,
	list: ListToken,
	item: ItemToken,
	index: number,
): TextRenderable {
	const start = typeof list.start === 'number' ? list.start : 1;
	const width = list.ordered ? `${start + list.items.length - 1}.`.length : 1;
	let text = list.ordered ? `${start + index}.` : '•';
	if (item.task) text = item.checked ? '☑' : '☐';
	const color = item.task && item.checked ? palette.green : palette.muted;
	const content = `${text.padStart(width)} `;
	return new TextRenderable(renderer, {
		content: new StyledText([fg(color)(content)]),
		width: content.length,
		flexShrink: 0,
	});
}

/**
 * A list, one row for each item: the marker, then the blocks of the item. A
 * nested list indents under the marker of its parent item.
 */
function list(renderer: RenderContext, token: ListToken, fill: string | undefined): Renderable {
	const box = new BoxRenderable(renderer, {
		width: '100%',
		flexDirection: 'column',
		flexShrink: 0,
		marginTop: 0,
	});
	token.items.forEach((item, index) => {
		const row = new BoxRenderable(renderer, {
			width: '100%',
			flexDirection: 'row',
			flexShrink: 0,
			marginBottom: token.loose && index < token.items.length - 1 ? 1 : 0,
		});
		row.add(marker(renderer, token, item, index));
		row.add(itemBody(renderer, item, fill));
		box.add(row);
	});
	return box;
}

/** One block of an item, with the empty lines in the source before it. */
interface ItemBlock {
	token: ItemToken['tokens'][number];
	raw: string;
	gap: number;
}

/**
 * The blocks of one item, without the task box. In a loose list the parser
 * puts the task box in the text of the first block, so the item removes it
 * there.
 */
function itemBlocks(item: ItemToken): ItemBlock[] {
	const shown = item.tokens.filter((child) => child.type !== 'checkbox');
	const first = shown.find((child) => child.type !== 'space');
	const blocks: ItemBlock[] = [];
	shown.forEach((child, index) => {
		const raw =
			item.task && item.loose && child === first ? child.raw.replace(TASK_BOX, '') : child.raw;
		if (child.type === 'space' || !raw.trim()) return;
		const gap = blocks.length > 0 && shown[index - 1]?.type === 'space' ? 1 : 0;
		blocks.push({ token: child, raw, gap });
	});
	return blocks;
}

/**
 * The blocks of one item, in a column: a nested list as a list, every other
 * block as Markdown. An empty line in the source keeps one empty line.
 */
function itemBody(renderer: RenderContext, item: ItemToken, fill: string | undefined): Renderable {
	const column = new BoxRenderable(renderer, {
		flexDirection: 'column',
		flexGrow: 1,
		flexShrink: 1,
	});
	for (const block of itemBlocks(item)) {
		const node =
			block.token.type === 'list'
				? list(renderer, block.token as unknown as ListToken, fill)
				: markdownBody(renderer, block.raw.trimEnd(), fill);
		node.marginTop = block.gap;
		column.add(node);
	}
	return column;
}

/** The task box at the start of the text of an item. */
const TASK_BOX = /^\[[ xX]\] */;
