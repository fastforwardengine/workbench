import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import { seedFiles, seedWorkspace } from '../src/host/seed.ts';

const datasheets = resolve(import.meta.dirname, '../datasheets');
const markdown = readdirSync(datasheets).filter((name) => name.endsWith('.md'));

describe('the datasheets', () => {
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
		const index = readFileSync(join(datasheets, 'README.md'), 'utf8');
		for (const name of markdown.filter((file) => file !== 'README.md'))
			expect(index, name).toContain(`\`${name}\``);
	});

	it('names its source and its conversion date in each part file', () => {
		for (const name of markdown.filter((file) => file !== 'README.md')) {
			const text = readFileSync(join(datasheets, name), 'utf8');
			expect(text, name).toMatch(/\*\*Source:\*\*/);
			expect(text, name).toMatch(/\*\*Converted:\*\*\s+2026-\d\d-\d\d/);
		}
	});

	it('points every image link and every figure path at a file that exists', () => {
		for (const name of markdown) {
			const text = readFileSync(join(datasheets, name), 'utf8');
			const links = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1] ?? '');
			const paths = [...text.matchAll(/`\/datasheets\/([^`]+)`/g)].map((match) => match[1] ?? '');
			for (const link of links)
				expect(existsSync(join(datasheets, dirname(name), link)), link).toBe(true);
			for (const path of paths) expect(existsSync(join(datasheets, path)), path).toBe(true);
		}
	});

	it('keeps each figure under 200 KB', () => {
		for (const name of readdirSync(join(datasheets, 'images')))
			expect(readFileSync(join(datasheets, 'images', name)).length, name).toBeLessThan(200_000);
	});

	it('seeds the images as bytes and the Markdown as text', () => {
		const files = seedFiles();
		const image = files['/datasheets/images/kit-schematic.jpg'];
		expect(image).toBeInstanceOf(Uint8Array);
		expect(Array.from((image as Uint8Array).slice(0, 2))).toEqual([0xff, 0xd8]);
		expect(typeof files['/datasheets/rda5807fp.md']).toBe('string');
	});

	it('writes a figure into the workspace with its bytes intact', async () => {
		const workspace = openWorkspace({ name: 'datasheets', backend: { bash: memoryBackend() } });
		try {
			await seedWorkspace(workspace);
			await workspace.use(workspace.mirrorAgent, async (env) => {
				const read = await env.readBinaryFile('/datasheets/images/kit-schematic.jpg');
				const expected = readFileSync(join(datasheets, 'images', 'kit-schematic.jpg'));
				expect(read.ok && Buffer.from(read.value).equals(expected)).toBe(true);
				const text = await env.readTextFile('/datasheets/rda5807fp.md');
				expect(text.ok && text.value).toContain('RDA5807FP');
			});
		} finally {
			await workspace.dispose();
		}
	});

	it('rewrites a stale datasheet file at each start, and keeps an edit outside the datasheets', async () => {
		const workspace = openWorkspace({ name: 'datasheets', backend: { bash: memoryBackend() } });
		try {
			await workspace.use(workspace.mirrorAgent, async (env) => {
				await env.writeFile('/datasheets/README.md', 'The directory has no summary yet.');
				await env.writeFile('/shared/kit.md', 'an edit of the person');
			});
			await seedWorkspace(workspace);
			await workspace.use(workspace.mirrorAgent, async (env) => {
				const index = await env.readTextFile('/datasheets/README.md');
				expect(index.ok && index.value).toContain('rda5807fp.md');
				const kit = await env.readTextFile('/shared/kit.md');
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
