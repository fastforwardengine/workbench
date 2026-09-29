import type { BoxRenderable, KeyEvent } from '@opentui/core';

/**
 * A side panel and the keys that drive it. The terminal opens, draws, and
 * closes every panel through this interface, so a new panel is one file that
 * implements it, and one entry in the terminal's table of surfaces.
 */
export interface Surface {
	/** The box of the panel. The terminal puts it beside the conversation. */
	readonly root: BoxRenderable;
	/** What the status line says while the panel is open. */
	readonly status: string;
	/** Make the panel ready to draw. It runs before the panel takes the keys. */
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
