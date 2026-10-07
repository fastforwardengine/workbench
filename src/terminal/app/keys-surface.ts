import type { KeyEvent } from '@opentui/core';
import { type Act, actOf } from '../state/keymap.ts';
import type { KeysPanel } from '../widgets/keys-panel.ts';
import type { Surface } from './surface.ts';

/** The keys sheet and its keys. */
export class KeysSurface implements Surface {
	readonly status = 'Reading the keys. Esc closes the sheet.';
	private readonly panel: KeysPanel;

	constructor(panel: KeysPanel) {
		this.panel = panel;
	}

	get root() {
		return this.panel.root;
	}

	/** The sheet holds no state that needs a read. */
	open(): void {}

	hide(): void {
		this.panel.draw(false);
	}

	/** The sheet runs no work. */
	release(): void {}

	draw(): void {
		this.panel.draw(true);
	}

	fill(whole: boolean): void {
		this.panel.fill(whole);
	}

	/** What each key does. */
	private readonly acts: Record<Act<'sheet'>, (close: () => void) => void> = {
		up: () => this.panel.scrollBy(-1),
		down: () => this.panel.scrollBy(1),
		pageUp: () => this.panel.scrollBy(-this.panel.page),
		pageDown: () => this.panel.scrollBy(this.panel.page),
		close: (close) => close(),
	};

	onKey(key: KeyEvent, close: () => void): void {
		key.preventDefault();
		const act = actOf('sheet', key);
		if (act) this.acts[act](close);
	}
}
