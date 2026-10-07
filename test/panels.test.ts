/**
 * The layers of the dock on OpenTUI's headless renderer. Each test draws a layer
 * from a browser that a fake host feeds, in a dock, and reads the rendered frame.
 */
import { BoxRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileBrowser } from '../src/terminal/state/browser.ts';
import type { LayerId } from '../src/terminal/state/layers.ts';
import { ProcessBrowser } from '../src/terminal/state/process-browser.ts';
import { DockPanel } from '../src/terminal/widgets/dock.ts';
import { FilesPanel } from '../src/terminal/widgets/files-panel.ts';
import { ProcessesPanel } from '../src/terminal/widgets/process-panel.ts';
import { FakeHost } from './fake-host.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The page size that each panel reports at 100x30, with the frames below. */
const PAGE_FILES = 17;
const PAGE_PROCESSES = 13;

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
	/** Put a layer on top of a dock beside the body, as the terminal does. */
	const place = (layer: { root: BoxRenderable }, id: LayerId) => {
		const dock = new DockPanel(setup.renderer);
		dock.add(layer.root);
		layer.root.visible = true;
		dock.layout({ visible: true, overlay: undefined, keyed: true });
		dock.draw([id], id);
		body.add(dock.root);
		return dock;
	};
	const frame = async () => {
		await setup.renderOnce();
		await setup.renderOnce();
		return setup.captureCharFrame();
	};
	return { setup, place, frame };
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
			agent: 'engineer',
			command: 'python3 scan/scan.py\nsecond line',
			state: 'running',
			output: '/x/out',
			timeout: 600,
			grace: 10,
			port: 20001,
			room: 'build',
			startedAt: iso(65_000),
		},
		{
			handle: 'bash-bbb222',
			kind: 'bash',
			agent: 'researcher',
			command: 'echo done',
			state: 'exited',
			exitCode: 0,
			output: '/x/out2',
			timeout: 600,
			grace: 10,
			port: 20002,
			startedAt: iso(9_000),
			endedAt: iso(5_000),
		},
	];
	return host;
}

describe('the files panel', () => {
	async function opened() {
		const { setup, place, frame } = await mount();
		const host = new FakeHost();
		const browser = new FileBrowser(
			(path) => host.file(path),
			() => {},
		);
		const panel = new FilesPanel(setup.renderer);
		const dock = place(panel, 'files');
		browser.show(host.fileList, '/library/cell-18650.md');
		await wait(30);
		panel.draw(browser);
		return { browser, panel, dock, frame };
	}

	it('draws the search box, the list with the chosen row, and the title', async () => {
		const { frame } = await opened();
		const text = await frame();
		expect(text).toContain('Files › ▌   2 of 2');
		expect(text).toContain('▸ /library/cell-18650.md  797 B');
		expect(text).toContain('  /shared/notes.md        40 B');
		expect(text).toContain('/library/cell-18650.md   30 B, 1 line');
		expect(text).not.toContain('Type to search');
	});

	it('narrows the list to a search, and shows a flash', async () => {
		const { browser, panel, frame } = await opened();
		browser.type('notes');
		await wait(30);
		panel.draw(browser);
		panel.flash('Copied to the clipboard.');
		const text = await frame();
		expect(text).toContain('Files › notes▌   1 of 2');
		expect(text).toContain('Copied to the clipboard.');
	});

	it('sits at the right edge with the width of an overlay', async () => {
		const { dock, frame } = await opened();
		await frame();
		const share = dock.root.width;
		expect(share).toBe(50);
		dock.layout({ visible: true, overlay: 80, keyed: true });
		await frame();
		expect(dock.root.width).toBe(80);
		expect(dock.root.x).toBe(20);
		dock.layout({ visible: true, overlay: undefined, keyed: true });
		await frame();
		expect(dock.root.width).toBe(share);
	});
});

describe('the processes panel', () => {
	async function opened() {
		freezeClock();
		const { setup, place, frame } = await mount();
		const host = processes();
		const browser = new ProcessBrowser(host, () => {});
		cleanups.unshift(() => browser.dispose());
		const panel = new ProcessesPanel(setup.renderer);
		place(panel, 'processes');
		await browser.show();
		await wait(30);
		panel.draw(browser);
		return { browser, panel, frame };
	}

	it('draws the heading, one row for each process, the command, and the output', async () => {
		const { frame } = await opened();
		const text = await frame();
		expect(text).toContain('Processes   1 running, 2 in all');
		expect(text).toMatch(/● ▸ scan\s+engineer\s+running 1m 5s/);
		expect(text).toMatch(/●\s+bash-bbb222\s+researcher\s+exit 0 after 4s/);
		expect(text).toContain('scan (bash-aaa111)');
		expect(text).toContain('$ python3 scan/scan.py');
		expect(text).toContain('output of bash-aaa111');
		expect(text).not.toContain('x x cancel');
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

describe('the output of a running process, as it grows', () => {
	/** A chosen running process whose output has `rows.count` rows. A new read gives the new count. */
	async function growing() {
		const { setup, place, frame } = await mount(100, 30);
		const host = processes();
		const rows = { count: 80 };
		host.processOutput = async (handle: string) => {
			const text = `${Array.from({ length: rows.count }, (_, at) => `row ${at + 1}`).join('\n')}\n`;
			return { handle, text, size: text.length, truncated: false };
		};
		const browser = new ProcessBrowser(host, () => {});
		cleanups.unshift(() => browser.dispose());
		const panel = new ProcessesPanel(setup.renderer);
		place(panel, 'processes');
		await browser.show();
		await wait(30);
		panel.draw(browser);
		/** What a tick does: read the output again, and draw. */
		const grow = async (count: number) => {
			rows.count = count;
			await browser.refresh();
			panel.draw(browser);
			return frame();
		};
		return { panel, grow, frame };
	}

	it('follows the end while the person has not scrolled', async () => {
		const { grow, frame } = await growing();
		expect(await frame()).toContain('row 80');
		expect(await grow(100)).toContain('row 100');
	});

	it('stays where the person scrolled up', async () => {
		const { panel, grow, frame } = await growing();
		await frame();
		panel.scrollBy(-1000);
		expect(await frame()).toMatch(/row 1\s/);
		const grown = await grow(100);
		expect(grown).toMatch(/row 1\s/);
		expect(grown).not.toContain('row 100');
		panel.scrollBy(1000);
		await frame();
		expect(await grow(120)).toContain('row 120');
	});
});

describe('both panels', () => {
	it('give the keys the same page size, scrolling, and clipboard reach', async () => {
		const { setup, place } = await mount();
		const files = new FilesPanel(setup.renderer);
		const list = new ProcessesPanel(setup.renderer);
		place(files, 'files');
		place(list, 'processes');
		for (const panel of [files, list]) {
			expect(panel.page).toBeGreaterThanOrEqual(4);
			expect(() => panel.scrollBy(1)).not.toThrow();
			expect(typeof panel.copy('text')).toBe('boolean');
		}
	});
});

describe('the frames of the panels', () => {
	async function files(width: number, height: number) {
		const { setup, place, frame } = await mount(width, height);
		const host = new FakeHost();
		host.fileList = [...host.fileList, { path: '/shared/plan.txt', size: 400 }];
		const browser = new FileBrowser(
			async (path) => ({ path, text: lines(60, `line of ${path}`), truncated: false }),
			() => {},
		);
		const panel = new FilesPanel(setup.renderer);
		const dock = place(panel, 'files');
		browser.show(host.fileList, '/shared/plan.txt');
		await wait(30);
		panel.draw(browser);
		return { browser, panel, dock, frame };
	}

	async function processList(width: number, height: number) {
		freezeClock();
		const { setup, place, frame } = await mount(width, height);
		const host = processes();
		host.processOutput = async (handle: string) => ({
			handle,
			text: lines(60, `output of ${handle}`),
			size: 900,
			truncated: false,
		});
		const browser = new ProcessBrowser(host, () => {});
		cleanups.unshift(() => browser.dispose());
		const panel = new ProcessesPanel(setup.renderer);
		place(panel, 'processes');
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

	it('draws the files panel as an overlay', async () => {
		const { browser, panel, dock, frame } = await files(100, 30);
		dock.layout({ visible: true, overlay: 80, keyed: true });
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
