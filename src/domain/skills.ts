import { join } from 'node:path';
import {
	fromDirectory,
	loadSkills,
	type SkillSet,
	type SourceFiles,
} from '@ambionframework/workspace';
import { isIgnored, packageDirectory } from './package-root.ts';

/** The directory that holds one directory of skills for each specialist, and `shared`. */
export const skillsDirectory = packageDirectory('skills');

/** The directory of `skillsDirectory` with the skills of every specialist. It names no specialist. */
export const SHARED_SKILLS = 'shared';

/** The files of a source, without the ones that a tool wrote. */
const withoutIgnored = (files: SourceFiles): SourceFiles =>
	Object.fromEntries(Object.entries(files).filter(([path]) => !isIgnored(path)));

/** The name of the skill that holds a file: the first segment of its path. */
const skillOf = (path: string): string => path.split('/')[0] ?? path;

/**
 * The skills of one specialist: the folders of `<directory>/shared/` and of
 * `<directory>/<specialist>/`. Each folder in them is one skill. A skill of
 * the specialist replaces a shared skill of the same name. A skill that
 * breaks a rule of agentskills.io stops the host with an error that names
 * the file.
 */
export function specialistSkills(
	specialist: string,
	directory = skillsDirectory,
): Promise<SkillSet> {
	const shared = fromDirectory(join(directory, SHARED_SKILLS));
	const own = fromDirectory(join(directory, specialist));
	return loadSkills({
		read: async () => {
			const mine = withoutIgnored(await own.read());
			const named = new Set(Object.keys(mine).map(skillOf));
			const common = Object.entries(withoutIgnored(await shared.read())).filter(
				([path]) => !named.has(skillOf(path)),
			);
			return { ...Object.fromEntries(common), ...mine };
		},
	});
}
