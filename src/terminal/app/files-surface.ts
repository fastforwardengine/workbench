import type { KeyEvent } from '@opentui/core';
import type { FileBrowser } from '../state/browser.ts';
import { type Act, actOf } from '../state/keymap.ts';
import type { FilesPanel } from '../widgets/files-panel.ts';
import type { Exits, Surface } from './surface.ts';

/** The files layer and its keys. */
export class FilesSurface implements Surface {
	readonly status = 'Browsing the workspace files. Esc returns to the composer.';
	readonly narrow = true;
	readonly takesKeys = true;
	private readonly browser: FileBrowser;
	private readonly panel: FilesPanel;

	constructor(browser: FileBrowser, panel: FilesPanel) {
		this.browser = browser;
		this.panel = panel;
	}

	get root() {
		return this.panel.root;
	}

	/** The session shows the browser, with the file to choose, before the dock opens the layer. */
	open(): void {}

	show(): void {
		this.browser.resume();
	}

	hide(): void {
		this.browser.hide();
	}

	draw(): void {
		this.panel.draw(this.browser);
	}

	/** What each key does. */
	private readonly acts: Record<Act<'files'>, (exits: Exits) => void> = {
		up: () => this.browser.move(-1),
		down: () => this.browser.move(1),
		previousTable: () => this.browser.moveTab(-1),
		nextTable: () => this.browser.moveTab(1),
		pageUp: () => this.panel.scrollBy(-this.panel.page),
		pageDown: () => this.panel.scrollBy(this.panel.page),
		erase: () => this.browser.backspace(),
		clearSearch: () => this.browser.clear(),
		copy: () => this.copy(),
		// Esc clears the search first, then gives the keys back.
		back: (exits) => (this.browser.query ? this.browser.clear() : exits.back()),
	};

	/** Any other printable key adds to the search. */
	onKey(key: KeyEvent, exits: Exits): void {
		key.preventDefault();
		const act = actOf('files', key);
		if (act) this.acts[act](exits);
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
