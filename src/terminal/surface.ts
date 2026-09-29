import type { BoxRenderable, KeyEvent } from '@opentui/core';

/**
 * A side panel and the keys that drive it. The terminal opens, draws, and
 * closes every panel through this interface. A new panel implements it, adds
 * its mode to `PANELS` in `mode.ts`, and joins the table of surfaces and the
 * layout in `tui.ts`. Keys reaches it by a new `open` method and its intent.
 */
export interface Surface {
	/** The box of the panel. The terminal puts it beside the conversation. */
	readonly root: BoxRenderable;
	/** What the status line says while the panel is open. */
	readonly status: string;
	/**
	 * Make the panel ready to draw. It runs first, before the mode changes and
	 * before the first draw. A panel whose state comes from elsewhere does nothing
	 * here: the files panel shows its browser through the session, with the file to choose.
	 */
	open(): void;
	/** Close the state of the panel, and draw it hidden. */
	hide(): void;
	/** Draw the state of the panel. */
	draw(): void;
	/** Give the panel the whole width, or a share of it beside the conversation. */
	fill(whole: boolean): void;
	/** Handle one key. `close` shuts the panel. */
	onKey(key: KeyEvent, close: () => void): void;
}
