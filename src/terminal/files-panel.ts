import {
	bg,
	type CliRenderer,
	fg,
	MarkdownRenderable,
	StyledText,
	SyntaxStyle,
	TextRenderable,
} from '@opentui/core';
import type { FileContent, TableView } from '../host/host.ts';
import { tui as palette } from './brand.ts';
import type { FileBrowser } from './browser.ts';
import { LIST_ROWS, lineText, listText, SidePanel, windowStart } from './side-panel.ts';

const HINT = 'Type to search   Up/Down choose   PgUp/PgDn scroll   Ctrl+Y copy   Esc close';
const TABLE_HINT = 'Left/Right table   ';
const MAX_COLUMN = 40;

/** How markdown looks on the panel: headings in the accent, code in the summary color. */
function markdownStyle(): SyntaxStyle {
	return SyntaxStyle.fromStyles({
		default: { fg: palette.text },
		'markup.heading': { fg: palette.accent, bold: true },
		'markup.heading.1': { fg: palette.accent, bold: true, underline: true },
		'markup.strong': { fg: palette.text, bold: true },
		'markup.italic': { fg: palette.text, italic: true },
		'markup.strikethrough': { fg: palette.dim },
		'markup.raw': { fg: palette.summary },
		'markup.raw.block': { fg: palette.summary },
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

const bytes = (size: number): string =>
	size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;

/** The files panel: a search box, the matching files, and the chosen file beside the conversation. */
export class FilesPanel extends SidePanel {
	private readonly search: TextRenderable;
	private readonly list: TextRenderable;
	private readonly title: TextRenderable;
	private readonly body: TextRenderable;
	private readonly markdown: MarkdownRenderable;
	private readonly tabs: TextRenderable;
	private shown: string | undefined;
	private tables = false;
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
		this.tabs = lineText(renderer);
		this.tabs.visible = false;
		this.addBody(this.body, this.markdown);
		for (const part of [this.search, this.list, this.title, this.tabs, this.scroll, this.hint])
			this.root.add(part);
	}

	/** Draw the browser's state. The preview scrolls back to the top when the file changes. */
	draw(browser: FileBrowser): void {
		this.root.visible = browser.open;
		if (!browser.open) return;
		const matches = browser.matches;
		const count = `${matches.length} of ${browser.total}`;
		this.search.content = new StyledText([
			fg(palette.accent)('Files › '),
			fg(palette.text)(browser.query),
			fg(palette.accent)('▌'),
			fg(palette.dim)(`   ${count}`),
		]);
		this.list.content = this.rows(browser);
		this.drawPreview(browser);
		this.tables = (browser.file?.tables?.length ?? 0) > 1;
		if (!this.flashing) this.hint.content = new StyledText([fg(palette.dim)(this.hintText())]);
	}

	private rows(browser: FileBrowser): StyledText {
		const matches = browser.matches;
		if (matches.length === 0) return new StyledText([fg(palette.muted)('No file matches.')]);
		const start = windowStart(browser.index, matches.length);
		const width = Math.max(...matches.map((file) => (file.label ?? file.path).length));
		const chunks = matches.slice(start, start + LIST_ROWS).flatMap((file, offset) => {
			const chosen = start + offset === browser.index;
			const line = `${chosen ? '▸ ' : '  '}${(file.label ?? file.path).padEnd(width)}  ${file.kind ? file.kind : bytes(file.size)}`;
			const tail = offset === LIST_ROWS - 1 ? '' : '\n';
			return [
				chosen ? bg(palette.selected)(fg(palette.accent)(line)) : fg(palette.muted)(line),
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
		const table = file.tables?.[browser.table];
		if (file.tables && table) {
			this.tabs.visible = true;
			this.tabs.content = tabsText(file.tables, browser.table);
			this.body.content = tableText(table);
			this.body.wrapMode = 'none';
			this.markdown.visible = false;
			this.body.visible = true;
		} else if (/\.md$/i.test(file.path)) this.showMarkdown(file.text);
		else this.showBody(file.text);
		const key = `${file.path}:${browser.table}`;
		if (this.shown !== key) this.scroll.scrollTop = 0;
		this.shown = key;
	}

	private showBody(text: string): void {
		this.body.content = new StyledText([fg(palette.text)(text)]);
		this.body.wrapMode = 'word';
		this.markdown.visible = false;
		this.body.visible = true;
	}

	private showMarkdown(text: string): void {
		if (this.markdown.content !== text) this.markdown.content = text;
		this.body.visible = false;
		this.markdown.visible = true;
	}

	private hintText(): string {
		return this.tables ? `${TABLE_HINT}${HINT}` : HINT;
	}

	/** Replace the key hints with a short message, then bring the hints back. */
	flash(message: string): void {
		this.hint.content = new StyledText([fg(palette.summary)(message)]);
		clearTimeout(this.flashing);
		this.flashing = setTimeout(() => {
			this.flashing = undefined;
			this.hint.content = new StyledText([fg(palette.dim)(this.hintText())]);
		}, 1_800);
	}
}
