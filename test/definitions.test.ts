import { describe, expect, it } from 'vitest';
import { shared } from '../src/domain/definitions.ts';
import { resolveRef } from '../src/view/refs.ts';

describe('the team instructions', () => {
	it('name the URI form of a workspace file and of a lab table', () => {
		expect(shared).toContain('file:///<path>');
		expect(shared).toContain('lab:///<table>');
	});

	it('give examples that the terminal resolves', () => {
		const known = {
			room: 'characterization',
			files: ['/library/cell-18650.md'],
			tables: ['runs'],
			seqs: new Set<number>(),
		};
		const examples = [...shared.matchAll(/(?:file|lab):\/\/\/[A-Za-z0-9_./-]+[A-Za-z0-9]/g)].map(
			(match) => match[0],
		);
		expect(examples).toEqual(['file:///library/cell-18650.md', 'lab:///runs']);
		for (const example of examples) expect(resolveRef(example, known).target).toBeDefined();
	});
});
