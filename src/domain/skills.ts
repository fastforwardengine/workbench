import { join } from 'node:path';
import {
	fromDirectory,
	loadSkills,
	type SkillSet,
	type SourceFiles,
} from '@ambionframework/workspace';
import { packageDirectory } from './package-root.ts';

/** The directory that holds one directory of skills for each agent. */
export const skillsDirectory = packageDirectory('skills');

/** A file that a tool writes beside the skills. A skill never holds it. */
const IGNORED = new Set(['.DS_Store']);

/** The files of a source, without the ones that a tool wrote. */
const withoutIgnored = (files: SourceFiles): SourceFiles =>
	Object.fromEntries(
		Object.entries(files).filter(([path]) => !path.split('/').some((part) => IGNORED.has(part))),
	);

/**
 * The skills of one agent, from `<directory>/<agent>/`. Each folder in it is
 * one skill. A skill that breaks a rule of agentskills.io stops the host with
 * an error that names the file.
 */
export function agentSkills(agent: string, directory = skillsDirectory): Promise<SkillSet> {
	const source = fromDirectory(join(directory, agent));
	return loadSkills({ read: async () => withoutIgnored(await source.read()) });
}
