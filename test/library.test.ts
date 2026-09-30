import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { memoryBackend } from '@ambionframework/just-bash';
import { BACKGROUND_CONTEXT, openWorkspace } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import { seedFiles } from '../src/domain/scenarios.ts';
import { seedWorkspace } from '../src/host/seed.ts';

const library = resolve(import.meta.dirname, '../library');
const markdown = readdirSync(library).filter((name) => name.endsWith('.md'));

describe('the library', () => {
	it('holds a summary for every part of the kit, and an index', () => {
		expect(markdown).toEqual(
			expect.arrayContaining([
				'README.md',
				'fm-radio-kit-manual.md',
				'fm-radio-kit-schematic.md',
				'fm-radio-kit-product.md',
				'rda5807fp.md',
				'stc8g1k17.md',
				'hxj8002.md',
				'3641as.md',
				'xc6206-662k.md',
				'tp4056.md',
			]),
		);
	});

	it('lists each Markdown file in the index', () => {
		const index = readFileSync(join(library, 'README.md'), 'utf8');
		for (const name of markdown.filter((file) => file !== 'README.md'))
			expect(index, name).toContain(`\`${name}\``);
	});

	it('names its source and its conversion date in each part file', () => {
		for (const name of markdown.filter((file) => file !== 'README.md')) {
			const text = readFileSync(join(library, name), 'utf8');
			expect(text, name).toMatch(/\*\*Source:\*\*/);
			expect(text, name).toMatch(/\*\*Converted:\*\*\s+2026-\d\d-\d\d/);
		}
	});

	it('points every image link and every figure path at a file that exists', () => {
		for (const name of markdown) {
			const text = readFileSync(join(library, name), 'utf8');
			const links = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1] ?? '');
			const paths = [...text.matchAll(/`\/library\/([^`]+)`/g)].map((match) => match[1] ?? '');
			for (const link of links)
				expect(existsSync(join(library, dirname(name), link)), link).toBe(true);
			for (const path of paths) expect(existsSync(join(library, path)), path).toBe(true);
		}
	});

	it('keeps each figure under 200 KB', () => {
		for (const name of readdirSync(join(library, 'images')))
			expect(readFileSync(join(library, 'images', name)).length, name).toBeLessThan(200_000);
	});

	it('seeds the images as bytes and the Markdown as text', () => {
		const files = seedFiles();
		const image = files['/library/images/kit-schematic.jpg'];
		expect(image).toBeInstanceOf(Uint8Array);
		expect(Array.from((image as Uint8Array).slice(0, 2))).toEqual([0xff, 0xd8]);
		expect(typeof files['/library/rda5807fp.md']).toBe('string');
	});

	it('writes a figure into the workspace with its bytes intact', async () => {
		const workspace = openWorkspace({ name: 'library', backend: { bash: memoryBackend() } });
		try {
			await seedWorkspace(workspace);
			await workspace.use(workspace.host, async (env) => {
				const read = await env.readBinaryFile(
					'/library/images/kit-schematic.jpg',
					BACKGROUND_CONTEXT,
				);
				const expected = readFileSync(join(library, 'images', 'kit-schematic.jpg'));
				expect(read.ok && Buffer.from(read.value).equals(expected)).toBe(true);
				const text = await env.readTextFile('/library/rda5807fp.md', BACKGROUND_CONTEXT);
				expect(text.ok && text.value).toContain('RDA5807FP');
			});
		} finally {
			await workspace.dispose();
		}
	});

	it('rewrites a stale library file at each start, and keeps an edit outside the library', async () => {
		const workspace = openWorkspace({ name: 'library', backend: { bash: memoryBackend() } });
		try {
			await workspace.use(workspace.host, async (env) => {
				await env.writeFile(
					'/library/README.md',
					'The directory has no summary yet.',
					BACKGROUND_CONTEXT,
				);
				await env.writeFile('/shared/kit.md', 'an edit of the person', BACKGROUND_CONTEXT);
			});
			await seedWorkspace(workspace);
			await workspace.use(workspace.host, async (env) => {
				const index = await env.readTextFile('/library/README.md', BACKGROUND_CONTEXT);
				expect(index.ok && index.value).toContain('rda5807fp.md');
				const kit = await env.readTextFile('/shared/kit.md', BACKGROUND_CONTEXT);
				expect(kit.ok && kit.value).toBe('an edit of the person');
			});
		} finally {
			await workspace.dispose();
		}
	});

	it('leaves a dot file out of the seed', () => {
		for (const path of Object.keys(seedFiles())) expect(path, path).not.toMatch(/\/\.[^/]+$/);
	});
});
