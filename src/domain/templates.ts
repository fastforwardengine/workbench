import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The directory that holds one directory for each template. */
export const templatesDirectory = fileURLToPath(new URL('../../templates/', import.meta.url));

/**
 * One read-only template on the git server of the workspace. An agent forks
 * it, clones the fork into its home, and pushes its branch.
 */
export interface Template {
	/** The name on the git server, `templates/<name>`, and the directory under `templates/`. */
	readonly name: string;
	/** What the template holds. The `repos` tool shows it to every agent. */
	readonly description: string;
	/** The work the template starts, as a noun phrase, such as "a test plan". */
	readonly use: string;
	/** The specialists whose instructions name this template. */
	readonly specialists: readonly string[];
	/**
	 * The SHA-256 of the files, as `templateDigest` computes it. A template
	 * never changes after its registration. A change takes a new name, such as
	 * `test-plan-2`, and a new digest. `test/templates.test.ts` holds the rule.
	 */
	readonly digest: string;
}

/** The templates, in the order that `repos` lists them. */
export const templates: readonly Template[] = [
	{
		name: 'test-plan',
		description:
			'A numbered test plan: the question, the setup, the variable, the controls, the measurement, the limits, and the pass criterion.',
		use: 'a test plan',
		specialists: ['experiments'],
		digest: '6e93f5727dac639b44c4d4c66e7d0349ba61cff0965ac56a9521b78fcfc4cc03',
	},
];

/** Paths that a tool writes beside the files of a template. A template never holds them. */
const IGNORED = new Set(['.git', '.DS_Store', '__pycache__']);

/**
 * The files of one template, by path, as text. The host registers exactly
 * these files, and the digest covers exactly these files. A template holds
 * text files only.
 */
export function templateFiles(name: string): Record<string, string> {
	const root = join(templatesDirectory, name);
	const files: Record<string, string> = {};
	for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
		const path = relative(root, join(entry.parentPath, entry.name));
		if (!entry.isFile() || path.split(sep).some((part) => IGNORED.has(part))) continue;
		files[path] = readFileSync(join(root, path), 'utf8');
	}
	return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The SHA-256 of each path and its text, in path order. */
export function templateDigest(name: string): string {
	const hash = createHash('sha256');
	for (const [path, text] of Object.entries(templateFiles(name))) hash.update(`${path}\0${text}\0`);
	return hash.digest('hex');
}

/** The instruction lines that name the templates of one specialist. Empty when it has none. */
export function templateInstructions(specialist: string): string {
	return templates
		.filter((template) => template.specialists.includes(specialist))
		.map(
			({ name, use }) =>
				` For ${use}, fork the ${name} template with \`fork\` and set clone, then commit and push your branch.`,
		)
		.join('');
}
