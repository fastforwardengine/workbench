/** The text that starts a message sent by voice. The terminal adds it, and the Speaking rules name it. */
export const VOICE_MARK = '(voice) ';

/** The tag that opens a span of words to read aloud. */
export const VOICE_OPEN = '<voice>';

/** The tag that closes a span of words to read aloud. */
export const VOICE_CLOSE = '</voice>';

/** A tag that stands alone on its line, with the line break after it. */
const TAG_LINE = new RegExp(`^[ \\t]*(?:${VOICE_OPEN}|${VOICE_CLOSE})[ \\t]*(?:\\r?\\n|$)`, 'gm');

/** One part of a message: a voice span, or the text outside the voice spans. */
export interface VoicePart {
	/** True for the text inside a voice span. */
	voice: boolean;
	text: string;
}

/**
 * The parts of a message, in order: each voice span, and the text between the
 * spans. An open tag with no close tag runs to the end of the text. A close
 * tag with no open tag is removed. A part that holds only white space is
 * dropped.
 */
export function voiceParts(text: string): VoicePart[] {
	const parts: VoicePart[] = [];
	const add = (voice: boolean, raw: string): void => {
		const clean = raw.split(voice ? VOICE_OPEN : VOICE_CLOSE).join('');
		if (clean.trim() !== '') parts.push({ voice, text: clean });
	};
	let from = 0;
	let open = text.indexOf(VOICE_OPEN);
	while (open !== -1) {
		add(false, text.slice(from, open));
		const start = open + VOICE_OPEN.length;
		const close = text.indexOf(VOICE_CLOSE, start);
		add(true, text.slice(start, close === -1 ? text.length : close));
		from = close === -1 ? text.length : close + VOICE_CLOSE.length;
		open = close === -1 ? -1 : text.indexOf(VOICE_OPEN, from);
	}
	add(false, text.slice(from));
	return parts;
}

/** The text inside each voice span, in order. */
export function voiceSpans(text: string): string[] {
	return voiceParts(text).flatMap((part) => (part.voice ? [part.text] : []));
}

/**
 * The text with every voice tag removed and the content kept. A tag that
 * stands alone on its line leaves no empty line in its place.
 */
export function withoutVoiceTags(text: string): string {
	return text.replace(TAG_LINE, '').split(VOICE_OPEN).join('').split(VOICE_CLOSE).join('');
}
