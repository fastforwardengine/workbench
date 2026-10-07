/**
 * A message body shows the structure of its Markdown: a style for each heading
 * level, code on the raised tone, an underlined table header, and list markers.
 */
import {
	type CapturedSpan,
	CodeRenderable,
	getTreeSitterClient,
	type Renderable,
	RGBA,
	TextAttributes,
} from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { tui as palette } from '../src/terminal/widgets/brand.ts';
import { markdownBody } from '../src/terminal/widgets/markdown-style.ts';

const cleanups: (() => void)[] = [];
beforeAll(async () => {
	await getTreeSitterClient().highlightOnce('# x', 'markdown');
}, 30_000);
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function highlighting(node: Renderable): boolean {
	if (node instanceof CodeRenderable && node.isHighlighting) return true;
	return node.getChildren().some(highlighting);
}

/** The lines of a body drawn at 50 columns, each with its spans, after the highlight ends. */
async function draw(content: string) {
	const setup = await createTestRenderer({ width: 50, height: 30 });
	cleanups.push(() => setup.renderer.destroy());
	const body = markdownBody(setup.renderer, content, undefined);
	setup.renderer.root.add(body);
	let last = '';
	let same = 0;
	for (let pass = 0; pass < 200 && same < 4; pass += 1) {
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		same = frame === last && !highlighting(body) ? same + 1 : 0;
		last = frame;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	const lines = last.split('\n').map((line) => line.trimEnd());
	const spans = setup.captureSpans().lines.map((line) => line.spans);
	return { lines, spans };
}

/** The span that holds `text`. */
function spanOf(spans: CapturedSpan[][], text: string): CapturedSpan {
	const span = spans.flat().find((item) => item.text.includes(text));
	if (!span) throw new Error(`no span holds ${text}`);
	return span;
}

const has = (span: CapturedSpan, attribute: number) => (span.attributes & attribute) !== 0;
const color = (hex: string) => RGBA.fromHex(hex).toString();

describe('the Markdown body of a message', () => {
	it('gives each heading level its own style', async () => {
		const { lines, spans } = await draw('# One\n\n## Two\n\n### Three\n\n#### Four');
		expect(lines.slice(0, 7)).toEqual(['One', '', 'Two', '', 'Three', '', 'Four']);
		const one = spanOf(spans, 'One');
		const two = spanOf(spans, 'Two');
		const three = spanOf(spans, 'Three');
		const four = spanOf(spans, 'Four');
		expect(has(one, TextAttributes.UNDERLINE)).toBe(true);
		expect(has(two, TextAttributes.UNDERLINE)).toBe(false);
		expect(one.fg.toString()).toBe(color(palette.accent));
		expect(two.fg.toString()).toBe(color(palette.accent));
		expect(three.fg.toString()).toBe(color(palette.text));
		expect(four.fg.toString()).toBe(color(palette.muted));
		for (const span of [one, two, three, four]) expect(has(span, TextAttributes.BOLD)).toBe(true);
	}, 20_000);

	it('puts a code block on the raised tone, the full width, with one empty line around it', async () => {
		const { lines, spans } = await draw(
			'Before.\n\n```python\ndef rail(v):\n    return v\n```\n\nAfter.',
		);
		expect(lines.slice(0, 6)).toEqual([
			'Before.',
			'',
			' def rail(v):',
			'     return v',
			'',
			'After.',
		]);
		for (const row of [2, 3]) {
			const line = spans[row] ?? [];
			expect(line.every((span) => span.bg.toString() === color(palette.raised))).toBe(true);
			expect(line.reduce((sum, span) => sum + span.width, 0)).toBe(50);
		}
		expect(spanOf(spans, 'Before').bg.toString()).not.toBe(color(palette.raised));
	}, 20_000);

	it('underlines the header row of a table', async () => {
		const { lines, spans } = await draw('| Part | Volts |\n|------|-------|\n| U1 | 3.3 |');
		expect(lines.slice(0, 2)).toEqual(['Part  Volts', 'U1    3.3']);
		expect(has(spanOf(spans, 'Part'), TextAttributes.UNDERLINE)).toBe(true);
		expect(has(spanOf(spans, 'U1'), TextAttributes.UNDERLINE)).toBe(false);
	}, 20_000);

	it('shows bullets, numbers, and task boxes, and indents a nested list under its item', async () => {
		const { lines, spans } = await draw(
			'- one\n- two **bold**\n  - nested\n- [ ] open\n- [x] done\n\n9. nine\n10. ten',
		);
		expect(lines.slice(0, 9)).toEqual([
			'• one',
			'• two bold',
			'  • nested',
			'☐ open',
			'☑ done',
			'',
			' 9. nine',
			'10. ten',
			'',
		]);
		expect(has(spanOf(spans, 'bold'), TextAttributes.BOLD)).toBe(true);
		expect(spanOf(spans, '☑').fg.toString()).toBe(color(palette.green));
	}, 20_000);
});
