import type { KeyEvent } from '@opentui/core';
import { type Act, actOf } from '../state/keymap.ts';
import type { KeysPanel } from '../widgets/keys-panel.ts';
import type { Exits, Surface } from './surface.ts';

/** The keys layer: the keys sheet and its keys. */
export class KeysSurface implements Surface {
	readonly status = 'Reading the keys. Esc returns to the composer.';
	readonly narrow = true;
	readonly takesKeys = true;
	private readonly panel: KeysPanel;

	constructor(panel: KeysPanel) {
		this.panel = panel;
	}

	get root() {
		return this.panel.root;
	}

	/** The sheet holds no state that needs a read, and it runs no work. */
	open(): void {}

	show(): void {}

	hide(): void {}

	/** The sheet is the same at each draw. */
	draw(): void {}

	/** What each key does. */
	private readonly acts: Record<Act<'sheet'>, (exits: Exits) => void> = {
		up: () => this.panel.scrollBy(-1),
		down: () => this.panel.scrollBy(1),
		pageUp: () => this.panel.scrollBy(-this.panel.page),
		pageDown: () => this.panel.scrollBy(this.panel.page),
		back: (exits) => exits.back(),
		close: (exits) => exits.close(),
	};

	onKey(key: KeyEvent, exits: Exits): void {
		key.preventDefault();
		const act = actOf('sheet', key);
		if (act) this.acts[act](exits);
	}
}
