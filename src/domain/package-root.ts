import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The root of the Workbench package: the nearest directory above this module
 * that holds a `package.json`. The source tree and the bundle in `dist/`
 * give the same root, so a directory that ships beside the code, such as
 * `datasheets/` or `templates/`, resolves the same way in both.
 */
function findRoot(start: string): string {
	let directory = start;
	while (!existsSync(join(directory, 'package.json'))) {
		const parent = dirname(directory);
		if (parent === directory) throw new Error(`No package.json above ${start}.`);
		directory = parent;
	}
	return directory;
}

const root = findRoot(dirname(fileURLToPath(import.meta.url)));

/** A directory that ships at the root of the package, such as `datasheets`. */
export const packageDirectory = (name: string): string => join(root, name);

/** The path segments that a tool writes beside the files of a package directory. */
const IGNORED_SEGMENTS = new Set(['.git', '.DS_Store', '__pycache__']);

/**
 * The one ignore rule for a package directory. A path is ignored when any
 * segment is `.git`, `.DS_Store`, or `__pycache__`, or when the file name
 * ends in `.pyc`. A dot file such as `.gitignore` stays.
 */
export const isIgnored = (path: string): boolean =>
	path.endsWith('.pyc') || path.split(/[\\/]/).some((segment) => IGNORED_SEGMENTS.has(segment));

/**
 * The files under `root`, at any depth, by relative POSIX path and in path
 * order, without the ignored paths. A file is bytes. With `text`, a file is
 * a UTF-8 string.
 */
export function packageFiles(root: string, options: { text: true }): Record<string, string>;
export function packageFiles(root: string, options?: { text?: false }): Record<string, Uint8Array>;
export function packageFiles(
	root: string,
	{ text = false }: { text?: boolean } = {},
): Record<string, string | Uint8Array> {
	const paths = readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
		.filter((path) => !isIgnored(path))
		.sort((a, b) => (a < b ? -1 : 1));
	return Object.fromEntries(
		paths.map((path) => [
			path,
			text ? readFileSync(join(root, path), 'utf8') : readFileSync(join(root, path)),
		]),
	);
}
