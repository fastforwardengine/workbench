/**
 * The side panels on OpenTUI's headless renderer. Each test draws a panel
 * from a browser that a fake host feeds, and reads the rendered frame.
 */
import { BoxRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { FileBrowser } from '../src/terminal/browser.ts';
import { FilesPanel } from '../src/terminal/files-panel.ts';
import { ProcessBrowser } from '../src/terminal/process-browser.ts';
import { ProcessesPanel } from '../src/terminal/process-panel.ts';
import { FakeHost } from './fake-host.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A renderer with a row box like the body of the terminal, so a panel gets the height. */
async function mount(width = 100, height = 30) {
	const setup = await createTestRenderer({ width, height });
	cleanups.push(() => setup.renderer.destroy());
	const body = new BoxRenderable(setup.renderer, {
		flexDirection: 'row',
		width: '100%',
		height: '100%',
	});
	setup.renderer.root.add(body);
	const frame = async () => {
		await setup.renderOnce();
		await setup.renderOnce();
		return setup.captureCharFrame();
	};
	return { setup, body, frame };
}

const NOW = Date.now();
const iso = (ago: number) => new Date(NOW - ago).toISOString();

function processes(): FakeHost {
	const host = new FakeHost();
	host.processTable = [
		{
			handle: 'bash-aaa111',
			name: 'scan',
			kind: 'bash',
			agent: 'instruments',
			command: 'python3 scan/scan.py\nsecond line',
			state: 'running',
			output: '/x/out',
			timeout: 600,
			room: 'led-sweep',
			startedAt: iso(65_000),
		},
		{
			handle: 'bash-bbb222',
			kind: 'bash',
			agent: 'experiments',
			command: 'echo done',
			state: 'exited',
			exitCode: 0,
			output: '/x/out2',
			timeout: 600,
			startedAt: iso(9_000),
			endedAt: iso(5_000),
		},
	];
	return host;
}

describe('the files panel', () => {
	async function opened() {
		const { setup, body, frame } = await mount();
		const host = new FakeHost();
		const browser = new FileBrowser(
			(path) => host.file(path),
			() => {},
		);
		const panel = new FilesPanel(setup.renderer);
		body.add(panel.root);
		browser.show(host.fileList, '/library/cell-18650.md');
		await wait(30);
		panel.draw(browser);
		return { browser, panel, frame };
	}

	it('draws the search box, the list with the chosen row, the title, and the hints', async () => {
		const { frame } = await opened();
		const text = await frame();
		expect(text).toContain('Files › ▌   2 of 2');
		expect(text).toContain('▸ /library/cell-18650.md  797 B');
		expect(text).toContain('  /shared/notes.md        40 B');
		expect(text).toContain('/library/cell-18650.md   30 B, 1 line');
		expect(text).toContain('Type to search   Up/Down choose');
	});

	it('narrows the list to a search, and replaces the hints with a flash', async () => {
		const { browser, panel, frame } = await opened();
		browser.type('notes');
		await wait(30);
		panel.draw(browser);
		panel.flash('Copied to the clipboard.');
		const text = await frame();
		expect(text).toContain('Files › notes▌   1 of 2');
		expect(text).toContain('Copied to the clipboard.');
		expect(text).not.toContain('Type to search   Up/Down choose');
	});

	it('takes the whole width when the terminal is narrow, and hides when the browser closes', async () => {
		const { browser, panel, frame } = await opened();
		const before = (await frame()).split('\n')[0]?.trimEnd().length ?? 0;
		panel.fill(true);
		panel.draw(browser);
		const wide = (await frame()).split('\n')[0]?.trimEnd().length ?? 0;
		expect(wide).toBeGreaterThan(before);
		browser.hide();
		panel.draw(browser);
		expect(panel.root.visible).toBe(false);
	});
});

describe('the processes panel', () => {
	async function opened() {
		const { setup, body, frame } = await mount();
		const host = processes();
		const browser = new ProcessBrowser(host, () => {});
		const panel = new ProcessesPanel(setup.renderer);
		body.add(panel.root);
		await browser.show();
		await wait(30);
		panel.draw(browser);
		return { browser, panel, frame };
	}

	it('draws the heading, one row for each process, the command, and the output', async () => {
		const { frame } = await opened();
		const text = await frame();
		expect(text).toContain('Processes   1 running, 2 in all');
		expect(text).toMatch(/● ▸ scan\s+instruments\s+running 1m 5s/);
		expect(text).toMatch(/●\s+bash-bbb222\s+experiments\s+exit 0 after 4s/);
		expect(text).toContain('scan (bash-aaa111)');
		expect(text).toContain('$ python3 scan/scan.py');
		expect(text).toContain('output of bash-aaa111');
		expect(text).toContain('x x cancel');
	});

	it('shows the output of the process that is chosen', async () => {
		const { browser, panel, frame } = await opened();
		browser.move(1);
		await wait(30);
		panel.draw(browser);
		const text = await frame();
		expect(text).toContain('▸ bash-bbb222');
		expect(text).toContain('output of bash-bbb222');
	});
});

describe('both panels', () => {
	it('give the keys the same page size, scrolling, and clipboard reach', async () => {
		const { setup, body } = await mount();
		const files = new FilesPanel(setup.renderer);
		const list = new ProcessesPanel(setup.renderer);
		body.add(files.root);
		body.add(list.root);
		for (const panel of [files, list]) {
			expect(panel.page).toBeGreaterThanOrEqual(4);
			expect(() => panel.scrollBy(1)).not.toThrow();
			expect(typeof panel.copy('text')).toBe('boolean');
		}
	});
});
