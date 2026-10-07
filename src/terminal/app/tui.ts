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
import { Voice } from '../state/voice.ts';
import { brand, tui as palette } from '../widgets/brand.ts';
import { Composer } from '../widgets/composer.ts';
import { DockPanel } from '../widgets/dock.ts';
import { FilesPanel } from '../widgets/files-panel.ts';
import { Header } from '../widgets/header.ts';
import { KeysPanel } from '../widgets/keys-panel.ts';
import { Palette } from '../widgets/palette.ts';
import { ProcessesPanel } from '../widgets/process-panel.ts';
import { edgeRows, GAP, GUTTER } from '../widgets/space.ts';
import { Transcript } from '../widgets/transcript.ts';
import { ViewfinderPanel } from '../widgets/viewfinder-panel.ts';
import { Dock } from './dock.ts';
import { Painter } from './draw.ts';
import { FilesSurface } from './files-surface.ts';
import { KEYBOARD, keyboardProblem } from './keyboard.ts';
import { Keys } from './keys.ts';
import { KeysSurface } from './keys-surface.ts';
import { Microphone } from './microphone.ts';
import { ProcessesSurface } from './process-surface.ts';
import { ViewfinderSurface } from './viewfinder-surface.ts';
import { type WhisperConfig, whisperConfig, whisperProblem } from './whisper.ts';
import { WhisperServer } from './whisper-server.ts';

/** How often the slow fallback reads the room list and a stopped room. */
const SLOW_MS = 4_000;

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
	private readonly root: BoxRenderable;
	private readonly session: Session;
	private readonly composer: Composer;
	private readonly painter: Painter;
	private readonly palette: Palette;
	private readonly keys: Keys;
	private readonly processes: ProcessBrowser;
	private readonly voice: Voice;
	private readonly microphone = new Microphone();
	private readonly whisper: WhisperServer;
	private stopped = false;

	constructor(renderer: CliRenderer, host: Lab, identity: Person | undefined) {
		this.renderer = renderer;
		this.session = new Session(host, identity, () => this.render());
		const config = whisperConfig();
		this.whisper = new WhisperServer(config, {
			changed: () => this.render(),
			stopped: (line) => this.voice.crashed(line),
		});
		this.voice = this.newVoice(config);
		const header = new Header(renderer);
		const transcript = new Transcript(renderer);
		this.processes = new ProcessBrowser(host, () => this.render());
		const viewfinder = new ViewfinderSurface(
			new ViewfinderBrowser(
				host,
				{
					room: () => this.session.room,
					person: () => this.session.identity?.name,
					stopped: () => this.session.view?.status !== 'running',
				},
				() => this.render(),
			),
			new ViewfinderPanel(renderer),
			() => drawsKitty(renderer),
		);
		const surfaces = {
			files: new FilesSurface(this.session.browser, new FilesPanel(renderer)),
			processes: new ProcessesSurface(this.processes, new ProcessesPanel(renderer), () =>
				this.render(),
			),
			keys: new KeysSurface(new KeysPanel(renderer)),
			camera: viewfinder,
		};
		const panel = new DockPanel(renderer);
		const dock = new Dock({
			surfaces,
			panel,
			width: () => renderer.width,
		});
		const body = new BoxRenderable(renderer, {
			flexDirection: 'row',
			flexGrow: 1,
			gap: GAP,
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
			dock,
			header,
			voice: this.voice,
			pictures: new PictureCache(
				(ref) => host.snapshot(ref),
				() => this.render(),
			),
			graphics: () => drawsKitty(renderer),
			cellAspect: () => cellAspectOf(renderer),
			width: () => renderer.width - 2 * GUTTER,
		});
		this.palette = new Palette(this.composer);
		this.keys = new Keys({
			renderer,
			session: this.session,
			composer: this.composer,
			palette: this.palette,
			painter: this.painter,
			dock,
			viewfinder,
			transcript,
			voice: this.voice,
			render: () => this.render(),
			quit: () => this.renderer.destroy(),
		});
		// The blank rows at the top and at the bottom follow the height of the terminal, in `render`.
		this.root = new BoxRenderable(renderer, {
			flexDirection: 'column',
			width: '100%',
			height: '100%',
			paddingLeft: GUTTER,
			paddingRight: GUTTER,
			gap: GAP,
			backgroundColor: palette.bg,
		});
		this.root.add(header.root);
		body.add(transcript.root);
		for (const layer of Object.values(surfaces)) panel.add(layer.root);
		body.add(panel.root);
		this.root.add(body);
		this.root.add(this.composer.root);
		renderer.root.add(this.root);
		renderer.keyInput.on('keypress', (key: KeyEvent) => {
			this.keys.onKey(key);
			this.followEdit();
		});
		// The terminal reports a key release only with the Kitty keyboard events in `openRenderer`.
		renderer.keyInput.on('keyrelease', (key: KeyEvent) => this.keys.onRelease(key));
		renderer.on('resize', () => this.render());
		// The terminal answers the graphics query after the start.
		renderer.on('capabilities', () => this.render());
		this.composer.focus();
		this.render();
	}

	/** Run until the renderer is destroyed. */
	async run(): Promise<void> {
		// The poll also reads the processes layer while it shows: a running process writes
		// output that no event reports, and its time grows.
		const slow = setInterval(() => {
			void this.session.poll();
			void this.processes.refresh();
		}, SLOW_MS);
		await new Promise<void>((resolve) => {
			this.renderer.once('destroy', () => {
				this.stopped = true;
				this.keys.release();
				this.voice.dispose();
				this.processes.dispose();
				this.microphone.dispose();
				clearInterval(slow);
				resolve();
			});
			void this.begin();
		});
		// The server ends with the terminal. `voice.dispose` already asked it to end.
		await this.whisper.stop();
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

	/** Voice mode, over the microphone of this terminal and whisper-server. */
	private newVoice(config: WhisperConfig): Voice {
		return new Voice({
			ready: async () =>
				keyboardProblem(this.renderer.capabilities) ?? (await whisperProblem(config)),
			start: () => this.microphone.start(),
			serve: () => this.whisper.start(),
			halt: () => void this.whisper.stop(),
			loading: () => this.whisper.loading(),
			transcribe: (file, signal) => this.whisper.transcribe(file, signal),
			discard: (file) => this.microphone.discard(file),
			place: () => `${this.session.whoami}/${this.session.room}`,
			deliver: (text) => this.sendVoice(text),
			say: (note) => this.session.say(note),
			problem: (line) => {
				this.session.error = line;
				this.render();
			},
			shown: () => this.session.error,
			changed: () => this.render(),
		});
	}

	/** Send a transcript as the person's message. It takes the path of Enter. */
	private async sendVoice(text: string): Promise<void> {
		const isMessage = !this.session.awaitingGoal && parse(text).kind === 'message';
		const intent = await this.session.submit(text);
		// A message that failed to send goes to the box, so the person can send it again.
		if (isMessage && this.session.error && this.composer.text === '') this.composer.setText(text);
		if (intent) this.apply(intent);
	}

	private render(): void {
		if (this.stopped) return;
		this.root.paddingTop = edgeRows(this.renderer.height);
		this.root.paddingBottom = edgeRows(this.renderer.height);
		this.keys.reconcile();
		this.painter.render(this.keys.mode, this.keys.picking);
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
		else if (intent.type === 'voice') void this.voice.toggle();
		else this.keys.openFiles();
	}
}

/** OpenTUI draws through Node's FFI, which Node enables only with a flag. */
async function openRenderer(): Promise<CliRenderer> {
	try {
		return await createCliRenderer({
			exitOnCtrlC: false,
			targetFps: 30,
			useKittyKeyboard: KEYBOARD,
		});
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
		renderer.setTerminalTitle(`${brand.name} ${brand.product}`);
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
