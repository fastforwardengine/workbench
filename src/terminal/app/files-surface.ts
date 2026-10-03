import type { KeyEvent } from '@opentui/core';
import type { FileBrowser } from '../state/browser.ts';
import type { FilesPanel } from '../widgets/files-panel.ts';
import type { Surface } from './surface.ts';

/** What one key does in the files panel. `close` shuts the panel. */
type Action = (close: () => void) => void;

/** The files panel and its keys. */
export class FilesSurface implements Surface {
	readonly status = 'Browsing the workspace files. Esc closes the panel.';
	private readonly browser: FileBrowser;
	private readonly panel: FilesPanel;

	constructor(browser: FileBrowser, panel: FilesPanel) {
		this.browser = browser;
		this.panel = panel;
	}

	get root() {
		return this.panel.root;
	}

	/** The session shows the browser, with the file to choose, before the keys open the panel. */
	open(): void {}

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

	/** What each key does. Any other printable key adds to the search. */
	private readonly keys: Record<string, Action> = {
		up: () => this.browser.move(-1),
		down: () => this.browser.move(1),
		left: () => this.browser.moveTab(-1),
		right: () => this.browser.moveTab(1),
		pageup: () => this.panel.scrollBy(-this.panel.page),
		pagedown: () => this.panel.scrollBy(this.panel.page),
		// Esc clears the search first, then closes the panel.
		escape: (close) => (this.browser.query ? this.browser.clear() : close()),
		backspace: () => this.browser.backspace(),
	};

	private readonly controlKeys: Record<string, Action> = {
		y: () => this.copy(),
		u: () => this.browser.clear(),
	};

	onKey(key: KeyEvent, close: () => void): void {
		key.preventDefault();
		const action = key.ctrl ? this.controlKeys[key.name] : this.keys[key.name];
		if (action) action(close);
		else if (!key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= ' ')
			this.browser.type(key.sequence);
	}

	private copy(): void {
		const text = this.browser.file?.text;
		if (text === undefined) return;
		this.panel.flash(
			this.panel.copy(text)
				? 'Copied to the clipboard.'
				: 'This terminal does not accept a clipboard copy.',
		);
	}
}
