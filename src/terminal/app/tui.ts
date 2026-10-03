import {
	BoxRenderable,
	type CliRenderer,
	createCliRenderer,
	type KeyEvent,
	resolveImageRenderProtocol,
} from '@opentui/core';
import { type Lab, type OpenOptions, openLab, type Person } from '../../host/host.ts';
import { errorText } from '../../view/text.ts';
import { parse } from '../state/commands.ts';
import { PictureCache } from '../state/picture-cache.ts';
import { ProcessBrowser } from '../state/process-browser.ts';
import { type Intent, Session } from '../state/session.ts';
import { ViewfinderBrowser } from '../state/viewfinder-browser.ts';
import { tui as palette } from '../widgets/brand.ts';
import { Composer } from '../widgets/composer.ts';
import { FilesPanel } from '../widgets/files-panel.ts';
import { Header } from '../widgets/header.ts';
import { Palette } from '../widgets/palette.ts';
import { ProcessesPanel } from '../widgets/process-panel.ts';
import { Transcript } from '../widgets/transcript.ts';
import { ViewfinderPanel } from '../widgets/viewfinder-panel.ts';
import { Painter } from './draw.ts';
import { FilesSurface } from './files-surface.ts';
import { Keys } from './keys.ts';
import { ProcessesSurface } from './process-surface.ts';
import { ViewfinderSurface } from './viewfinder-surface.ts';

/** How often the slow fallback reads the room list and a stopped room. */
const SLOW_MS = 4_000;

/** The cells between the terminal edge and the content, on each side. */
const PADDING = 1;

/** True when the terminal draws Kitty graphics. Thumbnails and the viewfinder need it. */
const drawsKitty = (renderer: CliRenderer): boolean =>
	resolveImageRenderProtocol('auto', renderer.capabilities, Boolean(renderer.resolution)) ===
	'kitty';

/** The height of a cell over its width, from the pixel size of the terminal. Two when it is unknown. */
function cellAspectOf(renderer: CliRenderer): number {
	const size = renderer.resolution;
	if (!size || renderer.terminalWidth <= 0 || renderer.terminalHeight <= 0) return 2;
	return size.height / renderer.terminalHeight / (size.width / renderer.terminalWidth);
}

/**
 * The terminal. It builds the widgets, the session, and the input, and wires
 * them together. It holds no rules of its own: the session owns the state, the
 * painter draws it, and the keys route the input.
 */
class EngineTui {
	private readonly renderer: CliRenderer;
	private readonly session: Session;
	private readonly composer: Composer;
	private readonly painter: Painter;
	private readonly palette: Palette;
	private readonly keys: Keys;
	private readonly processes: ProcessBrowser;
	private stopped = false;

	constructor(renderer: CliRenderer, host: Lab, identity: Person | undefined) {
		this.renderer = renderer;
		this.session = new Session(host, identity, () => this.render());
		const header = new Header(renderer);
		const transcript = new Transcript(renderer);
		this.processes = new ProcessBrowser(host, () => this.render());
		const surfaces = {
			files: new FilesSurface(this.session.browser, new FilesPanel(renderer)),
			processes: new ProcessesSurface(this.processes, new ProcessesPanel(renderer), () =>
				this.render(),
			),
		};
		const viewfinder = new ViewfinderSurface(
			new ViewfinderBrowser(host, () => this.render()),
			new ViewfinderPanel(renderer),
			() => drawsKitty(renderer),
		);
		const body = new BoxRenderable(renderer, {
			flexDirection: 'row',
			flexGrow: 1,
			gap: 1,
			minHeight: 0,
		});
		this.composer = new Composer(renderer, {
			submit: () => void this.onSubmit(),
			change: () => this.keys.refreshPalette(),
		});
		this.painter = new Painter({
			session: this.session,
			transcript,
			composer: this.composer,
			surfaces,
			header,
			pictures: new PictureCache(
				(ref) => host.snapshot(ref),
				() => this.render(),
			),
			graphics: () => drawsKitty(renderer),
			cellAspect: () => cellAspectOf(renderer),
			width: () => renderer.width - 2 * PADDING,
		});
		this.palette = new Palette(this.composer);
		this.keys = new Keys({
			renderer,
			session: this.session,
			composer: this.composer,
			palette: this.palette,
			painter: this.painter,
			surfaces,
			viewfinder,
			transcript,
			render: () => this.render(),
			quit: () => this.renderer.destroy(),
		});
		const root = new BoxRenderable(renderer, {
			flexDirection: 'column',
			width: '100%',
			height: '100%',
			padding: PADDING,
			gap: 1,
			backgroundColor: palette.bg,
		});
		root.add(header.root);
		body.add(transcript.root);
		body.add(surfaces.files.root);
		body.add(surfaces.processes.root);
		body.add(viewfinder.root);
		root.add(body);
		root.add(this.composer.root);
		renderer.root.add(root);
		renderer.keyInput.on('keypress', (key: KeyEvent) => {
			this.keys.onKey(key);
			this.followEdit();
		});
		renderer.on('resize', () => this.render());
		// The terminal answers the graphics query after the start.
		renderer.on('capabilities', () => this.render());
		this.composer.focus();
		this.render();
	}

	/** Run until the renderer is destroyed. */
	async run(): Promise<void> {
		// The poll also reads the open processes panel: a running process writes
		// output that no event reports, and its time grows.
		const slow = setInterval(() => {
			void this.session.poll();
			void this.processes.refresh();
		}, SLOW_MS);
		await new Promise<void>((resolve) => {
			this.renderer.once('destroy', () => {
				this.stopped = true;
				this.keys.release();
				clearInterval(slow);
				resolve();
			});
			void this.begin();
		});
	}

	private async begin(): Promise<void> {
		await this.session.start();
		// Nobody is chosen yet: fill the composer so the person chooses who to act as.
		if (!this.session.identity) this.composer.setText('/user ');
	}

	async leave(): Promise<void> {
		await this.session.leave();
	}

	/**
	 * The input reports a typed edit late: measured at up to 4 s, until the next repaint.
	 * So the palette reads the text one macrotask after the key, when the input has applied it.
	 */
	private followEdit(): void {
		setTimeout(() => {
			if (!this.stopped) this.keys.refreshPalette();
		}, 0);
	}

	private render(): void {
		if (this.stopped) return;
		this.keys.reconcile();
		this.painter.render(this.keys.mode, this.keys.browsing, this.keys.picking);
		this.keys.refreshPalette();
	}

	private async onSubmit(): Promise<void> {
		const row = this.palette.current;
		if (row && !row.run) {
			this.composer.setText(row.insert);
			return;
		}
		const text = row ? row.insert : this.composer.text;
		const isMessage = !this.session.awaitingGoal && parse(text).kind === 'message';
		const typed = this.composer.text;
		const intent = await this.session.submit(text);
		// A message that failed to send stays in the box, so the person can send it again.
		// Text typed while the send ran also stays.
		if (!(isMessage && this.session.error) && this.composer.text === typed)
			this.composer.setText('');
		if (intent) this.apply(intent);
	}

	private apply(intent: Intent): void {
		if (intent.type === 'quit') this.renderer.destroy();
		else if (intent.type === 'compose') this.composer.setText(intent.text);
		else if (intent.type === 'processes') this.keys.openProcesses();
		else if (intent.type === 'camera') this.keys.toggleCamera();
		else this.keys.openFiles();
	}
}

/** OpenTUI draws through Node's FFI, which Node enables only with a flag. */
async function openRenderer(): Promise<CliRenderer> {
	try {
		return await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
	} catch (error) {
		const detail = errorText(error);
		if (!/FFI/i.test(detail)) throw error;
		throw new Error(
			`${detail}\nStart Workbench with \`pnpm start\`. It passes --experimental-ffi to Node.`,
		);
	}
}

export interface RunOptions {
	/** Where the journals and the workspace live. */
	directory: string;
	/** The person to act as. Without one, the terminal asks. */
	person?: string;
	/** A model stream, for tests. */
	stream?: OpenOptions['stream'];
	/** The path of `workstation.json`, for the bash and git backends. */
	workstation?: OpenOptions['workstation'];
}

/**
 * Run Workbench: host the rooms and show the terminal, in this
 * process. The rooms are active while the terminal runs. When it ends, the
 * person leaves and the rooms stop.
 */
export async function runEngine(options: RunOptions): Promise<void> {
	const host = await openLab({
		directory: options.directory,
		stream: options.stream,
		workstation: options.workstation,
	});
	try {
		const identity = options.person
			? host.people.find((person) => person.name === options.person)
			: undefined;
		if (options.person && !identity) {
			const names = host.people.map((person) => person.name).join(', ');
			throw new Error(`Unknown person '${options.person}'. Pick one of ${names}.`);
		}
		const renderer = await openRenderer();
		renderer.setBackgroundColor(palette.bg);
		const app = new EngineTui(renderer, host, identity);
		const stop = () => renderer.destroy();
		process.once('SIGTERM', stop);
		process.once('SIGHUP', stop);
		process.once('SIGINT', stop);
		try {
			await app.run();
		} finally {
			process.off('SIGTERM', stop);
			process.off('SIGHUP', stop);
			process.off('SIGINT', stop);
			await app.leave();
		}
	} finally {
		await host.close();
	}
}
