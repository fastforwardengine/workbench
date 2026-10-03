import type { KeyEvent } from '@opentui/core';
import type { ViewfinderBrowser } from '../state/viewfinder-browser.ts';
import type { ViewfinderPanel } from '../widgets/viewfinder-panel.ts';
import type { Surface } from './surface.ts';

/** The viewfinder panel and its keys. */
export class ViewfinderSurface implements Surface {
	readonly status = 'Watching the camera. Esc closes the panel.';
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

	/** Open the browser. The first draw starts the poll. */
	open(): void {
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

	onKey(key: KeyEvent, close: () => void): void {
		key.preventDefault();
		if (!key.ctrl && !key.meta && (key.name === 'escape' || key.name === 'q')) close();
	}
}
