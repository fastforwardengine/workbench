import type { BoxRenderable, KeyEvent } from '@opentui/core';

/** What a layer asks of the terminal when a key ends its work. */
export interface Exits {
	/** Give the keys back to the composer. The layer stays open. */
	back(): void;
	/** Close the layer. The next layer shows. */
	close(): void;
}

/**
 * One layer of the dock and the keys that drive it. The dock opens, draws, and
 * closes every layer through this interface. A new layer implements it, adds its
 * id to `LAYERS` in `layers.ts`, and joins the table of surfaces in `tui.ts`. Keys
 * reaches it by a new `open` method and its intent.
 */
export interface Surface {
	/** The box of the layer. The dock draws it while the layer is on top. */
	readonly root: BoxRenderable;
	/** What the status line says while the layer has the keys. */
	readonly status: string;
	/** True when the layer takes the keys when it opens. A layer that only shows leaves them with the composer. */
	readonly takesKeys: boolean;
	/** True when the layer shows in a terminal that is too narrow for a dock beside the conversation. */
	readonly narrow: boolean;
	/**
	 * Open the layer on fresh state, and start its work. It runs first, before
	 * the first draw. A layer whose state comes from elsewhere does nothing here:
	 * the files layer shows its browser through the session, with the file to choose.
	 */
	open(): void;
	/** Start the work again after `hide`. The state of the layer stays. */
	show(): void;
	/**
	 * Stop the work of the layer, such as its polls and timers. The dock calls it
	 * when another layer rises, when the layer closes, and when the terminal ends.
	 * The state of the layer stays.
	 */
	hide(): void;
	/** Draw the state of the layer. */
	draw(): void;
	/** Handle one key. */
	onKey(key: KeyEvent, exits: Exits): void;
}
