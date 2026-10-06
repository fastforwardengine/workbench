import type { KeyEvent } from '@opentui/core';
import type { ViewfinderBrowser } from '../state/viewfinder-browser.ts';
import type { ViewfinderPanel } from '../widgets/viewfinder-panel.ts';

/**
 * The viewfinder pane. It shows beside the conversation while the composer keeps the
 * keyboard. It takes keys only while the person chooses an action of a camera.
 */
export class ViewfinderSurface {
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

	/** True while the pane shows. */
	get shown(): boolean {
		return this.browser.open;
	}

	/** True while the person chooses an action of a camera. */
	get acting(): boolean {
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
	show(): void {
		this.browser.show();
	}

	hide(): void {
		this.browser.hide();
		this.panel.draw(this.browser, this.graphics());
	}

	release(): void {
		this.browser.hide();
	}

	draw(): void {
		const kitty = this.graphics();
		this.browser.watch(kitty);
		this.panel.draw(this.browser, kitty);
	}

	fill(whole: boolean): void {
		this.panel.fill(whole);
	}
}
