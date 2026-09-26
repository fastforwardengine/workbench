import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The root of the Workbench package: the nearest directory above this module
 * that holds a `package.json`. The source tree and the bundle in `dist/`
 * give the same root, so a directory that ships beside the code, such as
 * `library/` or `templates/`, resolves the same way in both.
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

/** A directory that ships at the root of the package, such as `library`. */
export const packageDirectory = (name: string): string => join(root, name);
