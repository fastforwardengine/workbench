import type { KeyEvent } from '@opentui/core';
import { type Act, actOf } from '../state/keymap.ts';
import type { ProcessBrowser } from '../state/process-browser.ts';
import type { ProcessesPanel } from '../widgets/process-panel.ts';
import type { Exits, Surface } from './surface.ts';

/** The processes layer and its keys. */
export class ProcessesSurface implements Surface {
	readonly status = 'Watching the background processes. Esc returns to the composer.';
	readonly narrow = true;
	readonly takesKeys = true;
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

	/** Open the browser on a new list, so the first draw shows the layer, and read the processes. */
	open(): void {
		void this.browser.show();
	}

	/** Watch the processes again, and read the list. The choice stays. */
	show(): void {
		void this.browser.resume();
	}

	hide(): void {
		this.browser.hide();
	}

	draw(): void {
		this.panel.draw(this.browser);
	}

	/** What each key does. */
	private readonly acts: Record<Act<'processes'>, (exits: Exits) => void> = {
		up: () => this.browser.move(-1),
		down: () => this.browser.move(1),
		pageUp: () => this.panel.scrollBy(-this.panel.page),
		pageDown: () => this.panel.scrollBy(this.panel.page),
		cancel: () => void this.browser.cancel(),
		copy: () => this.copyOutput(),
		back: (exits) => exits.back(),
		close: (exits) => exits.close(),
	};

	onKey(key: KeyEvent, exits: Exits): void {
		key.preventDefault();
		const act = actOf('processes', key);
		if (act) this.acts[act](exits);
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
