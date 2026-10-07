/** The mark before the room when the room waits for the person. */
export const WAITS_MARK = '◆';

/** The mark before the room when a seat works, or a message goes out. */
export const WORKS_MARK = '●';

/** The part of the session that the title reads. The `Session` fits it. */
export interface TitleSource {
	identity: object | undefined;
	room: string;
	/** The replies that the room waits for from the person. */
	attention: readonly string[];
	working: { seat: string } | undefined;
	sending: boolean;
}

/**
 * The title of the terminal window. With a person and an open room, it starts
 * with the room and one mark for the state: a reply that waits for the person,
 * a seat that works, or a message that goes out. A reply that waits comes
 * before the other two. An idle room shows its name alone. Without a person or a room,
 * the title is the product name.
 */
export function titleOf(source: TitleSource, product: string): string {
	if (!source.identity || !source.room) return product;
	const { room, working } = source;
	if (source.attention.length > 0) return `${WAITS_MARK} ${room} — ${product}`;
	if (working) return `${WORKS_MARK} ${room} · ${working.seat} — ${product}`;
	if (source.sending) return `${WORKS_MARK} ${room} — ${product}`;
	return `${room} — ${product}`;
}

/**
 * The write of the title to the terminal. It writes when the text differs from
 * the text it wrote last, so a repaint that changes nothing writes nothing.
 */
export class TerminalTitle {
	private shown: string | undefined;
	private readonly write: (text: string) => void;

	constructor(write: (text: string) => void) {
		this.write = write;
	}

	show(text: string): void {
		if (text === this.shown) return;
		this.shown = text;
		this.write(text);
	}
}
