import type { SystemMessage } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { systemRow } from '../src/view/system.ts';

const system = (text: string, extra: Partial<SystemMessage> = {}): SystemMessage =>
	({ seq: 7, kind: 'system', text, at: '2026-01-01T00:00:00Z', ...extra }) as SystemMessage;

describe('systemRow', () => {
	it('names the seat that gets a returned say, and keeps its text', () => {
		const row = systemRow(system('check PSU temp', { to: 'Engineer', returns: 3 }));
		expect(row).toEqual({ mark: '↩', source: 'Engineer', text: 'check PSU temp' });
	});

	it('names the breakout room of a report and drops the prefix', () => {
		const row = systemRow(system('breakout build-psu: The rail holds 5.02 V at 1 A.'));
		expect(row).toEqual({ mark: '▸', source: 'build-psu', text: 'The rail holds 5.02 V at 1 A.' });
	});

	it('names the breakout room of a close notice', () => {
		const row = systemRow(system('breakout build-psu: exchange #3 is replied, messages #3 to #9.'));
		expect(row.source).toBe('build-psu');
		expect(row.text).toBe('exchange #3 is replied, messages #3 to #9.');
	});

	it('names `system` for any other message', () => {
		expect(systemRow(system('Dropped the key.'))).toEqual({
			mark: '▸',
			source: 'system',
			text: 'Dropped the key.',
		});
	});

	it('keeps the text of a message that only starts with the word breakout', () => {
		expect(systemRow(system('breakouts are quiet')).source).toBe('system');
		expect(systemRow(system('breakout: no name')).text).toBe('breakout: no name');
	});

	it('shows the first line that holds text', () => {
		const row = systemRow(system('breakout build-psu: First line.\nSecond line.'));
		expect(row.text).toBe('First line.');
		expect(systemRow(system('\n\n  Late start.\nNext.')).text).toBe('Late start.');
	});

	it('shows an empty text for a message with no text', () => {
		expect(systemRow(system('')).text).toBe('');
		expect(systemRow({ seq: 1, kind: 'system', at: 'x' } as SystemMessage).text).toBe('');
	});
});
