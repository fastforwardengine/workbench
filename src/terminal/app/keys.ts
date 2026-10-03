import type { CliRenderer, KeyEvent } from '@opentui/core';
import { discussionKeys } from '../../view/timeline.ts';
import { isPanel, type Mode, type PanelMode } from '../state/mode.ts';
import type { Session } from '../state/session.ts';
import type { Composer } from '../widgets/composer.ts';
import type { Palette } from '../widgets/palette.ts';
import type { Transcript } from '../widgets/transcript.ts';
import type { Painter } from './draw.ts';
import type { Surface } from './surface.ts';
import type { ViewfinderSurface } from './viewfinder-surface.ts';

/** How far each browse key, and each refs key, moves the selection. */
const BROWSE_STEP: Record<string, number> = { up: -1, k: -1, down: 1, j: 1 };

/** Below this width, a side panel replaces the conversation, and the viewfinder does not show. */
const NARROW = 100;

/** What the keys reach into. `render` redraws after a change the keys make. */
export interface KeyParts {
	renderer: CliRenderer;
	session: Session;
	composer: Composer;
	palette: Palette;
	painter: Painter;
	/** The side panels, by mode. */
	surfaces: Readonly<Record<PanelMode, Surface>>;
	/** The viewfinder. It shows beside the conversation and takes no keys. */
	viewfinder: ViewfinderSurface;
	transcript: Transcript;
	render: () => void;
	/** Leave the terminal. */
	quit: () => void;
}

/**
 * The input. It routes each key to the composer, the discussions, or the files
 * panel, and it holds the current mode and the browse selection. It changes the
 * session and the widgets; it holds no drawing state of its own.
 */
export class Keys {
	mode: Mode = 'compose';
	browsing: string | undefined;
	/** The id of the chosen ref, in refs mode. */
	picking: string | undefined;
	/** True when the person asked for the viewfinder. A panel or a narrow terminal can still hide it. */
	private finderWanted = false;
	/** The mode a side panel returns to when it closes. */
	private origin: Mode = 'compose';
	private readonly renderer: CliRenderer;
	private readonly session: Session;
	private readonly composer: Composer;
	private readonly palette: Palette;
	private readonly painter: Painter;
	private readonly surfaces: Readonly<Record<PanelMode, Surface>>;
	private readonly viewfinder: ViewfinderSurface;
	private readonly transcript: Transcript;
	private readonly render: () => void;
	private readonly quit: () => void;

	constructor(parts: KeyParts) {
		this.renderer = parts.renderer;
		this.session = parts.session;
		this.composer = parts.composer;
		this.palette = parts.palette;
		this.painter = parts.painter;
		this.surfaces = parts.surfaces;
		this.viewfinder = parts.viewfinder;
		this.transcript = parts.transcript;
		this.render = parts.render;
		this.quit = parts.quit;
	}

	/** Recompute the palette rows. The palette closes outside compose mode. */
	refreshPalette(): void {
		this.palette.refresh(this.mode === 'compose', (text) => this.session.suggestions(text));
	}

	/** Keep the browse selection on a discussion that still exists, and the viewfinder in its slot. */
	reconcile(): void {
		this.layoutViewfinder();
		const keys = discussionKeys(this.session.blocks);
		if (this.browsing && !keys.includes(this.browsing)) this.browsing = keys.at(-1);
		const ids = this.session.refItems.map((item) => item.id);
		if (this.picking && !ids.includes(this.picking)) this.picking = ids.at(-1);
		if (this.mode === 'refs' && !this.picking) this.mode = 'browse';
	}

	// Routing

	onKey(key: KeyEvent): void {
		if (this.controlKey(key)) return;
		if (isPanel(this.mode)) {
			this.surfaces[this.mode].onKey(key, () => this.closePanel());
			return;
		}
		if (key.name === 'pageup' || key.name === 'pagedown') {
			const page = Math.max(4, this.transcript.root.height - 2);
			this.transcript.scrollBy(key.name === 'pageup' ? -page : page);
			return;
		}
		if (this.mode === 'browse') this.browseKey(key);
		else if (this.mode === 'refs') this.refsKey(key);
		else this.composeKey(key);
	}

	/**
	 * Ctrl+C and Ctrl+D. True when the key is handled. Ctrl+D leaves only from
	 * the composer, because a panel and the discussions use it to scroll.
	 */
	private controlKey(key: KeyEvent): boolean {
		if (!key.ctrl || key.shift || key.meta) return false;
		const leaves = key.name === 'd' && this.mode === 'compose' && this.composer.text === '';
		if (key.name !== 'c' && !leaves) return false;
		key.preventDefault();
		if (leaves) this.quit();
		else this.interrupt();
		return true;
	}

	/**
	 * Ctrl+C closes a side panel and keeps the draft. In the other modes it
	 * clears the composer, and it cancels a new room that waits for its goal.
	 * It does not quit.
	 */
	private interrupt(): void {
		if (isPanel(this.mode)) {
			this.closePanel();
			return;
		}
		const hadText = this.composer.text !== '';
		this.composer.setText('');
		this.palette.revive();
		this.session.interrupt(hadText);
		this.render();
	}

	// The side panels

	/** Open the files panel. A narrow terminal gives it the whole width. */
	openFiles(): void {
		this.openPanel('files');
	}

	/** Open the processes panel, and read the processes. A narrow terminal gives it the whole width. */
	openProcesses(): void {
		this.openPanel('processes');
	}

	/**
	 * Open the viewfinder when it is closed, and close it when it is open. The
	 * composer keeps the keys. A side panel covers the viewfinder while it is open.
	 */
	toggleCamera(): void {
		this.finderWanted = !this.finderWanted;
		if (this.finderWanted && this.renderer.width < NARROW)
			this.session.say(
				`The viewfinder shows when the terminal is at least ${NARROW} columns wide.`,
			);
		this.render();
	}

	/** End the open side panel and the viewfinder without drawing, when the terminal ends. Their polls and timers stop. */
	release(): void {
		if (isPanel(this.mode)) this.surfaces[this.mode].release();
		this.finderWanted = false;
		this.viewfinder.release();
	}

	/**
	 * Show the viewfinder in the slot of the side panels. It shows when the person
	 * asked for it, no side panel is open, and the terminal is wide. Otherwise it
	 * hides, and its poll stops until it shows again.
	 */
	private layoutViewfinder(): void {
		const shown = this.finderWanted && !isPanel(this.mode) && this.renderer.width >= NARROW;
		if (!shown) {
			if (this.viewfinder.shown) this.viewfinder.hide();
			return;
		}
		this.viewfinder.show();
		this.viewfinder.fill(false);
		this.viewfinder.draw();
	}

	private openPanel(mode: PanelMode): void {
		const surface = this.surfaces[mode];
		// The surface opens first, so the first draw shows the panel.
		surface.open();
		if (!isPanel(this.mode)) this.origin = this.mode;
		else if (this.mode !== mode) this.hidePanel();
		this.mode = mode;
		this.composer.blur();
		const roomy = this.renderer.width >= NARROW;
		this.transcript.root.visible = roomy;
		surface.fill(!roomy);
		this.render();
	}

	/** Hide the open side panel. */
	private hidePanel(): void {
		if (isPanel(this.mode)) this.surfaces[this.mode].hide();
	}

	private closePanel(): void {
		this.hidePanel();
		this.transcript.root.visible = true;
		this.mode = this.origin;
		if (this.mode === 'compose') this.composer.focus();
		this.painter.invalidate();
		this.render();
	}

	// Discussions

	private enterBrowse(): void {
		const keys = discussionKeys(this.session.blocks);
		if (keys.length === 0) {
			this.session.say('No discussions to browse yet.');
			return;
		}
		this.mode = 'browse';
		this.browsing = this.browsing && keys.includes(this.browsing) ? this.browsing : keys.at(-1);
		this.composer.blur();
		this.painter.revealNext(this.browsing);
		this.painter.invalidate();
		this.render();
	}

	private exitBrowse(): void {
		if (this.mode !== 'browse') return;
		this.mode = 'compose';
		this.composer.focus();
		this.painter.invalidate();
		this.render();
	}

	private move(step: number): void {
		const keys = discussionKeys(this.session.blocks);
		const at = this.browsing ? keys.indexOf(this.browsing) : -1;
		this.browsing = keys[Math.max(0, Math.min(keys.length - 1, at + step))];
		this.painter.revealNext(this.browsing);
		this.render();
	}

	private toggle(key: string): void {
		this.painter.revealNext(key);
		this.session.toggle(key);
	}

	private setAllOpen(open: boolean): void {
		// Opening everything grows the content above the selection, so keep it in view.
		this.painter.revealNext(this.browsing);
		this.session.setAllOpen(open);
	}

	private browseKey(key: KeyEvent): void {
		key.preventDefault();
		const name = key.name;
		const step = BROWSE_STEP[name];
		if (step) this.move(step);
		else if ((name === 'return' || name === 'space') && this.browsing) this.toggle(this.browsing);
		else if (name === 'e' || name === 'c') this.setAllOpen(name === 'e');
		else this.browseOther(name);
	}

	private browseOther(name: string): void {
		if (name === 's' && this.browsing) void this.session.showSteps(this.browsing);
		else if (name === 'r') this.enterRefs();
		else if (name === 'tab' || name === 'escape' || name === 'i') this.exitBrowse();
	}

	// Refs

	private enterRefs(): void {
		const items = this.session.refItems;
		if (items.length === 0) {
			this.session.say('No shown message has a ref. Press e to open every discussion.');
			return;
		}
		this.mode = 'refs';
		this.picking =
			this.picking && items.some((item) => item.id === this.picking)
				? this.picking
				: items.at(-1)?.id;
		this.painter.invalidate();
		this.render();
	}

	private exitRefs(): void {
		this.mode = 'browse';
		this.session.clearFocus();
		this.painter.invalidate();
		this.render();
	}

	private moveRef(step: number): void {
		const ids = this.session.refItems.map((item) => item.id);
		const at = this.picking ? ids.indexOf(this.picking) : -1;
		this.picking = ids[Math.max(0, Math.min(ids.length - 1, at + step))];
		this.session.clearFocus();
		this.render();
	}

	/** Open the chosen ref. A message ref jumps, and a file or a table opens the panel. */
	private async openPicked(): Promise<void> {
		const picked = this.session.refItems.find((item) => item.id === this.picking);
		if (picked?.resolved.target?.kind === 'message')
			this.painter.revealMessage(picked.resolved.target.seq);
		const intent = this.picking ? await this.session.openRef(this.picking) : undefined;
		if (intent) this.openFiles();
	}

	private refsKey(key: KeyEvent): void {
		key.preventDefault();
		const name = key.name;
		const step = BROWSE_STEP[name];
		if (step) this.moveRef(step);
		else if (name === 'return' || name === 'space') void this.openPicked();
		else if (name === 'escape' || name === 'r' || name === 'tab') this.exitRefs();
	}

	// The composer

	private composeKey(key: KeyEvent): void {
		if (key.ctrl && key.name === 'r') {
			key.preventDefault();
			this.palette.revive();
			this.composer.setText('/room ');
		} else if (key.name === 'tab') {
			key.preventDefault();
			if (this.palette.open) this.palette.complete();
			else this.enterBrowse();
		} else if (key.name === 'escape' && this.session.awaitingGoal) {
			key.preventDefault();
			this.session.cancelWaiting();
			this.composer.setText('');
		} else if (this.palette.open) this.paletteKey(key);
	}

	private paletteKey(key: KeyEvent): void {
		if (key.name === 'up' || key.name === 'down') {
			key.preventDefault();
			this.palette.move(key.name === 'up' ? -1 : 1);
		} else if (key.name === 'escape') {
			key.preventDefault();
			this.palette.dismiss();
			this.refreshPalette();
		}
	}
}
