/** The guide to the data directory that the host writes at each start. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openLab } from '../src/host/host.ts';

/** Open a lab on a fresh directory, close it, and run the check. */
async function withDirectory(check: (directory: string) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), 'workbench-schemas-'));
	try {
		const lab = await openLab({
			directory,
			stream: () => {
				throw new Error('No model call.');
			},
		});
		await lab.close();
		await check(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe('schemas.md in the data directory', () => {
	it('lists the entries, the tables of rooms.db, and the format of activations.jsonl', async () => {
		await withDirectory(async (directory) => {
			const text = await readFile(join(directory, 'schemas.md'), 'utf8');
			expect(text).toContain('generates this file at each start');
			for (const name of ['rooms.db', 'activations.jsonl', 'git.db', 'workspace', 'schemas.md'])
				expect(text).toContain(`- \`${name}\`:`);
			const database = new DatabaseSync(join(directory, 'rooms.db'), { readOnly: true });
			const tables = database
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL")
				.all() as { name: string }[];
			database.close();
			expect(tables.length).toBeGreaterThan(0);
			for (const { name } of tables) expect(text).toMatch(new RegExp(`CREATE TABLE "?${name}"?`));
			expect(text).toContain('## activations.jsonl');
			expect(text).toContain('One line is one Ambion `TracedStep`');
			expect(text).not.toMatch(/INSERT|rows?:/);
		});
	});

	it('writes the file again at the next start', async () => {
		await withDirectory(async (directory) => {
			await writeFile(join(directory, 'schemas.md'), 'edited');
			const lab = await openLab({
				directory,
				stream: () => {
					throw new Error('No model call.');
				},
			});
			await lab.close();
			expect(await readFile(join(directory, 'schemas.md'), 'utf8')).toContain(
				'# The data directory',
			);
		});
	});
});
