import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	templateFiles,
	templateInstructions,
	templates,
	templatesDirectory,
} from '../src/domain/templates.ts';

describe('the Workbench templates', () => {
	it('registers each directory under templates/ once, and nothing else', () => {
		const directories = readdirSync(templatesDirectory, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		expect(templates.map((template) => template.name).sort()).toEqual(directories);
	});

	it.each(templates)('gives $name a README.md and a valid name', ({ name }) => {
		expect(name).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
		expect(Object.keys(templateFiles(name))).toContain('README.md');
	});

	it('names each template in the instructions of its specialists alone', () => {
		expect(templateInstructions('experiments')).toContain('the test-plan template');
		expect(templateInstructions('design')).toBe('');
	});
});
