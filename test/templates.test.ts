import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { skillsDirectory } from '../src/domain/skills.ts';
import { templateFiles, templates, templatesDirectory } from '../src/domain/templates.ts';

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

	it.each(templates)('names the $name template in a skill', ({ name }) => {
		const texts = readdirSync(skillsDirectory, { recursive: true, encoding: 'utf8' })
			.filter((path) => path.endsWith('SKILL.md'))
			.map((path) => readFileSync(join(skillsDirectory, path), 'utf8'));
		expect(texts.some((text) => text.includes(`\`${name}\``))).toBe(true);
	});

	it.each(['psu', 'usb-camera'])('registers the ignore file of %s as .gitignore', (name) => {
		const files = templateFiles(name);
		expect(files['.gitignore']).toContain('__pycache__/');
		expect(files).not.toHaveProperty('gitignore');
	});
});
