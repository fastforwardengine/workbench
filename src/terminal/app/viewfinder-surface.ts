import type { KeyEvent } from '@opentui/core';
import { type Act, actOf } from '../state/keymap.ts';
import type { ViewfinderBrowser } from '../state/viewfinder-browser.ts';
import type { ViewfinderPanel } from '../widgets/viewfinder-panel.ts';
import type { Exits, Surface } from './surface.ts';

/**
 * The camera layer. It shows in the dock while the composer keeps the keyboard.
 * It takes keys only while the person chooses an action of a camera, or while
 * the person gives the keys to the dock. It does not show in a narrow terminal.
 */
export class ViewfinderSurface implements Surface {
	readonly status = 'Watching the cameras. Esc returns to the composer.';
	readonly narrow = false;
	readonly takesKeys = false;
	private readonly browser: ViewfinderBrowser;
	private readonly panel: ViewfinderPanel;
	private readonly graphics: () => boolean;

	/** `graphics` is true when the terminal draws Kitty graphics. The poll runs only then. */
	constructor(browser: ViewfinderBrowser, panel: ViewfinderPanel, graphics: () => boolean) {
		this.browser = browser;
		this.panel = panel;
		this.graphics = graphics;
	}

	get root() {
		return this.panel.root;
	}

	/** True while the person chooses an action of a camera. It reads the actions again first, so a lost action ends the choice. */
	acting(): boolean {
		this.browser.syncActions();
		return this.browser.pad.active;
	}

	/** Start the keys of the actions. False when no shown camera has an action. */
	enterActions(): boolean {
		this.browser.syncActions();
		return this.browser.pad.enter();
	}

	leaveActions(): void {
		this.browser.pad.leave();
	}

	/** Route one key to the actions. It returns `leave` when the person leaves them. */
	actionKey(key: KeyEvent): 'leave' | undefined {
		return this.browser.pad.key(key);
	}

	/** Open the browser. The first draw starts the poll. */
	open(): void {
		this.browser.show();
	}

	show(): void {
		this.browser.show();
	}

	hide(): void {
		this.browser.hide();
	}

	draw(): void {
		this.browser.watch(this.graphics());
		this.panel.draw(this.browser, this.graphics());
	}

	/** What each key does, while the dock has the keys. */
	private readonly acts: Record<Act<'camera'>, (exits: Exits) => void> = {
		back: (exits) => exits.back(),
		close: (exits) => exits.close(),
	};

	onKey(key: KeyEvent, exits: Exits): void {
		key.preventDefault();
		const act = actOf('camera', key);
		if (act) this.acts[act](exits);
	}
}
