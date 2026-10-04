import { userInfo } from 'node:os';
import { defineAgent, definePerson } from '@ambionframework/ambion';
import { pi } from '@ambionframework/pi';
import type { Workspace } from '@ambionframework/workspace';
import { piModel, THINKING } from './model.ts';
import { specialistSkills } from './skills.ts';

/** The name of the account running this process. The one person of Workbench uses it. */
const owner = userInfo().username;

/** How the person wants an answer. The specialists follow it, so the text has one home. */
export const PREFERENCE =
	'Lead with the decision and the evidence. Skip the walkthrough unless asked.';

/** The people who use Workbench: the owner of the account, who runs the bench. */
export const people = [
	{
		...definePerson({
			name: owner,
			identity: `${owner}, project lead on the Workbench lab bench.`,
			preferences: PREFERENCE,
		}),
		role: 'Project lead',
	},
];

/** A person who can use Workbench. */
export type Person = (typeof people)[number];

/** The project that the seats work on, as the shared prompt states it. The room goal lists the phases. */
export const radioProject = 'Workbench is a lab workspace for one bench project: an FM radio kit.';

/** The groups of rules in the prompt of a seat, in order. */
const GROUPS = ['Project', 'Evidence', 'Constraints', 'Speaking'] as const;

/** A group of rules. */
type Group = (typeof GROUPS)[number];

/** The rules of a seat for each group. Each rule is one line of the prompt. */
type Rules = Partial<Record<Group, string[]>>;

/** The rules every specialist follows. The kernel adds the collaboration rules. */
const SHARED_RULES: Rules = {
	Project: [
		'Read /shared/kit.md for the parts and the house rules, and /library for the datasheets, before you act.',
		'The notes are the memory of the team. They are the git repository shared/notes. Before you act, follow the keep-notes skill to read them. Follow it also to add to them.',
		'You have file, shell, and git tools, and no web or email tools. The Engineer reaches the devices of the bench through the shell.',
	],
	Evidence: [
		'Cite the exact datasheet path when you state a specification.',
		'Do not invent a value that a datasheet does not give. If /library does not cover a case, say so.',
		'A value is a reading only when a script read it from a device and wrote it to a file. Snapshot that file with `snapshot`, and cite the snapshot ref. Treat every other value as a planned value.',
		'Report only actions your tool results support.',
		'The person can attach a picture to a message. The message then cites it as a snapshot ref, and its path is /attachments/<name>. Read that path with `read`: the tool sends a picture to you, and you describe what you see and cite the ref. Do not guess what a picture shows.',
		'Cite what you rely on in `refs`, one URI each. Cite a file of /library, which is read-only, as file:///<path>, for example file:///library/rda5807fp.md. Cite a file that can change, such as /shared/kit.md, by its snapshot ref. Inside a note, write the library/ path.',
	],
	Constraints: [
		'Respect explicit human constraints. They override role defaults and survive every specialist handoff. When the person says not to edit files, do not call write or shell tools that change files, and give the answer in your reply. A clone or a pull of the notes is not an edit.',
	],
	Speaking: [
		'Say a result with no `to`.',
		'Use `to` to ask a colleague for work.',
		'Post one message for each result.',
		PREFERENCE,
	],
};

/** Write the groups of rules as sections. A section is a header, then one line for each rule. */
function render(project: string, groups: Rules): string {
	const sections = GROUPS.flatMap((group) => {
		const rules = groups[group] ?? [];
		return rules.length > 0 ? [`## ${group}\n${rules.map((rule) => `- ${rule}`).join('\n')}`] : [];
	});
	return [project.trim(), ...sections].join('\n\n');
}

/** Add the rules of a seat after the shared rules, group by group. */
function merge(extra: Rules): Rules {
	return Object.fromEntries(
		GROUPS.map((group) => [group, [...(SHARED_RULES[group] ?? []), ...(extra[group] ?? [])]]),
	);
}

/** The shared rules every specialist follows, for a project. The kernel adds the collaboration rules. */
export function sharedRules(project: string): string {
	return render(project, SHARED_RULES);
}

/** The shared rules for the FM radio project. */
export const shared = sharedRules(radioProject);

/** The specialists. Each one has a narrow scope and reports back once. */
const specialists: { name: string; identity: string; rules: Rules }[] = [
	{
		name: 'researcher',
		identity:
			'Researcher specialist. Finds and interprets the datasheets and manuals in /library, and turns a question into a test plan.',
		rules: {
			Project: [
				'Follow the cite-a-limit skill for a limit and for a choice between parts, and the write-a-test-plan skill for a test plan.',
			],
			Evidence: ['Never state a value without a datasheet path.'],
		},
	},
	{
		name: 'engineer',
		identity:
			'Engineer specialist. Watches the bench, finds and drives its devices, and guides the assembly of a kit one step at a time, with evidence for each claim.',
		rules: {
			Project: [
				'Follow the scan-the-bench skill to find the devices of the bench, before you drive a device.',
				'Follow the drive-the-power-supply skill to run a power supply, and the observe-the-camera skill to look at the bench with the camera.',
				'Follow the guide-a-build-step skill for a build step, and the check-a-photo skill for a photo.',
			],
			Constraints: [
				'Change no setting and no output of a device outside a script from a template.',
				'Ask the person before the first run that turns on an output of a device.',
				'You cannot hold a tool. Name the hands-on work that a physical setup needs, ask the person to do it, and ask the person to report what happened.',
			],
			Speaking: [
				'The Researcher hears only a directed say. Hand it a result that it needs with `to`.',
				'When the person did not address the Researcher and a message needs a limit from /library, a choice between parts, or a test plan, ask the Researcher with `to`.',
			],
		},
	},
];

/**
 * Build the team for one workspace. Every room reuses these definitions. Each
 * specialist reads its own skills from `skills/<name>/`. `project` is the
 * paragraph that opens the instructions of every seat: the FM radio project by
 * default, and another one for an eval.
 */
export async function team(workspace: Workspace, project: string = radioProject) {
	const model = piModel();
	const definitions = await Promise.all(
		specialists.map(async ({ rules, ...definition }) => {
			const skills = await specialistSkills(definition.name);
			return defineAgent({
				...definition,
				executor: pi({
					instructions: render(project, merge(rules)),
					model,
					thinking: THINKING,
					bundles: [workspace.tools({ skills })],
				}),
			});
		}),
	);
	return { workspace, specialists: definitions };
}
