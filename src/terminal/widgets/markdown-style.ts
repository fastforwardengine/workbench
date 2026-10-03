import { SyntaxStyle } from '@opentui/core';
import { tui as palette } from './brand.ts';

let shared: SyntaxStyle | undefined;

/**
 * The colors of a Markdown body, built from the terminal palette. The style
 * holds a native handle, so the module builds it once, at the first call, and
 * every message body shares it.
 */
export function markdownStyle(): SyntaxStyle {
	shared ??= SyntaxStyle.fromStyles({
		default: { fg: palette.text },
		conceal: { fg: palette.dim },
		'markup.heading': { fg: palette.accent, bold: true },
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
