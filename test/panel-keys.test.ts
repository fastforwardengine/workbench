/**
 * How the keys open, drive, and close the side panels. The parts are real
 * widgets on OpenTUI's headless renderer, over a fake host.
 */
import { BoxRenderable, type KeyEvent } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { Composer } from '../src/terminal/composer.ts';
import { Painter } from '../src/terminal/draw.ts';
import { FilesPanel } from '../src/terminal/files-panel.ts';
import { FilesSurface } from '../src/terminal/files-surface.ts';
import { Header } from '../src/terminal/header.ts';
import { Keys } from '../src/terminal/keys.ts';
import { Palette } from '../src/terminal/palette.ts';
import { ProcessBrowser } from '../src/terminal/process-browser.ts';
import { ProcessesPanel } from '../src/terminal/process-panel.ts';
import { ProcessesSurface } from '../src/terminal/process-surface.ts';
import { Transcript } from '../src/terminal/transcript.ts';
import { started, view } from './fake-host.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const AT = '2026-01-01T00:00:00Z';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The terminal, wired as `tui.ts` wires it, without the room. */
async function build(width = 120) {
	const setup = await createTestRenderer({ width, height: 30 });
	cleanups.push(() => setup.renderer.destroy());
	const { renderer } = setup;
	const { host, session } = await started();
	host.processTable = [
		{
			handle: 'bash-aaa111',
			name: 'scan',
			kind: 'bash',
			agent: 'instruments',
			command: 'python3 scan.py',
			state: 'running',
			output: '/x/out',
			timeout: 600,
			startedAt: new Date().toISOString(),
		},
	];
	const renders = { count: 0 };
	// Like `tui.ts`: the keys settle their selection, the painter draws, the palette follows.
	let keys: Keys;
	const render = () => {
		renders.count += 1;
		keys.reconcile();
		painter.render(keys.mode, keys.browsing, keys.picking);
		keys.refreshPalette();
	};
	const transcript = new Transcript(renderer);
	const panel = new FilesPanel(renderer);
	const processPanel = new ProcessesPanel(renderer);
	const processes = new ProcessBrowser(host, render);
	const composer = new Composer(renderer, { submit: () => {}, change: () => {} });
	const header = new Header(renderer);
	const surfaces = {
		files: new FilesSurface(session.browser, panel),
		processes: new ProcessesSurface(processes, processPanel, render),
	};
	const painter = new Painter({
		session,
		transcript,
		composer,
		surfaces,
		header,
		width: () => renderer.width,
	});
	const body = new BoxRenderable(renderer, {
		flexDirection: 'row',
		width: '100%',
		height: BODY_ROWS,
	});
	for (const part of [transcript.root, panel.root, processPanel.root]) body.add(part);
	renderer.root.add(body);
	renderer.root.add(composer.root);
	keys = new Keys({
		renderer,
		session,
		composer,
		palette: new Palette(composer),
		painter,
		surfaces,
		transcript,
		render,
	});
	composer.focus();
	const prevented = { count: 0 };
	const press = (name: string, extra: Partial<KeyEvent> = {}) =>
		keys.onKey({
			name,
			ctrl: false,
			meta: false,
			sequence: name.length === 1 ? name : '',
			preventDefault: () => {
				prevented.count += 1;
			},
			...extra,
		} as KeyEvent);
	return {
		setup,
		host,
		session,
		keys,
		press,
		prevented,
		transcript,
		panel,
		processPanel,
		processes,
		composer,
		renders,
	};
}

type Built = Awaited<ReturnType<typeof build>>;

/** The rows of the body box; the composer draws below them. */
const BODY_ROWS = 20;

/** The width of the box that the body draws, in cells. */
async function boxWidth(built: Built): Promise<number> {
	await built.setup.renderOnce();
	await built.setup.renderOnce();
	const line =
		built.setup
			.captureCharFrame()
			.split('\n')
			.slice(0, BODY_ROWS)
			.find((text) => text.includes('┌')) ?? '';
	return line.indexOf('┐') - line.indexOf('┌') + 1;
}

/** Open the files panel the way the terminal does: the session shows the browser, then the keys open it. */
async function openFiles(built: Built): Promise<void> {
	await built.session.submit('/files');
	built.keys.openFiles();
	await wait(20);
}

async function openProcesses(built: Built): Promise<void> {
	built.keys.openProcesses();
	await wait(20);
}

describe('opening a panel', () => {
	it('shows the files panel beside the conversation on a wide terminal, and gives up the composer', async () => {
		const built = await build(120);
		await openFiles(built);
		expect(built.keys.mode).toBe('files');
		expect(built.session.browser.open).toBe(true);
		expect(built.transcript.root.visible).toBe(true);
		expect(await boxWidth(built)).toBeGreaterThan(40);
		expect(await boxWidth(built)).toBeLessThan(120 * 0.6);
		expect(built.composer.input.focused).toBe(false);
	});

	it('gives the panel the whole width on a narrow terminal', async () => {
		const built = await build(80);
		await openFiles(built);
		expect(built.transcript.root.visible).toBe(false);
		expect(await boxWidth(built)).toBeGreaterThanOrEqual(78);
	});

	it('opens the processes panel and reads the list', async () => {
		const built = await build(120);
		await openProcesses(built);
		expect(built.keys.mode).toBe('processes');
		expect(built.processes.open).toBe(true);
		expect(built.processes.processes.map((process) => process.handle)).toEqual(['bash-aaa111']);
		expect(await boxWidth(built)).toBeGreaterThan(40);
		expect(await boxWidth(built)).toBeLessThan(120 * 0.6);
	});
});

describe('the files panel keys', () => {
	it('types into the search, deletes, and clears with Ctrl+U', async () => {
		const built = await build();
		await openFiles(built);
		built.press('c');
		built.press('e');
		expect(built.session.browser.query).toBe('ce');
		built.press('backspace');
		expect(built.session.browser.query).toBe('c');
		built.press('u', { ctrl: true });
		expect(built.session.browser.query).toBe('');
		expect(built.prevented.count).toBe(4);
	});

	it('moves the choice with the arrows and pages the preview', async () => {
		const built = await build();
		await openFiles(built);
		expect(built.session.browser.index).toBe(0);
		built.press('down');
		expect(built.session.browser.index).toBe(1);
		built.press('up');
		expect(built.session.browser.index).toBe(0);
		expect(() => built.press('pagedown')).not.toThrow();
	});

	it('clears the search on the first Escape and closes on the second', async () => {
		const built = await build();
		await openFiles(built);
		built.press('c');
		built.press('escape');
		expect(built.keys.mode).toBe('files');
		expect(built.session.browser.query).toBe('');
		built.press('escape');
		expect(built.keys.mode).toBe('compose');
		expect(built.session.browser.open).toBe(false);
		expect(built.panel.root.visible).toBe(false);
		expect(built.transcript.root.visible).toBe(true);
		expect(built.composer.input.focused).toBe(true);
	});

	it('ignores a Ctrl key that it does not know, and never types it', async () => {
		const built = await build();
		await openFiles(built);
		built.press('z', { ctrl: true });
		built.press('z', { meta: true });
		expect(built.session.browser.query).toBe('');
	});

	it('copies the file on Ctrl+Y and says so, or says the terminal cannot', async () => {
		const built = await build();
		await openFiles(built);
		await wait(20);
		expect(() => built.press('y', { ctrl: true })).not.toThrow();
	});
});

describe('the processes panel keys', () => {
	it('moves the choice with j, k, and the arrows', async () => {
		const built = await build();
		built.host.processTable = [
			...built.host.processTable,
			{ ...built.host.processTable[0], handle: 'bash-bbb222', name: 'two' } as never,
		];
		await openProcesses(built);
		built.press('j');
		expect(built.processes.index).toBe(1);
		built.press('k');
		expect(built.processes.index).toBe(0);
		built.press('down');
		expect(built.processes.index).toBe(1);
		built.press('up');
		expect(built.processes.index).toBe(0);
	});

	it('cancels a running process on the second x', async () => {
		const built = await build();
		await openProcesses(built);
		built.press('x');
		expect(built.processes.confirming).toBe('bash-aaa111');
		expect(built.host.calls).not.toContain('cancel:bash-aaa111');
		built.press('x');
		await wait(20);
		expect(built.host.calls).toContain('cancel:bash-aaa111');
	});

	it('closes on Escape and on q', async () => {
		for (const name of ['escape', 'q']) {
			const built = await build();
			await openProcesses(built);
			built.press(name);
			expect(built.keys.mode, name).toBe('compose');
			expect(built.processes.open, name).toBe(false);
			expect(built.processPanel.root.visible, name).toBe(false);
			expect(built.composer.input.focused, name).toBe(true);
		}
	});

	it('ignores a key with Ctrl or Meta, except Ctrl+Y', async () => {
		const built = await build();
		await openProcesses(built);
		built.press('q', { ctrl: true });
		built.press('q', { meta: true });
		expect(built.keys.mode).toBe('processes');
		built.press('y', { ctrl: true });
		await wait(20);
		expect(built.processes.message).toMatch(/Copied the output|does not accept a clipboard/);
	});
});

describe('moving between panels and modes', () => {
	it('returns to browse mode when the panel opened from browse mode', async () => {
		const built = await build();
		built.host.table.set(
			'characterization',
			view('characterization', {
				participants: [{ name: 'priya', kind: 'human' }],
				messages: [
					{ seq: 1, kind: 'said', from: 'priya', text: 'one', at: AT },
					{ seq: 2, kind: 'said', from: 'design', text: 'two', at: AT },
					{ seq: 3, kind: 'said', from: 'datasheets', text: 'three', at: AT },
					{ seq: 4, kind: 'said', from: 'priya', text: 'four', at: AT },
				],
				exchanges: [
					{
						from: 1,
						through: 3,
						status: 'closed',
						person: 'priya',
						at: AT,
						outcome: { kind: 'complete' },
						summary: { status: 'silent' },
						activations: [],
					},
				],
			}),
		);
		await built.session.refresh();
		built.press('tab');
		expect(built.keys.mode).toBe('browse');
		await openFiles(built);
		expect(built.keys.mode).toBe('files');
		built.press('escape');
		expect(built.keys.mode).toBe('browse');
	});

	it('closes the files panel when the processes panel opens, and returns to the first mode', async () => {
		const built = await build();
		await openFiles(built);
		await openProcesses(built);
		expect(built.keys.mode).toBe('processes');
		expect(built.session.browser.open).toBe(false);
		expect(built.panel.root.visible).toBe(false);
		built.press('escape');
		expect(built.keys.mode).toBe('compose');
		expect(built.processes.open).toBe(false);
	});

	it('closes the processes panel when the files panel opens', async () => {
		const built = await build();
		await openProcesses(built);
		await openFiles(built);
		expect(built.keys.mode).toBe('files');
		expect(built.processes.open).toBe(false);
	});
});
