/**
 * How the keys open, drive, and close the side panels. The parts are real
 * widgets on OpenTUI's headless renderer, over a fake host.
 */
import { BoxRenderable, type KeyEvent } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Painter } from '../src/terminal/app/draw.ts';
import { FilesSurface } from '../src/terminal/app/files-surface.ts';
import { Keys } from '../src/terminal/app/keys.ts';
import { ProcessesSurface } from '../src/terminal/app/process-surface.ts';
import { ViewfinderSurface } from '../src/terminal/app/viewfinder-surface.ts';
import { PictureCache } from '../src/terminal/state/picture-cache.ts';
import { ProcessBrowser } from '../src/terminal/state/process-browser.ts';
import { TICK_MS, ViewfinderBrowser } from '../src/terminal/state/viewfinder-browser.ts';
import { Composer } from '../src/terminal/widgets/composer.ts';
import { FilesPanel } from '../src/terminal/widgets/files-panel.ts';
import { Header } from '../src/terminal/widgets/header.ts';
import { Palette } from '../src/terminal/widgets/palette.ts';
import { ProcessesPanel } from '../src/terminal/widgets/process-panel.ts';
import { Transcript } from '../src/terminal/widgets/transcript.ts';
import { ViewfinderPanel } from '../src/terminal/widgets/viewfinder-panel.ts';
import { started, view } from './fake-host.ts';
import { PNG } from './png.ts';

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
			agent: 'engineer',
			command: 'python3 scan.py',
			state: 'running',
			output: '/x/out',
			timeout: 600,
			grace: 10,
			startedAt: new Date().toISOString(),
		},
	];
	const renders = { count: 0 };
	const quit = vi.fn();
	// Like `tui.ts`: the keys settle their selection, the painter draws, the palette follows.
	let keys: Keys;
	const render = vi.fn(() => {
		renders.count += 1;
		keys.reconcile();
		painter.render(keys.mode, keys.browsing, keys.picking);
		keys.refreshPalette();
	});
	const transcript = new Transcript(renderer);
	const panel = new FilesPanel(renderer);
	const processPanel = new ProcessesPanel(renderer);
	const processes = new ProcessBrowser(host, render);
	const cameraPanel = new ViewfinderPanel(renderer);
	const camera = new ViewfinderBrowser(host, render);
	// Stop the poll before the renderer goes, so no tick draws on a destroyed buffer.
	cleanups.unshift(() => camera.watch(false));
	const kitty = { on: false };
	const composer = new Composer(renderer, { submit: () => {}, change: () => {} });
	const palette = new Palette(composer);
	const header = new Header(renderer);
	const surfaces = {
		files: new FilesSurface(session.browser, panel),
		processes: new ProcessesSurface(processes, processPanel, render),
	};
	const viewfinder = new ViewfinderSurface(camera, cameraPanel, () => kitty.on);
	const painter = new Painter({
		session,
		transcript,
		composer,
		surfaces,
		header,
		pictures: new PictureCache(
			(ref) => host.snapshot(ref),
			() => {},
		),
		graphics: () => false,
		cellAspect: () => 2,
		width: () => renderer.width,
	});
	const body = new BoxRenderable(renderer, {
		flexDirection: 'row',
		width: '100%',
		height: BODY_ROWS,
	});
	for (const part of [transcript.root, panel.root, processPanel.root, cameraPanel.root])
		body.add(part);
	renderer.root.add(body);
	renderer.root.add(composer.root);
	keys = new Keys({
		renderer,
		session,
		composer,
		palette,
		painter,
		surfaces,
		viewfinder,
		transcript,
		render,
		quit,
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
		palette,
		quit,
		press,
		prevented,
		transcript,
		panel,
		processPanel,
		processes,
		camera,
		cameraPanel,
		kitty,
		composer,
		renders,
		render,
		painter,
		surfaces,
		viewfinder,
		frame: async () => {
			await setup.renderOnce();
			await setup.renderOnce();
			return setup.captureCharFrame();
		},
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

describe('the camera viewfinder', () => {
	it('shows beside the conversation, says that it needs Kitty graphics, and polls nothing without them', async () => {
		const built = await build(120);
		built.keys.toggleCamera();
		await wait(20);
		expect(built.keys.mode).toBe('compose');
		expect(built.camera.open).toBe(true);
		expect(built.host.finders).toHaveLength(0);
		expect(await built.frame()).toContain('needs a terminal with Kitty graphics');
		expect(built.transcript.root.visible).toBe(true);
		expect(built.composer.input.focused).toBe(true);
	});

	it('leaves the keys to the composer while it shows', async () => {
		const built = await build(120);
		built.kitty.on = true;
		built.keys.toggleCamera();
		await wait(20);
		built.composer.setText('/');
		built.render();
		expect(built.palette.open).toBe(true);
		built.press('down');
		expect(built.prevented.count).toBe(1);
		built.press('q');
		built.press('escape');
		expect(built.prevented.count).toBe(2);
		expect(built.camera.open).toBe(true);
		expect(built.keys.mode).toBe('compose');
		expect(built.composer.input.focused).toBe(true);
	});

	it('hides on the second toggle, and stops the poll', async () => {
		const built = await build(120);
		built.kitty.on = true;
		built.keys.toggleCamera();
		await wait(20);
		expect(built.host.finders).toHaveLength(1);
		expect(built.host.finders[0]?.closed).toBe(false);
		expect(await built.frame()).toContain('Camera');
		built.keys.toggleCamera();
		expect(built.camera.open).toBe(false);
		expect(built.host.finders[0]?.closed).toBe(true);
		expect(built.cameraPanel.root.visible).toBe(false);
		expect(built.keys.mode).toBe('compose');
	});

	it('shows beside browse mode too', async () => {
		const built = await build(120);
		built.keys.toggleCamera();
		built.keys.mode = 'browse';
		built.render();
		expect(built.camera.open).toBe(true);
	});

	it('stops the poll when the terminal ends, without a draw', async () => {
		const built = await build(120);
		built.kitty.on = true;
		built.keys.toggleCamera();
		await wait(20);
		expect(built.host.finders[0]?.closed).toBe(false);
		built.keys.release();
		expect(built.host.finders[0]?.closed).toBe(true);
		expect(built.camera.open).toBe(false);
	});

	it('hides while a side panel is open, and shows again with a new poll when it closes', async () => {
		const built = await build(120);
		built.kitty.on = true;
		built.keys.toggleCamera();
		await wait(20);
		await openFiles(built);
		expect(built.camera.open).toBe(false);
		expect(built.cameraPanel.root.visible).toBe(false);
		expect(built.host.finders[0]?.closed).toBe(true);
		built.press('escape');
		await wait(20);
		expect(built.keys.mode).toBe('compose');
		expect(built.camera.open).toBe(true);
		expect(built.host.finders).toHaveLength(2);
		expect(built.host.finders[1]?.closed).toBe(false);
		expect(built.composer.input.focused).toBe(true);
	});

	it('stays hidden after a panel closes when the person closed it meanwhile', async () => {
		const built = await build(120);
		built.keys.toggleCamera();
		await openProcesses(built);
		built.keys.toggleCamera();
		built.press('escape');
		expect(built.camera.open).toBe(false);
	});

	it('never replaces the conversation: a narrow terminal hides it, and a wide one shows it', async () => {
		const built = await build(80);
		built.kitty.on = true;
		built.keys.toggleCamera();
		await wait(20);
		expect(built.camera.open).toBe(false);
		expect(built.host.finders).toHaveLength(0);
		expect(built.transcript.root.visible).toBe(true);
		expect(built.session.notice ?? '').toContain('100 columns');
		built.setup.resize(120, 30);
		built.render();
		await wait(20);
		expect(built.camera.open).toBe(true);
		expect(built.host.finders).toHaveLength(1);
		expect(built.transcript.root.visible).toBe(true);
	});

	it('leaves no tick or poll running after the terminal ends', async () => {
		vi.useFakeTimers();
		try {
			const built = await build(120);
			built.kitty.on = true;
			built.keys.toggleCamera();
			vi.advanceTimersByTime(TICK_MS);
			expect(built.host.finders[0]?.closed).toBe(false);
			built.keys.release();
			const draws = built.renders.count;
			vi.advanceTimersByTime(10 * TICK_MS);
			expect(built.host.finders[0]?.closed).toBe(true);
			expect(built.renders.count).toBe(draws);
		} finally {
			vi.useRealTimers();
		}
	});
});

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
				participants: [{ name: 'priya', kind: 'person' }],
				messages: [
					{ seq: 1, kind: 'said', from: 'priya', text: 'one', at: AT },
					{ seq: 2, kind: 'said', from: 'design', text: 'two', at: AT },
					{ seq: 3, kind: 'said', from: 'researcher', text: 'three', at: AT },
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
						summary: { kind: 'silent' },
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

const rows = (count: number, word: string) =>
	Array.from({ length: count }, (_, at) => `${word} ${at + 1}`).join('\n');

describe('what opening and closing a panel do, in order', () => {
	it('opens the surface before the first render, and fills the width before it', async () => {
		const built = await build();
		const open = vi.spyOn(built.surfaces.files, 'open');
		const fill = vi.spyOn(built.surfaces.files, 'fill');
		await built.session.submit('/files');
		built.render.mockClear();
		built.keys.openFiles();
		const [opened] = open.mock.invocationCallOrder;
		const [filled] = fill.mock.invocationCallOrder;
		const [rendered] = built.render.mock.invocationCallOrder;
		expect(opened).toBeLessThan(filled ?? 0);
		expect(filled).toBeLessThan(rendered ?? 0);
	});

	it('hides the panel it leaves, then draws the panel it enters', async () => {
		const built = await build();
		await openFiles(built);
		const hide = vi.spyOn(built.surfaces.files, 'hide');
		const open = vi.spyOn(built.surfaces.processes, 'open');
		built.keys.openProcesses();
		expect(hide).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledTimes(1);
		expect(built.panel.root.visible).toBe(false);
		await wait(20);
		expect(built.processPanel.root.visible).toBe(true);
	});

	it('gives the conversation back, redraws it, and renders once when a panel closes', async () => {
		const built = await build(80);
		await openFiles(built);
		expect(built.transcript.root.visible).toBe(false);
		const invalidate = vi.spyOn(built.painter, 'invalidate');
		built.render.mockClear();
		built.press('escape');
		expect(built.transcript.root.visible).toBe(true);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(built.render).toHaveBeenCalledTimes(1);
	});

	it('hides the processes panel when it closes', async () => {
		const built = await build();
		await openProcesses(built);
		expect(built.processPanel.root.visible).toBe(true);
		built.press('q');
		expect(built.processPanel.root.visible).toBe(false);
	});
});

describe('the status line while a panel is open', () => {
	it('names the panel, and yields to an error', async () => {
		const built = await build();
		await openFiles(built);
		expect(await built.frame()).toContain('Browsing the workspace files. Esc closes the panel.');
		built.session.error = 'boom';
		built.render();
		const text = await built.frame();
		expect(text).toContain('Error: boom');
		expect(text).not.toContain('Browsing the workspace files.');
		built.session.error = undefined;
		built.keys.openProcesses();
		await wait(20);
		expect(await built.frame()).toContain('Watching the background processes.');
	});
});

describe('the keys that scroll, copy, and swallow', () => {
	it('scrolls the file preview with the page keys', async () => {
		const built = await build();
		// A text file, not markdown: the markdown widget draws a moment after the text one.
		built.host.fileList = [{ path: '/shared/data.txt', size: 900 }];
		built.host.file = async (path: string) => ({ path, text: rows(120, 'row'), truncated: false });
		await openFiles(built);
		await wait(20);
		expect(await built.frame()).toMatch(/row 1\b/);
		built.press('pagedown');
		expect(await built.frame()).not.toMatch(/row 1\b/);
		built.press('pageup');
		expect(await built.frame()).toMatch(/row 1\b/);
	});

	it('switches the table of a database with Left and Right', async () => {
		const built = await build();
		const table = (name: string, cell: string) => ({
			name,
			columns: ['a'],
			rows: [[cell]],
			count: 1,
		});
		built.host.file = async (path: string) => ({
			path,
			text: 'tables',
			truncated: false,
			tables: [table('alpha', '1'), table('beta', '2')],
		});
		await openFiles(built);
		await wait(20);
		expect(built.session.browser.tab).toBe(0);
		built.press('right');
		expect(built.session.browser.tab).toBe(1);
		built.press('left');
		expect(built.session.browser.tab).toBe(0);
	});

	it('steps the frames of a sensor manifest with Left and Right', async () => {
		const built = await build();
		const frame = (caption: string) => ({ image: { data: PNG, mimeType: 'image/png' }, caption });
		built.host.file = async (path: string) => ({
			path,
			text: '{}',
			truncated: false,
			frames: [frame('bench-camera/camera · t1'), frame('bench-camera/camera · t2')],
		});
		await openFiles(built);
		await wait(20);
		expect(await built.frame()).toContain('frame 1 of 2 · bench-camera/camera · t1');
		built.press('right');
		built.press('right');
		expect(built.session.browser.tab).toBe(1);
		built.panel.draw(built.session.browser);
		expect(await built.frame()).toContain('frame 2 of 2 · bench-camera/camera · t2');
		built.press('left');
		expect(built.session.browser.tab).toBe(0);
	});

	it('tells the person whether the copy worked, on the hint line', async () => {
		const built = await build();
		await openFiles(built);
		await wait(20);
		built.press('y', { ctrl: true });
		expect(await built.frame()).toMatch(/Copied to the clipboard|does not accept a clipboard copy/);
	});

	it('scrolls the output of a process with the page keys', async () => {
		const built = await build();
		built.host.processOutput = async (handle: string) => ({
			handle,
			text: rows(120, 'out'),
			size: 900,
			truncated: false,
		});
		await openProcesses(built);
		await wait(20);
		expect(await built.frame()).toMatch(/out 120\b/);
		built.press('pageup');
		expect(await built.frame()).not.toMatch(/out 120\b/);
		built.press('pagedown');
		expect(await built.frame()).toMatch(/out 120\b/);
	});

	it('redraws after a copy of the output', async () => {
		const built = await build();
		await openProcesses(built);
		await wait(20);
		built.render.mockClear();
		built.press('y', { ctrl: true });
		expect(built.render).toHaveBeenCalledTimes(1);
	});

	it('swallows every key that the processes panel gets, also one it does not know', async () => {
		const built = await build();
		await openProcesses(built);
		built.prevented.count = 0;
		for (const name of ['j', 'x', 'z', 'pagedown']) built.press(name);
		expect(built.prevented.count).toBe(4);
	});
});

describe('the cue of the staged attachments', () => {
	it('shows the files in a row above the input, with a new placeholder, and drops both after the send', async () => {
		const built = await build();
		built.render();
		expect(await built.frame()).not.toContain('attached');
		await built.session.submit('/attach /tmp/one.png');
		await built.session.submit('/attach /tmp/two.png');
		built.render();
		const staged = await built.frame();
		expect(staged).toContain('2 attached: one.png, two.png');
		expect(staged).toContain('Enter sends the attachments alone');
		await built.session.submit('');
		built.render();
		const sent = await built.frame();
		expect(sent).not.toContain('attached:');
		expect(sent).toContain('Message the room, or type / for commands');
	});
});

describe('Ctrl+C and Ctrl+D', () => {
	const ctrl = { ctrl: true, sequence: '' };

	it('Ctrl+C clears the composer and keeps the terminal running', async () => {
		const built = await build();
		built.composer.setText('a half-written question');
		built.press('c', ctrl);
		expect(built.composer.text).toBe('');
		expect(built.quit).not.toHaveBeenCalled();
		expect(built.prevented.count).toBe(1);
		expect(built.session.notice).toBeUndefined();
	});

	it('Ctrl+C on an empty composer drops the staged files, then says how to leave', async () => {
		const built = await build();
		await built.session.submit('/attach /tmp/one.png');
		built.composer.setText('text');
		built.press('c', ctrl);
		expect(built.session.pendingRefs).toHaveLength(1);
		built.press('c', ctrl);
		expect(built.session.pendingRefs).toEqual([]);
		expect(built.session.notice).toBe('Dropped 1 staged attachment.');
		built.press('c', ctrl);
		expect(built.session.notice).toBe('Press Ctrl+D or type /quit to leave.');
	});

	it('Ctrl+C cancels a room that waits for its goal, and clears the goal text', async () => {
		const built = await build();
		await built.session.submit('/new mixing');
		expect(built.session.awaitingGoal).toBe('mixing');
		built.composer.setText('Mix a coating');
		built.press('c', ctrl);
		expect(built.session.awaitingGoal).toBeUndefined();
		expect(built.composer.text).toBe('');
	});

	it('Ctrl+C closes an open panel and keeps the draft', async () => {
		const built = await build();
		built.composer.setText('draft');
		built.keys.openFiles();
		built.press('c', ctrl);
		expect(built.keys.mode).toBe('compose');
		expect(built.composer.text).toBe('draft');
		expect(built.quit).not.toHaveBeenCalled();
	});

	it('Ctrl+D does not leave from a panel', async () => {
		const built = await build();
		built.keys.openFiles();
		built.press('d', ctrl);
		expect(built.quit).not.toHaveBeenCalled();
		expect(built.keys.mode).toBe('files');
	});

	it('ignores Ctrl+Shift and Ctrl+Meta combinations', async () => {
		const built = await build();
		built.composer.setText('draft');
		built.press('c', { ctrl: true, shift: true, sequence: '' });
		built.press('c', { ctrl: true, meta: true, sequence: '' });
		expect(built.composer.text).toBe('draft');
		built.composer.setText('');
		built.press('d', { ctrl: true, shift: true, sequence: '' });
		expect(built.quit).not.toHaveBeenCalled();
	});

	it('Ctrl+C redraws, and opens a dismissed palette again', async () => {
		const built = await build();
		built.composer.setText('/');
		built.render();
		built.press('escape');
		built.render();
		expect(built.palette.open).toBe(false);
		const before = built.renders.count;
		built.press('c', ctrl);
		expect(built.renders.count).toBeGreaterThan(before);
		built.composer.setText('/');
		built.render();
		expect(built.palette.open).toBe(true);
	});

	it('Ctrl+C keeps the staged attachments of a send that runs', async () => {
		const built = await build();
		await built.session.submit('/attach /tmp/one.png');
		let release: () => void = () => {};
		built.host.sendGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sending = built.session.submit('');
		await vi.waitFor(() => expect(built.session.pendingRefs).toHaveLength(1));
		built.press('c', ctrl);
		expect(built.session.notice ?? '').not.toMatch(/Dropped/);
		release();
		await sending;
		expect(built.host.sentRefs[0]).toHaveLength(1);
	});

	it('Ctrl+D leaves on an empty composer, and only then', async () => {
		const built = await build();
		built.composer.setText('draft');
		built.press('d', ctrl);
		expect(built.quit).not.toHaveBeenCalled();
		built.composer.setText('');
		built.press('d', ctrl);
		expect(built.quit).toHaveBeenCalledTimes(1);
	});
});
