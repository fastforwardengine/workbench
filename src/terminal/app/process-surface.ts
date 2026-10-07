import type { KeyEvent } from '@opentui/core';
import { type Act, actOf } from '../state/keymap.ts';
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
	private readonly acts: Record<Act<'processes'>, (close: () => void) => void> = {
		up: () => this.browser.move(-1),
		down: () => this.browser.move(1),
		pageUp: () => this.panel.scrollBy(-this.panel.page),
		pageDown: () => this.panel.scrollBy(this.panel.page),
		cancel: () => void this.browser.cancel(),
		copy: () => this.copyOutput(),
		close: (close) => close(),
	};

	onKey(key: KeyEvent, close: () => void): void {
		key.preventDefault();
		const act = actOf('processes', key);
		if (act) this.acts[act](close);
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
