/** The text that starts a message sent by voice. The terminal adds it, and the Speaking rules name it. */
export const VOICE_MARK = '(voice) ';

/** The tag that opens a span of words to read aloud. */
export const VOICE_OPEN = '<voice>';

/** The tag that closes a span of words to read aloud. */
export const VOICE_CLOSE = '</voice>';

/** Every voice tag, in the order it stands in a text. */
const TAG = new RegExp(`${VOICE_OPEN}|${VOICE_CLOSE}`, 'g');

/** A line that opens or closes a fenced code block. */
const FENCE = /^\s*(?:`{3,}|~{3,})/;

/** One voice tag in a text. */
interface Tag {
	/** The index of the first character of the tag. */
	at: number;
	/** True for an open tag, and false for a close tag. */
	open: boolean;
}

/** The index range of each inline code span of a line. A span opens and closes with a run of ticks of the same length. */
function codeRanges(line: string): [number, number][] {
	const runs = [...line.matchAll(/`+/g)];
	const ranges: [number, number][] = [];
	for (let at = 0; at < runs.length; at += 1) {
		const open = runs[at];
		const closeAt = runs.findIndex((run, next) => next > at && run[0].length === open?.[0].length);
		const close = runs[closeAt];
		if (!open || !close) continue;
		ranges.push([open.index ?? 0, (close.index ?? 0) + close[0].length]);
		at = closeAt;
	}
	return ranges;
}

/** The tags of one line that stand outside inline code. `offset` is the index of the line in its text. */
function lineTags(line: string, offset: number): Tag[] {
	const code = codeRanges(line);
	return [...line.matchAll(TAG)].flatMap((match) => {
		const at = match.index ?? 0;
		const inCode = code.some(([from, to]) => at >= from && at < to);
		return inCode ? [] : [{ at: offset + at, open: match[0] === VOICE_OPEN }];
	});
}

/** The tags of a text, in order. A tag inside a fenced code block or an inline code span is text. */
function scanTags(text: string): Tag[] {
	const tags: Tag[] = [];
	let fenced = false;
	let offset = 0;
	for (const line of text.split('\n')) {
		if (FENCE.test(line)) fenced = !fenced;
		else if (!fenced) tags.push(...lineTags(line, offset));
		offset += line.length + 1;
	}
	return tags;
}

/** The length of a tag. */
const lengthOf = (tag: Tag): number => (tag.open ? VOICE_OPEN.length : VOICE_CLOSE.length);

/** One part of a message: a voice span, or the text outside the voice spans. */
export interface VoicePart {
	/** True for the text inside a voice span. */
	voice: boolean;
	text: string;
}

/** The text from `from` up to `to`, without the tags that stand in it. */
function sliceWithoutTags(text: string, tags: readonly Tag[], from: number, to: number): string {
	let kept = '';
	let at = from;
	for (const tag of tags) {
		if (tag.at < from || tag.at >= to) continue;
		kept += text.slice(at, tag.at);
		at = tag.at + lengthOf(tag);
	}
	return kept + text.slice(at, to);
}

/**
 * The parts of a message, in order: each voice span, and the text between the
 * spans. An open tag with no close tag runs to the end of the text. A close
 * tag with no open tag is removed and does not start a span. A tag inside
 * code is text. A part that holds only white space is dropped.
 */
export function voiceParts(text: string): VoicePart[] {
	const tags = scanTags(text);
	const parts: VoicePart[] = [];
	const add = (voice: boolean, from: number, to: number): void => {
		const clean = sliceWithoutTags(text, tags, from, to);
		if (clean.trim() !== '') parts.push({ voice, text: clean });
	};
	let from = 0;
	let spanFrom: number | undefined;
	for (const tag of tags) {
		if (spanFrom === undefined && tag.open) {
			add(false, from, tag.at);
			spanFrom = tag.at + VOICE_OPEN.length;
		} else if (spanFrom !== undefined && !tag.open) {
			add(true, spanFrom, tag.at);
			from = tag.at + VOICE_CLOSE.length;
			spanFrom = undefined;
		}
	}
	if (spanFrom !== undefined) add(true, spanFrom, text.length);
	else add(false, from, text.length);
	return parts;
}

/** The text inside each voice span, in order. */
export function voiceSpans(text: string): string[] {
	return voiceParts(text).flatMap((part) => (part.voice ? [part.text] : []));
}

/** The index range to remove for a tag: the tag, or its whole line when the tag stands alone on it. */
function removal(text: string, tag: Tag): [number, number] {
	const end = tag.at + lengthOf(tag);
	const lineStart = text.lastIndexOf('\n', tag.at - 1) + 1;
	const newline = text.indexOf('\n', end);
	const lineEnd = newline === -1 ? text.length : newline;
	const alone =
		text.slice(lineStart, tag.at).trim() === '' && text.slice(end, lineEnd).trim() === '';
	if (!alone) return [tag.at, end];
	return [lineStart, newline === -1 ? lineEnd : lineEnd + 1];
}

/**
 * The text with every voice tag removed and the content kept. A tag that
 * stands alone on its line leaves no empty line in its place. A tag inside
 * code stays.
 */
export function withoutVoiceTags(text: string): string {
	let kept = '';
	let at = 0;
	for (const tag of scanTags(text)) {
		const [from, to] = removal(text, tag);
		if (from < at) continue;
		kept += text.slice(at, from);
		at = to;
	}
	return kept + text.slice(at);
}
