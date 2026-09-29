/**
 * The side panels on OpenTUI's headless renderer. Each test draws a panel
 * from a browser that a fake host feeds, and reads the rendered frame.
 */
import { BoxRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileBrowser } from '../src/terminal/browser.ts';
import { FilesPanel } from '../src/terminal/files-panel.ts';
import { ProcessBrowser } from '../src/terminal/process-browser.ts';
import { ProcessesPanel } from '../src/terminal/process-panel.ts';
import { FakeHost } from './fake-host.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The page size that each panel reports at 100x30, with the frames below. */
const PAGE_FILES = 15;
const PAGE_PROCESSES = 11;

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

/** The clock of the process tests: a fixed time, so the ages in the frames never change. */
const NOW = Date.parse('2026-09-29T12:00:00Z');
const iso = (ago: number) => new Date(NOW - ago).toISOString();

/** Freeze `Date` and leave the timers alone, so the waits still run. */
function freezeClock(): void {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
}

/** The frame as the tests compare it: no trailing blanks on any line. */
const trimmed = (frame: string): string =>
	frame
		.split('\n')
		.map((line) => line.trimEnd())
		.join('\n');

/** `count` short lines, then one line wider than any panel, so the wrap and the padding show. */
const lines = (count: number, word: string) =>
	[...Array.from({ length: count }, (_, at) => `${word} ${at + 1}`), 'w'.repeat(200)].join('\n');

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
		freezeClock();
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

describe('the frames of the panels', () => {
	async function files(width: number, height: number) {
		const { setup, body, frame } = await mount(width, height);
		const host = new FakeHost();
		host.fileList = [...host.fileList, { path: '/shared/plan.txt', size: 400 }];
		const browser = new FileBrowser(
			async (path) => ({ path, text: lines(60, `line of ${path}`), truncated: false }),
			() => {},
		);
		const panel = new FilesPanel(setup.renderer);
		body.add(panel.root);
		browser.show(host.fileList, '/shared/plan.txt');
		await wait(30);
		panel.draw(browser);
		return { browser, panel, frame };
	}

	async function processList(width: number, height: number) {
		freezeClock();
		const { setup, body, frame } = await mount(width, height);
		const host = processes();
		host.processOutput = async (handle: string) => ({
			handle,
			text: lines(60, `output of ${handle}`),
			size: 900,
			truncated: false,
		});
		const browser = new ProcessBrowser(host, () => {});
		const panel = new ProcessesPanel(setup.renderer);
		body.add(panel.root);
		await browser.show();
		await wait(30);
		panel.draw(browser);
		return { browser, panel, frame };
	}

	it('draws the files panel with a long text file', async () => {
		const { frame } = await files(100, 30);
		expect(trimmed(await frame())).toMatchSnapshot();
	});

	it('draws the files panel with a search and a flash', async () => {
		const { browser, panel, frame } = await files(100, 30);
		browser.type('plan');
		await wait(30);
		panel.draw(browser);
		panel.flash('Copied to the clipboard.');
		expect(trimmed(await frame())).toMatchSnapshot();
	});

	it('draws the files panel over the whole width', async () => {
		const { browser, panel, frame } = await files(100, 30);
		panel.fill(true);
		panel.draw(browser);
		expect(trimmed(await frame())).toMatchSnapshot();
	});

	it('draws the files panel in a short terminal', async () => {
		const { frame } = await files(60, 14);
		expect(trimmed(await frame())).toMatchSnapshot();
	});

	it('draws the processes panel with a long output at its end', async () => {
		const { frame } = await processList(100, 30);
		expect(trimmed(await frame())).toMatchSnapshot();
	});

	it('draws the processes panel with the second process chosen', async () => {
		const { browser, panel, frame } = await processList(100, 30);
		browser.move(1);
		await wait(30);
		panel.draw(browser);
		expect(trimmed(await frame())).toMatchSnapshot();
	});

	it('draws the processes panel in a short terminal', async () => {
		const { frame } = await processList(60, 14);
		expect(trimmed(await frame())).toMatchSnapshot();
	});

	it('gives the page size of the scroll area to the keys', async () => {
		const opened = await files(100, 30);
		await opened.frame();
		const list = await processList(100, 30);
		await list.frame();
		expect([opened.panel.page, list.panel.page]).toEqual([PAGE_FILES, PAGE_PROCESSES]);
	});
});
