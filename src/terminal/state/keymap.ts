/** A key as the terminal reports it. A missing modifier counts as not pressed. */
export interface KeyInput {
	readonly name: string;
	readonly ctrl?: boolean;
	readonly meta?: boolean;
	readonly shift?: boolean;
}

/**
 * One key with its modifiers. A missing `ctrl` or `meta` means the key comes
 * without it. Shift counts only when the chord names it: a chord with no
 * `shift` matches the key with or without Shift.
 */
export interface Chord {
	readonly name: string;
	readonly ctrl?: boolean;
	readonly meta?: boolean;
	readonly shift?: boolean;
}

/** What the keys do: the chords that trigger it, and one sentence for the keys sheet. */
export interface Binding {
	readonly keys: readonly Chord[];
	readonly does: string;
}

/** The bindings of one part of the terminal, in the order of the keys sheet. */
interface Section {
	readonly title: string;
	readonly note?: string;
	readonly bindings: Readonly<Record<string, Binding>>;
}

const UP = { name: 'up' } as const;
const DOWN = { name: 'down' } as const;
const K = { name: 'k' } as const;
const J = { name: 'j' } as const;
const Q = { name: 'q' } as const;
const ENTER = { name: 'return' } as const;
const SPACE = { name: 'space' } as const;
const F13 = { name: 'f13' } as const;
const ESC = { name: 'escape' } as const;
const PAGE_UP = { name: 'pageup' } as const;
const PAGE_DOWN = { name: 'pagedown' } as const;

/**
 * Every key of the terminal. The handlers read this table through `actOf`, and
 * the keys sheet draws it, so the two cannot differ. A section names the part of
 * the terminal that owns the keys, and a binding names one act of that part.
 */
export const KEYMAP = {
	composer: {
		title: 'Composer',
		bindings: {
			send: { keys: [{ name: 'return', shift: false }], does: 'Send the message' },
			newline: {
				keys: [
					{ name: 'linefeed' },
					{ name: 'return', shift: true },
					{ name: 'return', meta: true },
				],
				does: 'Add a line',
			},
			keys: {
				keys: [{ name: '?' }],
				does: 'Open this sheet, or close it while it shows, on an empty composer',
			},
			dock: {
				keys: [{ name: 'o', ctrl: true }],
				does: 'Give the keys to the dock, while a layer is open',
			},
			talk: {
				keys: [SPACE, F13],
				does: 'In voice mode, hold Space on an empty composer, or F13 in any mode, to talk, and let go to send',
			},
			tab: {
				keys: [{ name: 'tab' }],
				does: 'Complete a command, or choose a ref, a system row, or an activation line of the conversation',
			},
			up: { keys: [UP], does: 'Choose the row above, in the palette' },
			down: { keys: [DOWN], does: 'Choose the row below, in the palette' },
			escape: {
				keys: [ESC],
				does: 'Close the palette, cancel a new room, or close the top layer of the dock',
			},
			rooms: { keys: [{ name: 'r', ctrl: true }], does: 'List the rooms' },
			actions: {
				keys: [{ name: 'l', ctrl: true }],
				does: 'Choose a camera action, such as Look now',
			},
		},
	},
	conversation: {
		title: 'Conversation',
		bindings: {
			pageUp: { keys: [PAGE_UP], does: 'Scroll the conversation up' },
			pageDown: { keys: [PAGE_DOWN], does: 'Scroll the conversation down' },
		},
	},
	everywhere: {
		title: 'Everywhere',
		bindings: {
			interrupt: {
				keys: [{ name: 'c', ctrl: true, shift: false }],
				does: 'Clear the composer, drop a recording, or close the top layer of the dock',
			},
			quit: {
				keys: [{ name: 'd', ctrl: true, shift: false }],
				does: 'Leave the terminal: press twice, from an empty composer',
			},
		},
	},
	refs: {
		title: 'Refs',
		bindings: {
			up: { keys: [UP, K], does: 'Choose the ref, the system row, or the activation line above' },
			down: {
				keys: [DOWN, J],
				does: 'Choose the ref, the system row, or the activation line below',
			},
			open: {
				keys: [ENTER, SPACE],
				does: 'Open the ref, show the system message in full, or expand the activation line to its steps, and fold it again',
			},
			back: { keys: [ESC, { name: 'r' }, { name: 'tab' }], does: 'Go back to the composer' },
		},
	},
	actions: {
		title: 'Camera actions',
		bindings: {
			up: { keys: [UP, K], does: 'Choose the action above' },
			down: { keys: [DOWN, J], does: 'Choose the action below' },
			press: { keys: [ENTER, SPACE], does: 'Press the action' },
			back: { keys: [ESC, Q], does: 'Go back to the composer' },
		},
	},
	dock: {
		title: 'Dock',
		note: 'Files, processes, keys, and camera are layers of the dock. A new layer opens on top. Files, processes, and keys take the keys when they open. The camera leaves them with the composer. Esc in the composer closes the top layer.',
		bindings: {
			leave: { keys: [{ name: 'o', ctrl: true }], does: 'Give the keys back to the composer' },
			cycle: { keys: [{ name: 'tab' }], does: 'Show the next layer' },
			actions: {
				keys: [{ name: 'l', ctrl: true }],
				does: 'Choose a camera action, while the camera layer is on top',
			},
		},
	},
	files: {
		title: 'Files layer',
		note: 'Type to search.',
		bindings: {
			up: { keys: [UP], does: 'Choose the file above' },
			down: { keys: [DOWN], does: 'Choose the file below' },
			open: {
				keys: [ENTER],
				does: 'Close the layer and focus the newest message that cites the file',
			},
			previousTable: {
				keys: [{ name: 'left' }],
				does: 'Choose the previous table, when the file has more than one',
			},
			nextTable: { keys: [{ name: 'right' }], does: 'Choose the next table' },
			pageUp: { keys: [PAGE_UP], does: 'Scroll the file up' },
			pageDown: { keys: [PAGE_DOWN], does: 'Scroll the file down' },
			erase: { keys: [{ name: 'backspace' }], does: 'Delete a character of the search' },
			clearSearch: { keys: [{ name: 'u', ctrl: true }], does: 'Clear the search' },
			copy: { keys: [{ name: 'y', ctrl: true }], does: 'Copy the file' },
			back: { keys: [ESC], does: 'Clear the search, then give the keys back to the composer' },
		},
	},
	processes: {
		title: 'Processes layer',
		bindings: {
			up: { keys: [UP, K], does: 'Choose the process above' },
			down: { keys: [DOWN, J], does: 'Choose the process below' },
			pageUp: { keys: [PAGE_UP], does: 'Scroll the output up' },
			pageDown: { keys: [PAGE_DOWN], does: 'Scroll the output down' },
			cancel: { keys: [{ name: 'x' }], does: 'Cancel the chosen process. Press it twice' },
			copy: { keys: [{ name: 'y', ctrl: true }], does: 'Copy the output' },
			back: { keys: [ESC], does: 'Give the keys back to the composer' },
			close: { keys: [Q], does: 'Close the layer' },
		},
	},
	camera: {
		title: 'Camera layer',
		note: 'The composer keeps the keys when the layer opens.',
		bindings: {
			back: { keys: [ESC], does: 'Give the keys back to the composer' },
			close: { keys: [Q], does: 'Close the layer' },
		},
	},
	sheet: {
		title: 'Keys layer',
		bindings: {
			up: { keys: [UP, K], does: 'Scroll up' },
			down: { keys: [DOWN, J], does: 'Scroll down' },
			pageUp: { keys: [PAGE_UP], does: 'Scroll a page up' },
			pageDown: { keys: [PAGE_DOWN], does: 'Scroll a page down' },
			back: { keys: [ESC], does: 'Give the keys back to the composer' },
			close: { keys: [{ name: '?' }, Q], does: 'Close the layer' },
		},
	},
} as const satisfies Record<string, Section>;

/** A part of the terminal that owns keys: a section of the table. */
export type Scope = keyof typeof KEYMAP;

/** The acts of one scope. A handler table typed over this has one entry for each binding. */
export type Act<S extends Scope> = keyof (typeof KEYMAP)[S]['bindings'] & string;

/** True when the key is the chord. Shift counts only when the chord names it. */
export function matches(chord: Chord, key: KeyInput): boolean {
	return (
		chord.name === key.name &&
		(chord.ctrl ?? false) === (key.ctrl ?? false) &&
		(chord.meta ?? false) === (key.meta ?? false) &&
		(chord.shift === undefined || chord.shift === (key.shift ?? false))
	);
}

/** The act of the first binding in the scope that the key triggers, or undefined. */
export function actOf<S extends Scope>(scope: S, key: KeyInput): Act<S> | undefined {
	const bindings: Readonly<Record<string, Binding>> = KEYMAP[scope].bindings;
	for (const [act, binding] of Object.entries(bindings))
		if (binding.keys.some((chord) => matches(chord, key))) return act as Act<S>;
	return undefined;
}

/** How a key name reads on the keys sheet. A name that is not here reads as it is. */
const NAMES: ReadonlyMap<string, string> = new Map([
	['return', 'Enter'],
	['linefeed', 'Ctrl+J'],
	['escape', 'Esc'],
	['pageup', 'PgUp'],
	['pagedown', 'PgDn'],
	['up', '↑'],
	['down', '↓'],
	['left', '←'],
	['right', '→'],
	['space', 'Space'],
	['f13', 'F13'],
	['tab', 'Tab'],
	['backspace', 'Backspace'],
]);

/** The label of a chord, such as `Ctrl+R`, `Enter`, or `Alt+Enter`. */
export function keyLabel(chord: Chord): string {
	const prefix = `${chord.ctrl ? 'Ctrl+' : ''}${chord.meta ? 'Alt+' : ''}${chord.shift ? 'Shift+' : ''}`;
	const name = chord.ctrl && chord.name.length === 1 ? chord.name.toUpperCase() : undefined;
	return `${prefix}${name ?? NAMES.get(chord.name) ?? chord.name}`;
}

/** The labels of the chords of a binding, side by side. */
export function bindingLabel(binding: Binding): string {
	return binding.keys.map(keyLabel).join(' ');
}
