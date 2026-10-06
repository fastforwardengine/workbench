import type { KittyKeyboardOptions } from '@opentui/core';

/**
 * The Kitty keyboard protocol flags that the terminal asks for. The `events`
 * flag reports key press, repeat, and release. A terminal sends a key that makes
 * text as plain text, with no event type, so the release of Space needs
 * `allKeysAsEscapes` too. `reportText` puts the text of each key in its escape
 * code, so the composer types what it typed before. Kitty and Ghostty support
 * the protocol.
 */
export const KEYBOARD: KittyKeyboardOptions = {
	events: true,
	allKeysAsEscapes: true,
	reportText: true,
};
