import {
	bg,
	type CliRenderer,
	fg,
	ImageRenderable,
	MarkdownRenderable,
	StyledText,
	SyntaxStyle,
	TextRenderable,
} from '@opentui/core';
import type { FileContent, ImageContent, TableView } from '../../host/host.ts';
import type { FileBrowser } from '../state/browser.ts';
import { tui as palette } from './brand.ts';
import { bytes, type ListLine, listLines, listRows, visibleLines } from './file-list.ts';
import { LIST_ROWS, lineText, listText, SidePanel } from './side-panel.ts';

const MAX_COLUMN = 40;

/** The rows that a picture takes in the preview. */
const IMAGE_ROWS = 24;

/** How markdown looks on the panel: headings in the accent, code in the note color. */
function markdownStyle(): SyntaxStyle {
	return SyntaxStyle.fromStyles({
		default: { fg: palette.text },
		'markup.heading': { fg: palette.accent, bold: true },
		'markup.heading.1': { fg: palette.accent, bold: true, underline: true },
		'markup.strong': { fg: palette.text, bold: true },
		'markup.italic': { fg: palette.text, italic: true },
		'markup.strikethrough': { fg: palette.dim },
		'markup.raw': { fg: palette.note },
		'markup.raw.block': { fg: palette.note },
		'markup.link': { fg: palette.accent, underline: true },
		'markup.link.label': { fg: palette.accent, underline: true },
		'markup.link.url': { fg: palette.dim },
		'markup.list': { fg: palette.accent },
		'markup.quote': { fg: palette.muted, italic: true },
		conceal: { fg: palette.dim },
	});
}

/** The size and shape of one file, for the title. */
function describe(file: FileContent): string {
	if (file.image) return `${bytes(file.image.data.length)}, ${file.image.mimeType}`;
	if (file.tables) return `${file.tables.length} ${file.tables.length === 1 ? 'table' : 'tables'}`;
	const lines = file.text.split('\n').length;
	const size = bytes(new TextEncoder().encode(file.text).length);
	return `${size}, ${lines} ${lines === 1 ? 'line' : 'lines'}${file.truncated ? ', truncated' : ''}`;
}

/** One table as aligned columns: a header, a rule, and the rows. */
function tableText(table: TableView): StyledText {
	const widths = table.columns.map((name, at) =>
		Math.min(MAX_COLUMN, Math.max(name.length, ...table.rows.map((row) => (row[at] ?? '').length))),
	);
	const line = (cells: readonly string[]) =>
		cells.map((text, at) => text.slice(0, MAX_COLUMN).padEnd(widths[at] ?? 0)).join('  ');
	const rule = widths.map((width) => '─'.repeat(width)).join('  ');
	const shown = table.rows.length;
	const more =
		table.count > shown ? [fg(palette.dim)(`\nFirst ${shown} of ${table.count} rows.`)] : [];
	return new StyledText([
		fg(palette.accent)(line(table.columns)),
		fg(palette.line)(`\n${rule}\n`),
		fg(palette.text)(table.rows.map(line).join('\n') || '(no rows)'),
		...more,
	]);
}

/** The tab line above a table: every table, with the shown one marked. */
function tabsText(tables: readonly TableView[], shown: number): StyledText {
	return new StyledText(
		tables.flatMap((table, at) => [
			at === shown
				? bg(palette.selected)(fg(palette.accent)(` ${table.name} ${table.count} `))
				: fg(palette.muted)(` ${table.name} ${table.count} `),
			fg(palette.muted)(' '),
		]),
	);
}

/** The chunks of one line of the list. The chosen row has the selected background. */
function paintLine(line: ListLine, chosen: boolean) {
	if (line.kind === 'gap') return [fg(palette.muted)('')];
	if (line.kind === 'heading') return [fg(line.cited ? palette.accent : palette.dim)(line.text)];
	const mark = chosen ? '▸ ' : line.mark === 'cited' ? '• ' : '  ';
	const text = `${mark}${line.text}`;
	return [chosen ? bg(palette.selected)(fg(palette.accent)(text)) : fg(palette.muted)(text)];
}

/** The files layer: a search box, the matching files, and the chosen file. */
export class FilesPanel extends SidePanel {
	private readonly search: TextRenderable;
	private readonly list: TextRenderable;
	private readonly title: TextRenderable;
	private readonly body: TextRenderable;
	private readonly markdown: MarkdownRenderable;
	private readonly image: ImageRenderable;
	private readonly tabs: TextRenderable;
	private shown: string | undefined;
	/** The browser that the last draw showed, for a redraw when the layer changes size. */
	private browser: FileBrowser | undefined;
	/** The width and the height of the layer at the last draw of the list. */
	private fitted = '';
	private flashing: ReturnType<typeof setTimeout> | undefined;

	constructor(renderer: CliRenderer) {
		super(renderer);
		this.search = lineText(renderer);
		this.list = listText(renderer);
		this.title = lineText(renderer);
		this.body = new TextRenderable(renderer, { content: '', wrapMode: 'word', width: '100%' });
		this.markdown = new MarkdownRenderable(renderer, {
			content: '',
			syntaxStyle: markdownStyle(),
			fg: palette.text,
			conceal: true,
			width: '100%',
			visible: false,
		});
		this.image = new ImageRenderable(renderer, {
			fit: 'fit',
			width: '100%',
			height: IMAGE_ROWS,
			visible: false,
			onError: () => this.flash('Cannot decode this picture.'),
		});
		this.tabs = lineText(renderer);
		this.tabs.visible = false;
		this.addBody(this.body, this.markdown, this.image);
		for (const part of [this.search, this.list, this.title, this.tabs, this.scroll, this.message])
			this.root.add(part);
		// The columns and the rows of the list follow the size of the layer.
		this.root.onSizeChange = () => {
			if (this.browser && this.fitted !== this.size()) this.draw(this.browser);
		};
	}

	/** Draw the browser's state. The preview scrolls back to the top when the file changes. */
	draw(browser: FileBrowser): void {
		if (!browser.open) return;
		this.browser = browser;
		const count = `${browser.matches.length} of ${browser.total}`;
		const cited = browser.cited > 0 ? ` · ${browser.cited} cited` : '';
		this.search.content = new StyledText([
			fg(palette.accent)('Files › '),
			fg(palette.text)(browser.query),
			fg(palette.accent)('▌'),
			fg(palette.dim)(`   ${count}${cited}`),
		]);
		this.list.content = this.rows(browser);
		this.drawPreview(browser);
	}

	private size(): string {
		return `${this.root.width}x${this.root.height}`;
	}

	private rows(browser: FileBrowser): StyledText {
		const matches = browser.matches;
		this.fitted = this.size();
		if (matches.length === 0) return new StyledText([fg(palette.muted)('No file matches.')]);
		const lines = listLines(matches, this.root.width);
		// A short list keeps eight lines, and a long one takes more while the layer is tall.
		const rows = Math.min(listRows(this.root.height), Math.max(LIST_ROWS, lines.length));
		this.list.height = rows;
		const [start, end] = visibleLines(lines, browser.index, rows);
		const chunks = lines.slice(start, end).flatMap((line, offset) => {
			const tail = start + offset === end - 1 ? '' : '\n';
			return [
				...paintLine(line, line.kind === 'row' && line.index === browser.index),
				fg(palette.muted)(tail),
			];
		});
		return new StyledText(chunks);
	}

	private drawPreview(browser: FileBrowser): void {
		const file = browser.file;
		this.tabs.visible = false;
		if (browser.problem || !file) {
			const text = browser.problem ?? 'Choose a file to read it.';
			this.title.content = new StyledText([fg(browser.problem ? palette.red : palette.dim)(text)]);
			this.showBody('');
			this.shown = undefined;
			return;
		}
		this.title.content = new StyledText([
			fg(palette.accent)(file.path),
			fg(palette.dim)(`   ${describe(file)}`),
		]);
		this.showFile(file, browser.tab);
		const key = `${file.path}:${browser.tab}`;
		if (this.shown !== key) this.scroll.scrollTop = 0;
		this.shown = key;
	}

	/** The one view that a file takes: a picture, a table, markdown, or plain text. */
	private showFile(file: FileContent, at: number): void {
		const table = file.tables?.[at];
		if (file.image) this.showImage(file.image);
		else if (file.tables && table) this.showTable(file.tables, table, at);
		else if (/\.md$/i.test(file.path)) this.showMarkdown(file.text);
		else this.showBody(file.text);
	}

	private showTable(tables: readonly TableView[], table: TableView, at: number): void {
		this.tabs.visible = true;
		this.tabs.content = tabsText(tables, at);
		this.body.content = tableText(table);
		this.body.wrapMode = 'none';
		this.markdown.visible = false;
		this.image.visible = false;
		this.body.visible = true;
	}

	private showBody(text: string): void {
		this.body.content = new StyledText([fg(palette.text)(text)]);
		this.body.wrapMode = 'word';
		this.markdown.visible = false;
		this.image.visible = false;
		this.body.visible = true;
	}

	private showMarkdown(text: string): void {
		if (this.markdown.content !== text) this.markdown.content = text;
		this.body.visible = false;
		this.image.visible = false;
		this.markdown.visible = true;
	}

	private showImage(image: ImageContent): void {
		this.body.visible = false;
		this.markdown.visible = false;
		this.image.source = image.data;
		this.image.visible = true;
	}

	/** Show a short message under the body, then hide it. */
	flash(message: string): void {
		this.showMessage(message);
		clearTimeout(this.flashing);
		this.flashing = setTimeout(() => {
			this.flashing = undefined;
			this.showMessage(undefined);
		}, 1_800);
	}
}
