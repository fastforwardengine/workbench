import type { KittyKeyboardOptions } from '@opentui/core';

/**
 * The Kitty keyboard protocol flags that the terminal asks for: the default
 * flags and the key events. The events report the release of a key. Kitty and
 * Ghostty send the press and the repeats of a text key as plain text, and its
 * release as a `CSI u` code. The flags do not include "all keys as escape
 * codes": with it, macOS reports a character that Option types as an Alt key,
 * and the composer would lose it.
 */
export const KEYBOARD: KittyKeyboardOptions = { events: true };

/** What the terminal reports about itself. */
interface Reports {
	kitty_keyboard?: boolean;
}

/** Why voice mode cannot run in this terminal, or undefined. Voice mode needs the release of Space. */
export function keyboardProblem(capabilities: Reports | null | undefined): string | undefined {
	return capabilities?.kitty_keyboard
		? undefined
		: 'Voice mode needs a terminal that reports key release, such as Ghostty or Kitty.';
}
