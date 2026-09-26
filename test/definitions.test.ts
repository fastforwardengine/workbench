import { describe, expect, it } from 'vitest';
import { shared } from '../src/domain/definitions.ts';
import { resolveRef } from '../src/view/refs.ts';

describe('the team instructions', () => {
	it('name the URI form of a workspace file', () => {
		expect(shared).toContain('file:///<path>');
	});

	it('give examples that the terminal resolves', () => {
		const known = { room: 'led-sweep', files: ['/shared/kit.md'], seqs: new Set<number>() };
		const examples = [...shared.matchAll(/file:\/\/\/[A-Za-z0-9_./-]+[A-Za-z0-9]/g)].map(
			(match) => match[0],
		);
		expect(examples).toEqual(['file:///shared/kit.md']);
		for (const example of examples) expect(resolveRef(example, known).target).toBeDefined();
	});
});
