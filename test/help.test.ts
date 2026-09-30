import { describe, expect, it } from 'vitest';
import { parse } from '../src/terminal/state/commands.ts';
import { HELP } from '../src/terminal/state/session-text.ts';

describe('the help text', () => {
	it('lists every command and key, as the person reads them', () => {
		expect(HELP).toMatchSnapshot();
	});

	it('names every command that the parser accepts', () => {
		for (const name of [
			'room',
			'new',
			'user',
			'files',
			'open',
			'attach',
			'ps',
			'try',
			'abort',
			'dismiss',
			'stop',
			'resume',
			'steps',
			'expand',
			'collapse',
			'help',
			'quit',
		])
			expect(parse(`/${name}`).kind, name).toBe('command');
		expect(parse('/nothing').kind).toBe('unknown');
	});
});
