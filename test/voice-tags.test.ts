import { describe, expect, it } from 'vitest';
import {
	VOICE_CLOSE,
	VOICE_OPEN,
	voiceParts,
	voiceSpans,
	withoutVoiceTags,
} from '../src/domain/voice.ts';

describe('voiceParts', () => {
	it('splits a message into voice spans and the text between them, in order', () => {
		expect(
			voiceParts('Before.\n\n<voice>One.\n\nTwo.</voice>\n\nMiddle. <voice>Three.</voice> End.'),
		).toEqual([
			{ voice: false, text: 'Before.\n\n' },
			{ voice: true, text: 'One.\n\nTwo.' },
			{ voice: false, text: '\n\nMiddle. ' },
			{ voice: true, text: 'Three.' },
			{ voice: false, text: ' End.' },
		]);
	});

	it('gives one plain part for a text with no tag', () => {
		expect(voiceParts('Plain.')).toEqual([{ voice: false, text: 'Plain.' }]);
		expect(voiceParts('')).toEqual([]);
	});

	it('runs an open tag with no close tag to the end, and removes a stray close tag', () => {
		expect(voiceParts('Text</voice> <voice>Said.')).toEqual([
			{ voice: false, text: 'Text ' },
			{ voice: true, text: 'Said.' },
		]);
	});

	it('drops a part that holds only white space', () => {
		expect(voiceParts('<voice>\n</voice>\n\n<voice>Said.</voice>\n')).toEqual([
			{ voice: true, text: 'Said.' },
		]);
	});
});

describe('voice tags in code', () => {
	it('treats a tag inside an inline code span as text', () => {
		const text = '<voice>Put words in tags.</voice>\n\nWrite `<voice>` then `</voice>`.';
		expect(voiceParts(text)).toEqual([
			{ voice: true, text: 'Put words in tags.' },
			{ voice: false, text: '\n\nWrite `<voice>` then `</voice>`.' },
		]);
		expect(withoutVoiceTags(text)).toBe('Put words in tags.\n\nWrite `<voice>` then `</voice>`.');
	});

	it('treats a tag inside a double-tick span as text, and a tag after an unpaired tick as a tag', () => {
		expect(voiceParts('Use ``<voice>`` here.')).toEqual([
			{ voice: false, text: 'Use ``<voice>`` here.' },
		]);
		expect(voiceParts('A ` tick <voice>Said.</voice>')).toEqual([
			{ voice: false, text: 'A ` tick ' },
			{ voice: true, text: 'Said.' },
		]);
	});

	it('treats a tag inside a fenced block as text', () => {
		const text = '```\n<voice>hi</voice>\n```';
		expect(voiceParts(text)).toEqual([{ voice: false, text }]);
		expect(voiceSpans(text)).toEqual([]);
		expect(withoutVoiceTags(text)).toBe(text);
		const tilde = 'Before.\n~~~md\n<voice>hi</voice>\n~~~\n<voice>Said.</voice>';
		expect(voiceSpans(tilde)).toEqual(['Said.']);
	});

	it('keeps a close tag inside a fenced block in the span', () => {
		const text = '<voice>One.\n```\n</voice>\n```\nTwo.</voice>';
		expect(voiceSpans(text)).toEqual(['One.\n```\n</voice>\n```\nTwo.']);
	});
});

describe('voiceSpans', () => {
	it('gives the text of each span, in order', () => {
		expect(voiceSpans('<voice>One.</voice> Screen. <voice>Two.</voice>')).toEqual(['One.', 'Two.']);
	});

	it('keeps the paragraphs of one span', () => {
		const text = '<voice>One.\n\nTwo.</voice>\n\nDetails.';
		expect(voiceSpans(text)).toEqual(['One.\n\nTwo.']);
	});

	it('runs an open tag with no close tag to the end of the text', () => {
		expect(voiceSpans('<voice>One. Two.')).toEqual(['One. Two.']);
		expect(voiceSpans('<voice>One.</voice> <voice>Two.')).toEqual(['One.', 'Two.']);
	});

	it('ignores a close tag with no open tag', () => {
		expect(voiceSpans('Text</voice> more')).toEqual([]);
		expect(voiceSpans('Text</voice> <voice>Said.</voice>')).toEqual(['Said.']);
	});

	it('gives nothing for a text with no tag', () => {
		expect(voiceSpans('Plain text.')).toEqual([]);
		expect(voiceSpans('')).toEqual([]);
	});

	it('drops an empty span and a span of white space', () => {
		expect(voiceSpans('<voice></voice><voice> \n </voice><voice>Said.</voice>')).toEqual(['Said.']);
	});

	it('matches the tags exactly', () => {
		expect(
			voiceSpans('<Voice>No.</Voice> <voice id="a">No.</voice> < voice >No.</ voice >'),
		).toEqual([]);
	});

	it('removes an open tag inside a span', () => {
		expect(voiceSpans('<voice>One <voice>two</voice>')).toEqual(['One two']);
	});
});

describe('withoutVoiceTags', () => {
	it('keeps the content of an inline tag', () => {
		expect(withoutVoiceTags('<voice>On at 9 volts.</voice> Details.')).toBe(
			'On at 9 volts. Details.',
		);
	});

	it('removes a line that holds only a tag', () => {
		expect(withoutVoiceTags('<voice>\nOne.\n\nTwo.\n</voice>\n\nDetails.')).toBe(
			'One.\n\nTwo.\n\nDetails.',
		);
		expect(withoutVoiceTags('  <voice>  \r\nOne.\r\n</voice>\r\nMore.')).toBe('One.\r\nMore.');
	});

	it('removes a tag that has no partner', () => {
		expect(withoutVoiceTags('One.</voice>\n<voice>Two.')).toBe('One.\nTwo.');
	});

	it('leaves a text with no tag unchanged', () => {
		expect(withoutVoiceTags('Plain.\n\n- a list')).toBe('Plain.\n\n- a list');
	});

	it('removes a tag that ends the text on its own line', () => {
		expect(withoutVoiceTags('One.\n</voice>')).toBe('One.\n');
	});

	it('uses the exported tags', () => {
		expect(withoutVoiceTags(`${VOICE_OPEN}x${VOICE_CLOSE}`)).toBe('x');
	});
});
