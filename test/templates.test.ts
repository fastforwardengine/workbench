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

	it.each([
		['device-scan', 'scan-the-bench'],
		['usb-camera', 'observe-the-camera'],
		['psu', 'drive-the-power-supply'],
	])('names the %s template in the %s skill of the Engineer', (name, skill) => {
		const text = readFileSync(join(skillsDirectory, 'engineer', skill, 'SKILL.md'), 'utf8');
		expect(text).toContain(`\`${name}\``);
	});

	it.each(['psu', 'usb-camera'])('registers the ignore file of %s as .gitignore', (name) => {
		const files = templateFiles(name);
		expect(files['.gitignore']).toContain('__pycache__/');
		expect(files).not.toHaveProperty('gitignore');
	});
});
