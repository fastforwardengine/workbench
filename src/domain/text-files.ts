import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Paths that a tool writes beside the files of a repository. A registered source never holds them. */
const IGNORED = new Set(['.git', '.DS_Store', '__pycache__']);

/**
 * The files under `root`, by path, as text and in path order. A repository
 * source holds text files only.
 */
export function textFiles(root: string): Record<string, string> {
	const files: Record<string, string> = {};
	for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
		const path = relative(root, join(entry.parentPath, entry.name));
		if (!entry.isFile() || path.split(sep).some((part) => IGNORED.has(part))) continue;
		files[path] = readFileSync(join(root, path), 'utf8');
	}
	return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
}
