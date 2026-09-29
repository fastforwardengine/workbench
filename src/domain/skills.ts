import { join } from 'node:path';
import { fromDirectory, loadSkills, type SkillSet } from '@ambionframework/workspace';
import { packageDirectory } from './package-root.ts';

/** The directory that holds one directory of skills for each agent. */
export const skillsDirectory = packageDirectory('skills');

/**
 * The skills of one agent, from `skills/<agent>/`. Each folder in it is one
 * skill. A skill that breaks a rule of agentskills.io stops the host with an
 * error that names the file.
 */
export function agentSkills(agent: string): Promise<SkillSet> {
	return loadSkills(fromDirectory(join(skillsDirectory, agent)));
}
