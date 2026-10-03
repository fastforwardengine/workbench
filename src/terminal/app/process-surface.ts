import type { KeyEvent } from '@opentui/core';
import type { ProcessBrowser } from '../state/process-browser.ts';
import type { ProcessesPanel } from '../widgets/process-panel.ts';
import type { Surface } from './surface.ts';

/** The processes panel and its keys. */
export class ProcessesSurface implements Surface {
	readonly status = 'Watching the background processes. Esc closes the panel.';
	private readonly browser: ProcessBrowser;
	private readonly panel: ProcessesPanel;
	private readonly render: () => void;

	/** `render` redraws the terminal after a change that the keys make outside the browser. */
	constructor(browser: ProcessBrowser, panel: ProcessesPanel, render: () => void) {
		this.browser = browser;
		this.panel = panel;
		this.render = render;
	}

	get root() {
		return this.panel.root;
	}

	/** Open the browser, so the first draw shows the panel, and read the processes. */
	open(): void {
		void this.browser.show();
	}

	hide(): void {
		this.browser.hide();
		this.panel.draw(this.browser);
	}

	release(): void {
		this.browser.hide();
	}

	draw(): void {
		this.panel.draw(this.browser);
	}

	fill(whole: boolean): void {
		this.panel.fill(whole);
	}

	/** What each key does. */
	private readonly keys: Record<string, (close: () => void) => void> = {
		up: () => this.browser.move(-1),
		k: () => this.browser.move(-1),
		down: () => this.browser.move(1),
		j: () => this.browser.move(1),
		pageup: () => this.panel.scrollBy(-this.panel.page),
		pagedown: () => this.panel.scrollBy(this.panel.page),
		x: () => void this.browser.cancel(),
		escape: (close) => close(),
		q: (close) => close(),
	};

	onKey(key: KeyEvent, close: () => void): void {
		key.preventDefault();
		if (key.ctrl && key.name === 'y') this.copyOutput();
		else if (!key.ctrl && !key.meta) this.keys[key.name]?.(close);
	}

	private copyOutput(): void {
		const text = this.browser.output?.text;
		if (!text) return;
		this.browser.message = this.panel.copy(text)
			? 'Copied the output to the clipboard.'
			: 'This terminal does not accept a clipboard copy.';
		this.render();
	}
}
