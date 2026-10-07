import type { CliRenderer, KeyEvent } from '@opentui/core';
import { stayOfPick } from '../../view/refs.ts';
import { type Act, actOf, KEYMAP } from '../state/keymap.ts';
import type { LayerId } from '../state/layers.ts';
import type { Mode } from '../state/mode.ts';
import type { Session } from '../state/session.ts';
import type { Voice } from '../state/voice.ts';
import type { Composer } from '../widgets/composer.ts';
import type { Palette } from '../widgets/palette.ts';
import type { Transcript } from '../widgets/transcript.ts';
import { type Dock, NARROW } from './dock.ts';
import type { Painter } from './draw.ts';
import type { ViewfinderSurface } from './viewfinder-surface.ts';

/** What the keys reach into. `render` redraws after a change the keys make. */
export interface KeyParts {
	renderer: CliRenderer;
	session: Session;
	composer: Composer;
	palette: Palette;
	painter: Painter;
	/** The dock, with the files, the processes, the keys sheet, and the camera as layers. */
	dock: Dock;
	/** The camera layer, for the actions of the cameras. */
	viewfinder: ViewfinderSurface;
	transcript: Transcript;
	/** Voice mode. Space on an empty composer records. */
	voice: Voice;
	render: () => void;
	/** Leave the terminal. */
	quit: () => void;
	/** The clock for the window of the second Ctrl+D, in milliseconds. It defaults to `Date.now`. */
	now?: () => number;
}

/**
 * The pick that the Tab key starts on: the newest ref of a message, and the last
 * activation line when no ref shows.
 */
const firstPick = (ids: readonly string[]): string | undefined =>
	ids.findLast((id) => stayOfPick(id) === undefined) ?? ids.at(-1);

/** The time in which a second Ctrl+D leaves the terminal. */
export const QUIT_WINDOW_MS = 2000;

/**
 * The input. It routes each key to the composer, the refs, the actions of the
 * cameras, or the top layer of the dock, and it holds the current mode and the
 * chosen ref. It changes the session and the widgets; it holds no drawing state of its own.
 */
export class Keys {
	mode: Mode = 'compose';
	/** The id of the chosen ref, in refs mode. */
	picking: string | undefined;
	private readonly renderer: CliRenderer;
	private readonly session: Session;
	private readonly composer: Composer;
	private readonly palette: Palette;
	private readonly painter: Painter;
	private readonly dock: Dock;
	private readonly viewfinder: ViewfinderSurface;
	private readonly transcript: Transcript;
	private readonly voice: Voice;
	private readonly render: () => void;
	private readonly quit: () => void;
	private readonly now: () => number;
	/** The time of the first Ctrl+D, while a second one still leaves. */
	private quitArmedAt: number | undefined;

	constructor(parts: KeyParts) {
		this.renderer = parts.renderer;
		this.session = parts.session;
		this.composer = parts.composer;
		this.palette = parts.palette;
		this.painter = parts.painter;
		this.dock = parts.dock;
		this.viewfinder = parts.viewfinder;
		this.transcript = parts.transcript;
		this.voice = parts.voice;
		this.render = parts.render;
		this.quit = parts.quit;
		this.now = parts.now ?? Date.now;
	}

	/** Recompute the palette rows. The palette closes outside compose mode. */
	refreshPalette(): void {
		this.palette.refresh(this.mode === 'compose', (text) => this.session.suggestions(text));
	}

	/**
	 * Keep the chosen ref on a ref that still exists, and the dock in its place. The
	 * composer takes the keys back from a mode that has lost what it works on.
	 */
	reconcile(): void {
		const ids = this.session.pickIds;
		if (this.picking && !ids.includes(this.picking)) this.picking = firstPick(ids);
		if (this.mode === 'refs' && !this.picking) {
			this.mode = 'compose';
			this.composer.focus();
		}
		if (this.mode === 'dock' && !this.dock.shown) {
			this.mode = 'compose';
			this.composer.focus();
		}
		if (this.dock.layout(this.mode === 'dock')) this.painter.invalidate();
		// The pad leaves by itself when no camera has an action, or when the camera is not on top.
		if (this.mode === 'actions' && !this.viewfinder.acting()) this.leaveActions();
	}

	// Routing

	onKey(key: KeyEvent): void {
		if (this.controlKey(key) || this.voiceKey(key)) return;
		if (this.mode === 'dock') {
			this.dockKey(key);
			return;
		}
		const scroll = actOf('conversation', key);
		if (scroll) {
			const page = Math.max(4, this.transcript.root.height - 2);
			this.transcript.scrollBy(scroll === 'pageUp' ? -page : page);
			return;
		}
		if (this.mode === 'actions') this.actionsKey(key);
		else if (this.mode === 'refs') this.refsKey(key);
		else this.composeKey(key);
	}

	/**
	 * Space in voice mode. True when voice mode takes the key. Voice mode owns
	 * Space in the composer only, because the dock and the refs use Space themselves.
	 */
	private voiceKey(key: KeyEvent): boolean {
		if (this.mode !== 'compose' || !this.voice.press(key, this.composer.text === '')) return false;
		key.preventDefault();
		return true;
	}

	/**
	 * A key comes back up. Only the terminals that report key release send this.
	 * Voice mode sends the recording when the person lets go of Space, in any
	 * mode, because the hold can outlast a mode change. The release ends the hold
	 * with any modifier, because the person can press Ctrl or Alt before they let go.
	 */
	onRelease(key: KeyEvent): void {
		if (KEYMAP.composer.bindings.talk.keys.some((chord) => chord.name === key.name))
			void this.voice.release();
	}

	/**
	 * Ctrl+C and Ctrl+D. True when the key is handled. Ctrl+D leaves only from an
	 * empty composer, because a layer uses it to scroll and the textarea uses it to
	 * delete. It leaves on the second press inside a short window. Any other key
	 * ends the window. A key that the terminal repeats neither arms nor leaves.
	 */
	private controlKey(key: KeyEvent): boolean {
		const act = actOf('everywhere', key);
		const leaves = act === 'quit' && this.mode === 'compose' && this.composer.text === '';
		if (leaves && key.repeated) {
			key.preventDefault();
			return true;
		}
		if (!leaves) this.quitArmedAt = undefined;
		if (!leaves && act !== 'interrupt') return false;
		key.preventDefault();
		if (leaves) this.pressQuit();
		else this.interrupt();
		return true;
	}

	/** Ctrl+D on an empty composer. The first press says how to leave, and the second one leaves. */
	private pressQuit(): void {
		const now = this.now();
		const armed = this.quitArmedAt !== undefined && now - this.quitArmedAt <= QUIT_WINDOW_MS;
		this.quitArmedAt = armed ? undefined : now;
		if (armed) {
			this.quit();
			return;
		}
		this.session.say('Press Ctrl+D again to leave.');
		this.render();
	}

	/**
	 * Ctrl+C drops a recording or a transcription that runs. Otherwise it closes
	 * the top layer of the dock, when the dock has the keys, and keeps the draft. In the other modes it
	 * clears the composer, and it cancels a new room that waits for its goal.
	 * It does not quit.
	 */
	private interrupt(): void {
		if (this.voice.cancel()) {
			this.render();
			return;
		}
		if (this.mode === 'dock') {
			this.closeTop();
			return;
		}
		if (this.mode === 'actions') {
			this.leaveActions();
			this.render();
			return;
		}
		const hadText = this.composer.text !== '';
		this.composer.setText('');
		this.palette.revive();
		this.session.interrupt(hadText);
		this.render();
	}

	// The dock

	/** Open the files layer, and give it the keys. A narrow terminal draws it over the conversation. */
	openFiles(): void {
		this.openLayer('files');
	}

	/** Open the processes layer, and read the processes. It takes the keys. */
	openProcesses(): void {
		this.openLayer('processes');
	}

	/** Open the keys sheet, or close it while it shows on the screen. The sheet takes the keys when it opens. */
	openKeys(): void {
		if (this.dock.shown === 'keys' && this.dock.onScreen) this.closeTop();
		else this.openLayer('keys');
	}

	/**
	 * Open the camera layer when it is closed or below another layer, and close it
	 * when it shows. The composer keeps the keys. A narrow terminal does not show
	 * the camera: it closes a camera layer that is open, and it says so. It opens none.
	 */
	toggleCamera(): void {
		if (this.renderer.width < NARROW) this.closeHiddenCamera();
		else if (this.dock.shown === 'camera') {
			this.dock.close('camera');
			this.render();
		} else this.openLayer('camera');
	}

	private closeHiddenCamera(): void {
		if (!this.dock.has('camera')) {
			this.sayCameraWidth();
			return;
		}
		this.dock.close('camera');
		this.session.say(
			`Closed the camera. It shows when the terminal is at least ${NARROW} columns wide.`,
		);
		this.render();
	}

	private sayCameraWidth(): void {
		this.session.say(`The camera shows when the terminal is at least ${NARROW} columns wide.`);
		this.render();
	}

	/** End the layers without drawing, when the terminal ends. Their polls and timers stop. */
	release(): void {
		this.dock.release();
	}

	/**
	 * Put a layer on top. A layer that needs the keys takes them from the composer, and a layer
	 * that does not, such as the camera, leaves them where they are.
	 */
	private openLayer(id: LayerId): void {
		if (this.mode === 'actions') this.leaveActions();
		// The layer opens first, so the first draw shows it.
		this.dock.open(id);
		if (this.dock.takesKeys(id)) {
			this.mode = 'dock';
			this.composer.blur();
		}
		this.render();
	}

	/** Give the keys to the top layer. The composer keeps its draft. */
	private enterDock(): void {
		if (!this.dock.shown) {
			if (this.renderer.width < NARROW && this.dock.has('camera')) this.sayCameraWidth();
			else this.session.say('No layer is open. Use /files, /ps, /camera, or ? to open one.');
			return;
		}
		if (this.mode === 'actions') this.leaveActions();
		this.mode = 'dock';
		this.composer.blur();
		this.render();
	}

	/** Give the keys back to the composer. Every layer stays open. */
	private leaveDock(): void {
		this.mode = 'compose';
		this.composer.focus();
		this.render();
	}

	/**
	 * Close the top layer. The layer below shows, and the dock goes when none is left. The keys
	 * go back to the composer when no layer is left that needs them.
	 */
	private closeTop(): void {
		this.dock.close();
		const next = this.dock.shown;
		if (this.mode === 'dock' && !(next && this.dock.takesKeys(next))) {
			this.mode = 'compose';
			this.composer.focus();
		}
		this.render();
	}

	/** One key in the dock: the tab key, the actions key, and the leave key, else the top layer. */
	private dockKey(key: KeyEvent): void {
		const act = actOf('dock', key);
		if (!act) {
			this.dock.onKey(key, { back: () => this.leaveDock(), close: () => this.closeTop() });
			return;
		}
		key.preventDefault();
		if (act === 'cycle') {
			this.dock.cycle();
			this.render();
		} else if (act === 'actions') this.enterActions();
		else this.leaveDock();
	}

	// The actions of the cameras

	/** Give the keys to the actions of the cameras. A camera layer that is not on top, or a camera with no action, keeps the composer. */
	private enterActions(): void {
		if (this.renderer.width < NARROW) {
			this.sayCameraWidth();
			return;
		}
		if (this.dock.shown !== 'camera') {
			this.session.say('The camera layer is not on top. Use /camera to show the cameras.');
			return;
		}
		if (!this.viewfinder.enterActions()) {
			this.session.say('No shown camera has an action.');
			return;
		}
		this.mode = 'actions';
		this.composer.blur();
		this.render();
	}

	private leaveActions(): void {
		this.viewfinder.leaveActions();
		this.mode = 'compose';
		this.composer.focus();
	}

	private actionsKey(key: KeyEvent): void {
		if (key.name !== 'pageup' && key.name !== 'pagedown') key.preventDefault();
		if (this.viewfinder.actionKey(key) === 'leave') {
			this.leaveActions();
			this.render();
		}
	}

	// Refs

	private enterRefs(): void {
		const ids = this.session.pickIds;
		if (ids.length === 0) {
			this.session.say('No shown message has a ref, and no activation line shows.');
			return;
		}
		this.mode = 'refs';
		this.composer.blur();
		this.picking = this.picking && ids.includes(this.picking) ? this.picking : firstPick(ids);
		this.painter.invalidate();
		this.render();
	}

	private exitRefs(): void {
		this.mode = 'compose';
		this.composer.focus();
		this.session.clearFocus();
		this.painter.invalidate();
		this.render();
	}

	private moveRef(step: number): void {
		const ids = this.session.pickIds;
		const at = this.picking ? ids.indexOf(this.picking) : -1;
		this.picking = ids[Math.max(0, Math.min(ids.length - 1, at + step))];
		this.session.clearFocus();
		this.render();
	}

	/**
	 * Open the chosen ref. A message ref jumps, and a file or a table opens the files
	 * layer. A folded activation line expands, or folds when it is open.
	 */
	private async openPicked(): Promise<void> {
		const picking = this.picking;
		if (!picking) return;
		const target = this.session.refItems.find((item) => item.id === picking)?.resolved.target;
		if (target?.kind === 'message') this.painter.revealMessage(target.seq);
		const stay = stayOfPick(picking);
		if (stay !== undefined) this.painter.revealStay(stay);
		const intent = await this.session.openPick(picking);
		if (intent) this.openFiles();
	}

	/** What each key of the refs does. */
	private readonly refActs: Record<Act<'refs'>, () => void> = {
		up: () => this.moveRef(-1),
		down: () => this.moveRef(1),
		open: () => void this.openPicked(),
		back: () => this.exitRefs(),
	};

	private refsKey(key: KeyEvent): void {
		key.preventDefault();
		const act = actOf('refs', key);
		if (act) this.refActs[act]();
	}

	// The composer

	/**
	 * What each key of the composer does. A handler returns true when it takes the
	 * key, and false when the textarea gets it. The textarea handles `send` and
	 * `newline` through its own bindings. `talk` belongs to voice mode, which reads
	 * Space before the keys route it.
	 */
	private readonly composeActs: Record<Act<'composer'>, () => boolean> = {
		send: () => false,
		newline: () => false,
		talk: () => false,
		keys: () => {
			if (this.composer.text !== '') return false;
			this.openKeys();
			return true;
		},
		dock: () => {
			this.enterDock();
			return true;
		},
		tab: () => {
			if (this.palette.open) this.palette.complete();
			else this.enterRefs();
			return true;
		},
		up: () => this.movePalette(-1),
		down: () => this.movePalette(1),
		escape: () => this.escapeCompose(),
		rooms: () => {
			this.palette.revive();
			this.composer.setText('/room ');
			return true;
		},
		actions: () => {
			this.enterActions();
			return true;
		},
	};

	private composeKey(key: KeyEvent): void {
		const act = actOf('composer', key);
		if (act && this.composeActs[act]()) key.preventDefault();
	}

	private movePalette(step: number): boolean {
		if (!this.palette.open) return false;
		this.palette.move(step);
		return true;
	}

	/**
	 * Esc cancels a new room that waits for its goal, or it closes the palette. When
	 * neither applies and the dock shows on the screen, it closes the top layer of
	 * the dock. Otherwise the composer gets the key.
	 */
	private escapeCompose(): boolean {
		if (this.session.awaitingGoal) {
			this.session.cancelWaiting();
			this.composer.setText('');
			return true;
		}
		if (this.palette.open) {
			this.palette.dismiss();
			this.refreshPalette();
			return true;
		}
		if (!this.dock.onScreen || !this.dock.shown) return false;
		this.closeTop();
		return true;
	}
}
