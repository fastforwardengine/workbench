/**
 * How the keys open, drive, and close the layers of the dock. The parts are real
 * widgets on OpenTUI's headless renderer, over a fake host.
 */
import { BoxRenderable, getTreeSitterClient, type KeyEvent } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LOST, NO_CAMERA } from '../src/host/viewfinder.ts';
import { Dock } from '../src/terminal/app/dock.ts';
import { Painter } from '../src/terminal/app/draw.ts';
import { FilesSurface } from '../src/terminal/app/files-surface.ts';
import { Keys } from '../src/terminal/app/keys.ts';
import { KeysSurface } from '../src/terminal/app/keys-surface.ts';
import { ProcessesSurface } from '../src/terminal/app/process-surface.ts';
import { ViewfinderSurface } from '../src/terminal/app/viewfinder-surface.ts';
import { PictureCache } from '../src/terminal/state/picture-cache.ts';
import { ProcessBrowser } from '../src/terminal/state/process-browser.ts';
import { TICK_MS, ViewfinderBrowser } from '../src/terminal/state/viewfinder-browser.ts';
import { Voice } from '../src/terminal/state/voice.ts';
import { Composer } from '../src/terminal/widgets/composer.ts';
import { DockPanel } from '../src/terminal/widgets/dock.ts';
import { FilesPanel } from '../src/terminal/widgets/files-panel.ts';
import { Header } from '../src/terminal/widgets/header.ts';
import { KeysPanel } from '../src/terminal/widgets/keys-panel.ts';
import { Palette } from '../src/terminal/widgets/palette.ts';
import { ProcessesPanel } from '../src/terminal/widgets/process-panel.ts';
import { Transcript } from '../src/terminal/widgets/transcript.ts';
import { ViewfinderPanel } from '../src/terminal/widgets/viewfinder-panel.ts';
import { started, view } from './fake-host.ts';
import { PNG } from './png.ts';
import { fakeTake, quietParts, quietVoice } from './voice-fakes.ts';

const cleanups: (() => void)[] = [];
/** The first highlight in a process starts the worker. Start it once, before a frame shows a message. */
beforeAll(async () => {
	await getTreeSitterClient().highlightOnce('# x', 'markdown');
}, 30_000);

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const AT = '2026-01-01T00:00:00Z';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The terminal, wired as `tui.ts` wires it, without the room. */
async function build(width = 120, voice = quietVoice()) {
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
			port: 20001,
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
		painter.render(keys.mode, keys.picking);
		keys.refreshPalette();
	});
	const transcript = new Transcript(renderer);
	const panel = new FilesPanel(renderer);
	const processPanel = new ProcessesPanel(renderer);
	const processes = new ProcessBrowser(host, render);
	const cameraPanel = new ViewfinderPanel(renderer);
	const keysPanel = new KeysPanel(renderer);
	const camera = new ViewfinderBrowser(
		host,
		{
			room: () => session.room,
			person: () => session.identity?.name,
			stopped: () => session.view?.status !== 'running',
		},
		render,
	);
	// Stop the poll before the renderer goes, so no tick draws on a destroyed buffer.
	cleanups.unshift(() => camera.watch(false));
	const kitty = { on: false };
	const composer = new Composer(renderer, { submit: () => {}, change: () => {} });
	const palette = new Palette(composer);
	const header = new Header(renderer);
	const viewfinder = new ViewfinderSurface(camera, cameraPanel, () => kitty.on);
	const surfaces = {
		files: new FilesSurface(session.browser, panel),
		processes: new ProcessesSurface(processes, processPanel, render),
		keys: new KeysSurface(keysPanel),
		camera: viewfinder,
	};
	const dockPanel = new DockPanel(renderer);
	const dock = new Dock({ surfaces, panel: dockPanel, width: () => renderer.width });
	const painter = new Painter({
		session,
		transcript,
		composer,
		dock,
		header,
		voice,
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
	for (const layer of Object.values(surfaces)) dockPanel.add(layer.root);
	body.add(transcript.root);
	body.add(dockPanel.root);
	renderer.root.add(body);
	renderer.root.add(composer.root);
	keys = new Keys({
		renderer,
		session,
		composer,
		palette,
		painter,
		dock,
		viewfinder,
		transcript,
		voice,
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
		voice,
		surfaces,
		dock,
		dockPanel,
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

/** The width of the dock after a draw, in cells. */
async function dockWidth(built: Built): Promise<number> {
	await built.frame();
	return built.dockPanel.root.width;
}

/** Characters that draw the box of a panel. A dock draws only the line at its edge. */
const BOX = /[┌┐└┘─┬┴├┤┼]/;

/** Open the files layer the way the terminal does: the session shows the browser, then the keys open it. */
async function openFiles(built: Built): Promise<void> {
	await built.session.submit('/files');
	built.keys.openFiles();
	await wait(20);
}

async function openProcesses(built: Built): Promise<void> {
	built.keys.openProcesses();
	await wait(20);
}

describe('the camera layer', () => {
	it('shows beside the conversation, says that it needs Kitty graphics, and polls nothing without them', async () => {
		const built = await build(120);
		built.keys.toggleCamera();
		await wait(20);
		expect(built.keys.mode).toBe('compose');
		expect(built.camera.open).toBe(true);
		expect(built.host.finders).toHaveLength(0);
		expect(await built.frame()).toContain('needs a terminal with Kitty');
		expect(built.transcript.root.visible).toBe(true);
		expect(built.composer.input.focused).toBe(true);
	});

	it('takes the share of the terminal width that the dock has', async () => {
		const built = await build(180);
		built.keys.toggleCamera();
		await wait(20);
		expect(Math.abs((await dockWidth(built)) - 90)).toBeLessThanOrEqual(1);
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
		expect(await built.frame()).toContain('camera');
		built.keys.toggleCamera();
		expect(built.camera.open).toBe(false);
		expect(built.host.finders[0]?.closed).toBe(true);
		expect(built.cameraPanel.root.visible).toBe(false);
		expect(built.dockPanel.root.visible).toBe(false);
		expect(built.keys.mode).toBe('compose');
	});

	it('follows the room that the terminal opens', async () => {
		const built = await build(120);
		built.kitty.on = true;
		built.keys.toggleCamera();
		await wait(20);
		expect(built.host.finders.map((finder) => finder.room)).toEqual([built.session.room]);
	});

	it('says that no camera is shown, and asks for the Engineer', async () => {
		const built = await build(120);
		built.kitty.on = true;
		built.keys.toggleCamera();
		await wait(20);
		const finder = built.host.finders[0];
		if (!finder) throw new Error('No viewfinder.');
		finder.state = { cameras: [], note: NO_CAMERA };
		finder.changed();
		expect(await built.frame()).toContain('No camera is shown');
	});

	it('draws one labelled box for each camera, stacked, with its age and its note', async () => {
		const built = await build(180);
		built.kitty.on = true;
		built.keys.toggleCamera();
		await wait(20);
		const finder = built.host.finders[0];
		if (!finder) throw new Error('No viewfinder.');
		finder.state = {
			cameras: [
				{
					name: 'bench',
					title: 'Bench camera',
					handle: undefined,
					frame: undefined,
					note: LOST,
				},
				{
					name: 'shelf',
					title: undefined,
					handle: 'bash-a',
					frame: { at: AT, digest: 'd1', png: PNG, received: Date.now() },
					note: undefined,
				},
			],
			note: undefined,
		};
		finder.changed();
		const rows = (await built.frame()).split('\n');
		const rowOf = (text: string) => rows.findIndex((row) => row.includes(text));
		expect(rowOf('Bench camera')).toBeGreaterThan(-1);
		expect(rowOf('shelf')).toBeGreaterThan(rowOf('Bench camera'));
		expect(rows.join('\n')).toContain('0 s ago');
		expect(rows.join('\n')).toContain('The camera process ended');
	});

	/** Open the viewfinder with one camera that holds the look action. */
	async function withLook(width = 120) {
		const built = await build(width);
		built.kitty.on = true;
		built.keys.toggleCamera();
		await wait(20);
		const finder = built.host.finders[0];
		if (!finder) throw new Error('No viewfinder.');
		finder.state = {
			cameras: [
				{
					name: 'bench',
					title: 'Bench camera',
					handle: 'bash-a',
					frame: undefined,
					note: undefined,
				},
			],
			note: undefined,
		};
		built.host.actionTable = [
			{
				room: built.session.room,
				name: 'bench',
				revision: 'r1',
				rev: 1,
				actions: [{ id: 'look', label: 'Look now' }],
			},
		];
		finder.changed();
		return built;
	}

	it('draws the Look now button under its camera box', async () => {
		const built = await withLook();
		const rows = (await built.frame()).split('\n');
		const box = rows.findIndex((row) => row.includes('Bench camera'));
		const button = rows.findIndex((row) => row.includes('[ Look now ]'));
		expect(box).toBeGreaterThan(-1);
		expect(button).toBeGreaterThan(box);
	});

	it('chooses and presses the button with Ctrl+L, Enter, and Esc, and sends one act as the person', async () => {
		const built = await withLook();
		built.press('l', { ctrl: true });
		expect(built.keys.mode).toBe('actions');
		expect(built.composer.input.focused).toBe(false);
		expect(await built.frame()).toContain('▸ [ Look now ]');
		built.press('return');
		await vi.waitFor(() => expect(built.host.acts).toHaveLength(1));
		expect(built.host.acts[0]).toMatchObject({
			person: 'priya',
			act: { room: built.session.room, widget: 'bench', revision: 'r1', action: 'look' },
		});
		await vi.waitFor(async () => expect(await built.frame()).toContain('Sent as #7.'));
		built.press('escape');
		expect(built.keys.mode).toBe('compose');
		expect(built.composer.input.focused).toBe(true);
	});

	it('enters the buttons from the dock with Ctrl+L, while the camera is on top', async () => {
		const built = await withLook();
		built.press('o', { ctrl: true, sequence: '' });
		expect(built.keys.mode).toBe('dock');
		built.press('l', { ctrl: true });
		expect(built.keys.mode).toBe('actions');
		expect(built.composer.input.focused).toBe(false);
		expect(await built.frame()).toContain('▸ [ Look now ]');
		built.press('escape');
		expect(built.keys.mode).toBe('compose');
		expect(built.composer.input.focused).toBe(true);
	});

	it('leaves the buttons with Ctrl+C, and the composer takes the keys back', async () => {
		const built = await withLook();
		built.press('l', { ctrl: true });
		built.press('c', { ctrl: true });
		expect(built.keys.mode).toBe('compose');
		expect(built.composer.input.focused).toBe(true);
	});

	it('says so when the viewfinder is closed or no camera has an action', async () => {
		const closed = await build(120);
		closed.press('l', { ctrl: true });
		expect(closed.keys.mode).toBe('compose');
		expect(closed.session.notice).toContain('camera layer is not on top');
		const bare = await build(120);
		bare.kitty.on = true;
		bare.keys.toggleCamera();
		await wait(20);
		bare.press('l', { ctrl: true });
		expect(bare.keys.mode).toBe('compose');
		expect(bare.session.notice).toContain('No shown camera has an action');
	});

	it('leaves the buttons when another layer opens on top of the camera', async () => {
		const built = await withLook();
		built.press('l', { ctrl: true });
		await openFiles(built);
		expect(built.keys.mode).toBe('dock');
		expect(built.camera.open).toBe(false);
		built.press('escape');
		await wait(20);
		expect(built.keys.mode).toBe('compose');
		expect(built.composer.input.focused).toBe(true);
	});

	it('says so when the camera is under another layer, and asks the camera again once it is on top', async () => {
		const built = await withLook();
		await openFiles(built);
		built.press('escape');
		built.press('l', { ctrl: true });
		expect(built.keys.mode).toBe('compose');
		expect(built.session.notice).toContain('camera layer is not on top');
		built.keys.toggleCamera();
		await wait(20);
		expect(built.dock.shown).toBe('camera');
		built.press('l', { ctrl: true });
		expect(built.session.notice).toContain('No shown camera has an action');
	});

	it('leaves the buttons by itself when the camera loses its action', async () => {
		const built = await withLook();
		built.press('l', { ctrl: true });
		built.host.actionTable = [];
		built.host.finders[0]?.changed();
		await wait(20);
		expect(built.keys.mode).toBe('compose');
		expect(built.composer.input.focused).toBe(true);
	});

	it('shows the button blocked while the room is stopped, and sends nothing', async () => {
		const built = await withLook();
		const open = built.host.table.get(built.session.room);
		if (open) built.host.table.set(open.name, { ...open, status: 'stopped' });
		await built.session.refresh();
		built.press('l', { ctrl: true });
		built.press('return');
		await wait(20);
		expect(await built.frame()).toContain('room stopped');
		expect(built.host.acts).toHaveLength(0);
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

	it('hides while another layer is on top, and shows again with a new poll when that layer closes', async () => {
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
		expect(built.camera.open).toBe(false);
		built.press('o', { ctrl: true });
		built.press('c', { ctrl: true });
		await wait(20);
		// The camera comes back on top, and it leaves the keys with the composer.
		expect(built.keys.mode).toBe('compose');
		expect(built.camera.open).toBe(true);
		expect(built.host.finders).toHaveLength(2);
		expect(built.host.finders[1]?.closed).toBe(false);
		expect(built.composer.input.focused).toBe(true);
	});

	it('comes back on top with the camera command, and closes with the next one', async () => {
		const built = await build(120);
		built.keys.toggleCamera();
		await openProcesses(built);
		built.press('escape');
		built.keys.toggleCamera();
		expect(built.camera.open).toBe(true);
		expect(built.processes.open).toBe(false);
		built.keys.toggleCamera();
		expect(built.camera.open).toBe(false);
		expect(built.processes.open).toBe(true);
	});

	it('does not show in a narrow terminal, and says so', async () => {
		const built = await build(80);
		built.kitty.on = true;
		built.keys.toggleCamera();
		await wait(20);
		expect(built.camera.open).toBe(false);
		expect(built.host.finders).toHaveLength(0);
		expect(built.transcript.root.visible).toBe(true);
		expect(built.session.notice ?? '').toContain('100 columns');
		built.setup.resize(120, 30);
		built.keys.toggleCamera();
		await wait(20);
		expect(built.camera.open).toBe(true);
		expect(built.host.finders).toHaveLength(1);
		expect(built.transcript.root.visible).toBe(true);
	});

	it('says the width on Ctrl+O when the terminal is narrow and the camera is the only layer', async () => {
		const built = await build(120);
		built.kitty.on = true;
		built.keys.toggleCamera();
		await wait(20);
		built.setup.resize(80, 30);
		built.render();
		built.press('o', { ctrl: true, sequence: '' });
		expect(built.keys.mode).toBe('compose');
		expect(built.session.notice ?? '').toContain('at least 100 columns wide');
		expect(built.session.notice ?? '').not.toContain('No layer is open');
	});

	it('says the width on the camera command in a narrow terminal, and leaves the open layer alone', async () => {
		const built = await build(120);
		built.kitty.on = true;
		built.keys.toggleCamera();
		await wait(20);
		built.setup.resize(80, 30);
		built.render();
		built.session.say('Cleared.');
		built.keys.toggleCamera();
		expect(built.session.notice ?? '').toContain('at least 100 columns wide');
		expect(built.dock.has('camera')).toBe(true);
		built.session.say('Cleared.');
		built.keys.toggleCamera();
		expect(built.session.notice ?? '').toContain('at least 100 columns wide');
		expect(built.dock.has('camera')).toBe(true);
		built.setup.resize(120, 30);
		built.render();
		await wait(20);
		expect(built.dock.shown).toBe('camera');
		expect(built.camera.open).toBe(true);
	});

	it('hides when the terminal becomes narrow, and shows again with a new poll when it widens', async () => {
		const built = await build(120);
		built.kitty.on = true;
		built.keys.toggleCamera();
		await wait(20);
		built.setup.resize(80, 30);
		built.render();
		expect(built.camera.open).toBe(false);
		expect(built.host.finders[0]?.closed).toBe(true);
		expect(built.transcript.root.visible).toBe(true);
		built.setup.resize(120, 30);
		built.render();
		await wait(20);
		expect(built.camera.open).toBe(true);
		expect(built.host.finders).toHaveLength(2);
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

describe('opening a layer', () => {
	it('shows the files layer beside the conversation on a wide terminal, and gives up the composer', async () => {
		const built = await build(120);
		await openFiles(built);
		expect(built.keys.mode).toBe('dock');
		expect(built.session.browser.open).toBe(true);
		expect(built.transcript.root.visible).toBe(true);
		expect(await dockWidth(built)).toBeGreaterThan(40);
		expect(await dockWidth(built)).toBeLessThan(120 * 0.6);
		expect(built.composer.input.focused).toBe(false);
	});

	it('opens the processes layer and reads the list', async () => {
		const built = await build(120);
		await openProcesses(built);
		expect(built.keys.mode).toBe('dock');
		expect(built.processes.open).toBe(true);
		expect(built.processes.processes.map((process) => process.handle)).toEqual(['bash-aaa111']);
		expect(await dockWidth(built)).toBeGreaterThan(40);
		expect(await dockWidth(built)).toBeLessThan(120 * 0.6);
	});
});

/** Put one message in the open room, so the conversation has text to show. */
async function say(built: Built, text: string): Promise<void> {
	built.host.table.set(
		built.session.room,
		view(built.session.room, {
			participants: [{ name: 'priya', kind: 'person' }],
			messages: [{ seq: 1, kind: 'said', from: 'priya', text, at: AT }],
		}),
	);
	await built.session.refresh();
	built.render();
	await wait(50);
}

/** The rows of the frame, cut to the columns that the conversation keeps beside the dock. */
const leftOf = (frame: string, column: number): string =>
	frame
		.split('\n')
		.map((row) => row.slice(0, column))
		.join('\n');

describe('the dock over the conversation, below 100 columns', () => {
	const ctrlO = { ctrl: true, sequence: '' };
	const WORDS = 'Rail ok';

	/** A frame after the Markdown of the messages has drawn. */
	const shot = async (built: Built) => {
		await vi.waitFor(async () => expect(await built.frame()).toContain(WORDS), { timeout: 3_000 });
		return built.frame();
	};

	it('draws over the right part, and the conversation keeps its width and its text', async () => {
		const built = await build(80);
		await say(built, WORDS);
		await built.frame();
		const before = built.transcript.root.width;
		await openFiles(built);
		const frame = await shot(built);
		expect(built.transcript.root.visible).toBe(true);
		expect(built.transcript.root.width).toBe(before);
		expect(built.dockPanel.root.visible).toBe(true);
		expect(built.dockPanel.root.width).toBe(64);
		expect(built.dockPanel.root.x + built.dockPanel.root.width).toBe(80);
		expect(leftOf(frame, 80 - 64)).toContain(WORDS);
		expect(frame).toContain('Files');
		expect(built.dock.covers).toBe(true);
	});

	it('takes 40 columns at least, and no more than the terminal', async () => {
		const small = await build(44);
		await openFiles(small);
		expect(await dockWidth(small)).toBe(40);
		const tiny = await build(30);
		await openFiles(tiny);
		expect(await dockWidth(tiny)).toBe(30);
	});

	it('goes away on Esc and comes back on Ctrl+O, while the layer stays open', async () => {
		const built = await build(80);
		await say(built, WORDS);
		await openFiles(built);
		const invalidate = vi.spyOn(built.painter, 'invalidate');
		built.render.mockClear();
		built.press('escape');
		expect(built.dockPanel.root.visible).toBe(false);
		expect(built.transcript.root.visible).toBe(true);
		expect(built.dock.has('files')).toBe(true);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(built.render).toHaveBeenCalledTimes(1);
		expect(await shot(built)).toContain(WORDS);
		expect(built.keys.mode).toBe('compose');
		built.press('o', ctrlO);
		expect(built.keys.mode).toBe('dock');
		expect(built.dockPanel.root.visible).toBe(true);
		expect(await dockWidth(built)).toBe(64);
		expect(leftOf(await shot(built), 80 - 64)).toContain(WORDS);
	});

	it('moves the dock between beside and over the conversation when the terminal resizes', async () => {
		const built = await build(120);
		await say(built, WORDS);
		await openFiles(built);
		await built.frame();
		const beside = built.transcript.root.width;
		expect(beside).toBeLessThan(80);
		expect(built.dock.covers).toBe(false);
		expect(built.dockPanel.root.width).toBe(60);
		const invalidate = vi.spyOn(built.painter, 'invalidate');
		built.setup.resize(80, 30);
		built.render();
		expect(invalidate).toHaveBeenCalledTimes(1);
		await built.frame();
		expect(built.dock.covers).toBe(true);
		expect(built.dockPanel.root.width).toBe(64);
		expect(built.transcript.root.width).toBe(80);
		expect(leftOf(await shot(built), 80 - 64)).toContain(WORDS);
		built.setup.resize(120, 30);
		built.render();
		expect(invalidate).toHaveBeenCalledTimes(2);
		await built.frame();
		expect(built.dock.covers).toBe(false);
		expect(built.dockPanel.root.width).toBe(60);
		expect(built.transcript.root.width).toBe(beside);
		expect(built.dockPanel.root.x).toBe(120 - 60);
		expect(await shot(built)).toContain(WORDS);
	});
});

describe('the files layer keys', () => {
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

	it('clears the search on the first Escape and gives the keys back on the second', async () => {
		const built = await build();
		await openFiles(built);
		built.press('c');
		built.press('escape');
		expect(built.keys.mode).toBe('dock');
		expect(built.session.browser.query).toBe('');
		built.press('escape');
		expect(built.keys.mode).toBe('compose');
		expect(built.session.browser.open).toBe(true);
		expect(built.panel.root.visible).toBe(true);
		expect(built.transcript.root.visible).toBe(true);
		expect(built.composer.input.focused).toBe(true);
	});

	it('closes with Ctrl+C, and a q goes into the search', async () => {
		const built = await build();
		await openFiles(built);
		built.press('q');
		expect(built.session.browser.query).toBe('q');
		built.press('c', { ctrl: true });
		expect(built.keys.mode).toBe('compose');
		expect(built.session.browser.open).toBe(false);
		expect(built.dockPanel.root.visible).toBe(false);
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

describe('the processes layer keys', () => {
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

	it('gives the keys back on Escape, and closes on q', async () => {
		const back = await build();
		await openProcesses(back);
		back.press('escape');
		expect(back.keys.mode).toBe('compose');
		expect(back.processes.open).toBe(true);
		expect(back.processPanel.root.visible).toBe(true);
		expect(back.composer.input.focused).toBe(true);
		const closed = await build();
		await openProcesses(closed);
		closed.press('q');
		expect(closed.keys.mode).toBe('compose');
		expect(closed.processes.open).toBe(false);
		expect(closed.processPanel.root.visible).toBe(false);
		expect(closed.composer.input.focused).toBe(true);
	});

	it('ignores a key with Ctrl or Meta, except Ctrl+Y', async () => {
		const built = await build();
		await openProcesses(built);
		built.press('q', { ctrl: true });
		built.press('q', { meta: true });
		expect(built.keys.mode).toBe('dock');
		expect(built.processes.open).toBe(true);
		built.press('y', { ctrl: true });
		await wait(20);
		expect(built.processes.message).toMatch(/Copied the output|does not accept a clipboard/);
	});
});

describe('moving between layers and modes', () => {
	it('gives the keys to the composer, not to the refs, when a layer opens from the refs', async () => {
		const built = await build();
		built.host.table.set(
			'characterization',
			view('characterization', {
				participants: [{ name: 'priya', kind: 'person' }],
				messages: [
					{ seq: 1, kind: 'said', from: 'priya', text: 'one', at: AT },
					{
						seq: 2,
						kind: 'said',
						from: 'design',
						text: 'two',
						at: AT,
						refs: ['file:///shared/notes.md'],
					},
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
		expect(built.keys.mode).toBe('refs');
		await openFiles(built);
		expect(built.keys.mode).toBe('dock');
		built.press('escape');
		expect(built.keys.mode).toBe('compose');
	});

	it('keeps the files layer open under the processes layer, and shows only the top one', async () => {
		const built = await build();
		await openFiles(built);
		await openProcesses(built);
		expect(built.keys.mode).toBe('dock');
		expect(built.dock.shown).toBe('processes');
		expect(built.session.browser.open).toBe(false);
		expect(built.panel.root.visible).toBe(false);
		expect(built.processPanel.root.visible).toBe(true);
		expect(await built.frame()).toContain('files · processes');
	});

	it('closes the top layer and shows the next one, then hides the dock after the last', async () => {
		const built = await build();
		await openFiles(built);
		await openProcesses(built);
		built.press('q');
		expect(built.dock.shown).toBe('files');
		expect(built.processes.open).toBe(false);
		expect(built.session.browser.open).toBe(true);
		expect(built.panel.root.visible).toBe(true);
		expect(built.keys.mode).toBe('dock');
		const frame = await built.frame();
		expect(frame).toContain('files');
		expect(frame).not.toContain('files ·');
		built.press('c', { ctrl: true });
		expect(built.dock.shown).toBeUndefined();
		expect(built.keys.mode).toBe('compose');
		expect(built.composer.input.focused).toBe(true);
		expect(built.dockPanel.root.visible).toBe(false);
	});

	it('keeps the reading position of a layer that sits below another one', async () => {
		const built = await build();
		built.host.processTable = [
			...built.host.processTable,
			{ ...built.host.processTable[0], handle: 'bash-bbb222', name: 'two' } as never,
		];
		await openProcesses(built);
		built.press('j');
		expect(built.processes.index).toBe(1);
		await openFiles(built);
		expect(built.processes.open).toBe(false);
		built.press('c', { ctrl: true });
		await wait(20);
		expect(built.processes.open).toBe(true);
		expect(built.processes.index).toBe(1);
	});

	it('does not poll the processes while another layer is on top', async () => {
		const built = await build();
		await openProcesses(built);
		await openFiles(built);
		const reads = built.host.calls.filter((call) => call === 'processes').length;
		await built.processes.refresh();
		expect(built.host.calls.filter((call) => call === 'processes')).toHaveLength(reads);
	});
});

describe('the keys of the dock', () => {
	const ctrlO = { ctrl: true, sequence: '' };

	it('leaves the keys with the composer when a layer opens from the camera command', async () => {
		const built = await build();
		built.keys.toggleCamera();
		expect(built.keys.mode).toBe('compose');
		expect(built.composer.input.focused).toBe(true);
	});

	it('gives the keys to the top layer with Ctrl+O, and back with Ctrl+O or Escape', async () => {
		const built = await build();
		await openProcesses(built);
		built.press('escape');
		expect(built.keys.mode).toBe('compose');
		built.composer.setText('draft');
		built.press('o', ctrlO);
		expect(built.keys.mode).toBe('dock');
		expect(built.composer.input.focused).toBe(false);
		expect(built.composer.text).toBe('draft');
		built.press('o', ctrlO);
		expect(built.keys.mode).toBe('compose');
		expect(built.composer.input.focused).toBe(true);
		built.press('o', ctrlO);
		built.press('escape');
		expect(built.keys.mode).toBe('compose');
		expect(built.dock.shown).toBe('processes');
	});

	it('says so when Ctrl+O finds no layer', async () => {
		const built = await build();
		built.press('o', ctrlO);
		expect(built.keys.mode).toBe('compose');
		expect(built.session.notice).toContain('No layer is open');
	});

	it('cycles through the layers with Tab, and the tabs line marks the top one', async () => {
		const built = await build();
		await openFiles(built);
		await openProcesses(built);
		built.press('escape');
		built.keys.toggleCamera();
		expect(built.dock.shown).toBe('camera');
		built.press('o', ctrlO);
		built.press('tab');
		expect(built.dock.shown).toBe('files');
		expect(await built.frame()).toContain('files · processes · camera');
		built.press('tab');
		expect(built.dock.shown).toBe('processes');
		built.press('tab');
		expect(built.dock.shown).toBe('camera');
		expect(built.keys.mode).toBe('dock');
	});

	it('keeps Tab for the refs and the palette in the composer', async () => {
		const built = await build();
		await openProcesses(built);
		built.press('escape');
		built.press('tab');
		expect(built.dock.shown).toBe('processes');
	});

	it('keeps Space for the composer while a layer is open, so voice mode records there', async () => {
		const voice = quietVoice();
		const press = vi.spyOn(voice, 'press');
		const built = await build(120, voice);
		await openProcesses(built);
		built.press('escape');
		press.mockClear();
		built.press('space');
		expect(press).toHaveBeenCalledTimes(1);
		built.press('o', ctrlO);
		press.mockClear();
		built.press('space');
		expect(press).not.toHaveBeenCalled();
	});

	it('keeps the scroll keys of the conversation while the composer has the keys', async () => {
		const built = await build();
		await openProcesses(built);
		built.press('escape');
		const scroll = vi.spyOn(built.transcript, 'scrollBy');
		built.press('pageup');
		expect(scroll).toHaveBeenCalledTimes(1);
	});

	it('shows the tabs line, the panel tone, and one line at the left edge, with no box', async () => {
		const built = await build(120);
		await openFiles(built);
		await openProcesses(built);
		built.press('escape');
		const frame = await built.frame();
		const dockRows = frame.split('\n').slice(0, BODY_ROWS);
		expect(dockRows.join('\n')).not.toMatch(BOX);
		const edge = dockRows.find((row) => row.includes('files · processes')) ?? '';
		expect(edge).toMatch(/│ files · processes\s*$/);
		expect(dockRows.filter((row) => row.includes('│')).length).toBeGreaterThanOrEqual(
			BODY_ROWS - 1,
		);
	});
});

const rows = (count: number, word: string) =>
	Array.from({ length: count }, (_, at) => `${word} ${at + 1}`).join('\n');

describe('what opening and closing a layer do, in order', () => {
	it('opens the surface before the first render', async () => {
		const built = await build();
		const open = vi.spyOn(built.surfaces.files, 'open');
		await built.session.submit('/files');
		built.render.mockClear();
		built.keys.openFiles();
		const [opened] = open.mock.invocationCallOrder;
		const [rendered] = built.render.mock.invocationCallOrder;
		expect(opened).toBeLessThan(rendered ?? 0);
	});

	it('stops the layer it covers, then draws the layer it enters', async () => {
		const built = await build();
		await openFiles(built);
		const hide = vi.spyOn(built.surfaces.files, 'hide');
		const open = vi.spyOn(built.surfaces.processes, 'open');
		built.keys.openProcesses();
		expect(hide).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledTimes(1);
		await wait(20);
		expect(built.panel.root.visible).toBe(false);
		expect(built.processPanel.root.visible).toBe(true);
	});

	it('opens a layer that is open again without a fresh open', async () => {
		const built = await build();
		await openProcesses(built);
		await openFiles(built);
		const open = vi.spyOn(built.surfaces.processes, 'open');
		const show = vi.spyOn(built.surfaces.processes, 'show');
		built.keys.openProcesses();
		expect(open).not.toHaveBeenCalled();
		expect(show).toHaveBeenCalledTimes(1);
		expect(built.dock.shown).toBe('processes');
	});

	it('hides the processes layer when it closes', async () => {
		const built = await build();
		await openProcesses(built);
		expect(built.processPanel.root.visible).toBe(true);
		built.press('q');
		expect(built.processPanel.root.visible).toBe(false);
	});
});

describe('the status line while a layer has the keys', () => {
	it('names the panel, and yields to an error', async () => {
		const built = await build();
		await openFiles(built);
		expect(await built.frame()).toContain(
			'Browsing the workspace files. Esc returns to the composer.',
		);
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

	it('tells the person whether the copy worked, under the file', async () => {
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

	it('Ctrl+C closes the top layer when the dock has the keys, and keeps the draft', async () => {
		const built = await build();
		built.composer.setText('draft');
		built.keys.openFiles();
		built.press('c', ctrl);
		expect(built.keys.mode).toBe('compose');
		expect(built.dock.shown).toBeUndefined();
		expect(built.composer.text).toBe('draft');
		expect(built.quit).not.toHaveBeenCalled();
	});

	it('Ctrl+C clears the composer, and leaves the layers open, when the composer has the keys', async () => {
		const built = await build();
		built.keys.openFiles();
		built.press('escape');
		built.composer.setText('draft');
		built.press('c', ctrl);
		expect(built.composer.text).toBe('');
		expect(built.dock.shown).toBe('files');
	});

	it('Ctrl+D does not leave from the dock', async () => {
		const built = await build();
		built.keys.openFiles();
		built.press('d', ctrl);
		expect(built.quit).not.toHaveBeenCalled();
		expect(built.keys.mode).toBe('dock');
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

describe('the status line in voice mode', () => {
	/** A voice mode that is on, over a recorder that never ends the take. */
	async function listening() {
		const time = { at: 1_000 };
		const redraw = { run: () => {} };
		const voice = new Voice(
			quietParts({
				now: () => time.at,
				start: async () => fakeTake(),
				transcribe: () => new Promise(() => {}),
				changed: () => redraw.run(),
			}),
		);
		await voice.toggle();
		const built = await build(120, voice);
		redraw.run = built.render;
		built.render();
		return { ...built, time };
	}

	it('says how to talk and how to go back in the composer, and keeps the usual status line, when it waits', async () => {
		const built = await listening();
		const frame = await built.frame();
		expect(frame).toContain('Voice: hold Space to talk. /voice returns to text.');
		expect(frame).toContain('Active');
	});

	it('keeps the waiting seat on the status line when it waits', async () => {
		const built = await listening();
		built.host.table.set('characterization', view('characterization', { exchange: { id: 'x' } }));
		await built.session.refresh();
		built.render();
		expect(await built.frame()).toContain('A new message steers the open exchange');
	});

	it('shows listening while the person holds Space, and transcribing after the release', async () => {
		const built = await listening();
		built.press('space');
		await wait(5);
		expect(await built.frame()).toContain('● listening');
		built.time.at += 1_000;
		built.keys.onRelease({ name: 'space' } as KeyEvent);
		await wait(5);
		expect(await built.frame()).toContain('transcribing');
	});

	it('does not type the space into the composer', async () => {
		const built = await listening();
		built.press('space', { sequence: ' ' });
		expect(built.composer.text).toBe('');
		expect(built.prevented.count).toBe(1);
	});

	it('shows the usual status when voice mode is off', async () => {
		const built = await build();
		built.render();
		expect(await built.frame()).not.toContain('Voice:');
	});

	it('leaves Space to the refs, which use it to open a ref', async () => {
		const built = await listening();
		built.keys.mode = 'refs';
		built.press('space');
		expect(built.voice.phase).toBe('idle');
	});
});

describe('the keys sheet', () => {
	it('opens on ? from an empty composer and lists the sections of the table', async () => {
		const built = await build();
		built.press('?', { shift: true });
		await wait(20);
		expect(built.keys.mode).toBe('dock');
		expect(built.dock.shown).toBe('keys');
		expect(built.composer.input.focused).toBe(false);
		expect(built.prevented.count).toBe(1);
		const frame = await built.frame();
		expect(frame).toContain('keys');
		expect(frame).toContain('Ctrl+J Shift+Enter Alt+Enter');
		expect(frame).toContain('Reading the keys. Esc returns to the composer.');
		expect(frame).not.toContain('Processes layer');
		let seen = frame;
		for (let page = 0; page < 10; page++) {
			built.press('pagedown');
			seen += await built.frame();
		}
		for (const text of ['Ctrl+R', 'Ctrl+O', 'Look now', 'Dock', 'Camera layer', 'Processes layer'])
			expect(seen).toContain(text);
	});

	it('types ? into a composer that holds text', async () => {
		const built = await build();
		built.composer.setText('why');
		built.press('?', { shift: true });
		expect(built.keys.mode).toBe('compose');
		expect(built.prevented.count).toBe(0);
	});

	it.each(['?', 'q'])('closes on %s and gives the keys back to the composer', async (name) => {
		const built = await build();
		built.press('?');
		built.press(name);
		expect(built.keys.mode).toBe('compose');
		expect(built.composer.input.focused).toBe(true);
		expect(built.transcript.root.visible).toBe(true);
		expect(built.surfaces.keys.root.visible).toBe(false);
		expect(built.dock.shown).toBeUndefined();
	});

	it('stays open on Escape, which gives the keys back, and closes on ? from the composer', async () => {
		const built = await build();
		built.press('?');
		built.press('escape');
		expect(built.keys.mode).toBe('compose');
		expect(built.composer.input.focused).toBe(true);
		expect(built.dock.shown).toBe('keys');
		built.press('?');
		expect(built.dock.shown).toBeUndefined();
		expect(built.keys.mode).toBe('compose');
	});

	it('shows again on ? in a narrow terminal, after Escape hides it', async () => {
		const built = await build(80);
		built.press('?');
		built.press('escape');
		expect(built.dockPanel.root.visible).toBe(false);
		built.press('?');
		expect(built.keys.mode).toBe('dock');
		expect(built.dock.shown).toBe('keys');
		expect(built.dockPanel.root.visible).toBe(true);
	});

	it('closes on Ctrl+C', async () => {
		const built = await build();
		built.press('?');
		built.press('c', { ctrl: true });
		expect(built.keys.mode).toBe('compose');
		expect(built.composer.input.focused).toBe(true);
		expect(built.dock.shown).toBeUndefined();
	});

	it('scrolls with the page keys', async () => {
		const built = await build();
		built.press('?');
		expect(await built.frame()).toContain('Composer');
		built.press('pagedown');
		expect(await built.frame()).not.toContain('Composer');
		built.press('pageup');
		expect(await built.frame()).toContain('Composer');
	});

	it('shows the hint in the composer footer in compose mode only', async () => {
		const built = await build();
		built.render();
		expect(await built.frame()).toContain('? keys');
		built.press('?');
		expect(await built.frame()).not.toContain('? keys');
		built.press('escape');
		expect(await built.frame()).toContain('? keys');
		built.keys.openFiles();
		expect(await built.frame()).not.toContain('? keys');
	});

	it('shows the hint while a layer is open and the composer has the keys', async () => {
		const built = await build();
		built.keys.openFiles();
		built.press('escape');
		expect(await built.frame()).toContain('? keys');
	});
});
