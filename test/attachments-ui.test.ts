/**
 * The two widgets that the attachments touch, on OpenTUI's headless renderer:
 * the composer, which turns a pasted picture path into `/attach`, and the
 * files panel, which draws a picture.
 */
import { BoxRenderable, PasteEvent } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { FileBrowser } from '../src/terminal/state/browser.ts';
import { Composer } from '../src/terminal/widgets/composer.ts';
import { FilesPanel } from '../src/terminal/widgets/files-panel.ts';
import { PNG } from './png.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const paste = (text: string) => new PasteEvent(new TextEncoder().encode(text));

async function composer() {
	const setup = await createTestRenderer({ width: 100, height: 20 });
	cleanups.push(() => setup.renderer.destroy());
	const changes = { count: 0 };
	const made = new Composer(setup.renderer, {
		submit: () => {},
		change: () => {
			changes.count += 1;
		},
	});
	setup.renderer.root.add(made.root);
	made.focus();
	return { made, changes };
}

describe('a paste into the composer', () => {
	it('turns the path of a picture into /attach, when the composer is empty', async () => {
		const { made } = await composer();
		made.input.handlePaste(paste('/Users/priya/Desktop/bench.png'));
		expect(made.text).toBe('/attach /Users/priya/Desktop/bench.png');
	});

	it('takes a path under ~/ and one with a newline after it', async () => {
		const { made } = await composer();
		made.input.handlePaste(paste('~/Pictures/board.jpg\n'));
		expect(made.text).toBe('/attach ~/Pictures/board.jpg');
	});

	it('strips a terminal escape from a pasted path, as the textarea does for any paste', async () => {
		const { made } = await composer();
		made.input.handlePaste(paste('/tmp/\u001b[31mbench.png'));
		expect(made.text).toBe('/attach /tmp/bench.png');
	});

	it('lets the paste land as typed in a message that is already started', async () => {
		const { made } = await composer();
		made.setText('Look at ');
		made.input.handlePaste(paste('/tmp/bench.png'));
		expect(made.text).toBe('Look at /tmp/bench.png');
	});

	it.each([
		'the board is on the left.png',
		'/tmp/notes.md',
		'/tmp/one.png\n/tmp/two.png',
		'relative/pic.png',
	])('lets %j land as typed', async (text) => {
		const { made } = await composer();
		made.input.handlePaste(paste(text));
		expect(made.text).toBe(text);
	});
});

describe('the files panel, with a picture', () => {
	async function panelWith(files: Record<string, unknown>) {
		const setup = await createTestRenderer({ width: 100, height: 40 });
		cleanups.push(() => setup.renderer.destroy());
		const body = new BoxRenderable(setup.renderer, {
			flexDirection: 'row',
			width: '100%',
			height: '100%',
		});
		setup.renderer.root.add(body);
		const panel = new FilesPanel(setup.renderer);
		body.add(panel.root);
		const browser = new FileBrowser(
			async (path) => files[path] as never,
			() => {},
		);
		const entries = Object.keys(files).map((path) => ({ path, size: 10 }));
		const image = () => (panel as unknown as { image: { visible: boolean } }).image.visible;
		const frame = async () => {
			await setup.renderOnce();
			await setup.renderOnce();
			return setup.captureCharFrame();
		};
		return { browser, panel, entries, image, frame };
	}

	const picture = {
		path: '/attachments/1-bench.png',
		text: '',
		truncated: false,
		image: { data: new Uint8Array(PNG), mimeType: 'image/png' },
	};
	const note = { path: '/shared/notes.md', text: '# Notes', truncated: false };

	it('shows the size and the type of the picture in the title, and the picture in place of the text', async () => {
		const { browser, panel, entries, image, frame } = await panelWith({
			'/attachments/1-bench.png': picture,
			'/shared/notes.md': note,
		});
		browser.show(entries, '/attachments/1-bench.png');
		await wait(30);
		panel.draw(browser);
		const text = await frame();
		expect(text).toContain('/attachments/1-bench.png');
		expect(text).toContain(`${PNG.length} B, image/png`);
		expect(image()).toBe(true);
	});

	const others: [string, Record<string, unknown>][] = [
		['a markdown file', { path: '/shared/notes.md', text: '# Notes', truncated: false }],
		['a plain text file', { path: '/shared/plan.txt', text: 'plan', truncated: false }],
		[
			'a table',
			{
				path: '/shared/data.db',
				text: 'a',
				truncated: false,
				tables: [{ name: 't', columns: ['a'], rows: [['1']], count: 1 }],
			},
		],
	];

	it.each(others)('hides the picture again when the person moves to %s', async (_name, other) => {
		const path = String(other.path);
		const { browser, panel, entries, image, frame } = await panelWith({
			'/attachments/1-bench.png': picture,
			[path]: other,
		});
		browser.show(entries, '/attachments/1-bench.png');
		await wait(30);
		panel.draw(browser);
		await frame();
		expect(image()).toBe(true);
		browser.move(1);
		await wait(30);
		panel.draw(browser);
		const text = await frame();
		expect(image()).toBe(false);
		expect(text).toContain(path);
	});
});
