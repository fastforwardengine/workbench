import { userInfo } from 'node:os';
import { defineAgent, definePerson } from '@ambionframework/ambion';
import { defineAssistant } from '@ambionframework/assistant';
import { pi } from '@ambionframework/pi';
import type { Workspace } from '@ambionframework/workspace';
import { piModel, THINKING } from './model.ts';
import { specialistSkills } from './skills.ts';

/** The name of the account running this process. The one person of Workbench uses it. */
const owner = userInfo().username;

/** The people who use Workbench: the owner of the account, who runs the bench. */
export const people = [
	{
		...definePerson({
			name: owner,
			identity: `${owner}, project lead on the Workbench lab bench.`,
			preferences: 'Lead with the decision and the evidence. Skip the walkthrough unless asked.',
		}),
		role: 'Project lead',
	},
];

/** A person who can use Workbench. */
export type Person = (typeof people)[number];

/** The project that the seats work on, as the shared prompt states it. The room goal lists the phases. */
export const radioProject =
	'Workbench is a lab workspace for one bench project: an FM radio kit. ' +
	'One room, build, holds every phase. ';

/** The shared rules every specialist follows, for a project. The kernel adds the collaboration rules. */
export function sharedRules(project: string): string {
	return (
		project +
		'Read /shared/kit.md for the parts and the house rules, and /library for the datasheets, before you act. ' +
		'The notes are the memory of the team. They are the git repository shared/notes. Follow the keep-notes skill to read them and to add to them. ' +
		'Cite the exact datasheet path when you state a specification. ' +
		'Do not invent a value that a datasheet does not give. If /library does not cover a case, say so. ' +
		'A value is a reading only when a script read it from a device and wrote it to a file. Snapshot that file with `snapshot`, and cite the snapshot ref. Treat every other value as a planned value. ' +
		'Read a skill of ~/.skills before you start the task that its description names. ' +
		'Respect explicit human constraints; they override role defaults and survive every specialist handoff. When the person says not to edit files, do not call write or shell tools that change files; give the answer in your reply. ' +
		'The person can attach a picture to a message. The message then cites it as a snapshot ref, and its path is /attachments/<name>. Read that path with `read`: the tool sends a picture to you, and you describe what you see and cite the ref. Do not guess what a picture shows. ' +
		'Cite what you rely on in `refs`, one URI each. A workspace file is file:///<path>, for example file:///shared/kit.md. The terminal opens a ref that names an existing file, and marks any other ref. ' +
		'Report only actions your tool results support. You have file, shell, and git tools, and no web or email tools. The Engineer reaches the devices of the bench through the shell. '
	);
}

/** The shared rules for the FM radio project. */
export const shared = sharedRules(radioProject);

/** The rules of the assistant. It has no workspace, so the specialists hold the files. */
const assistantInstructions = (project: string): string =>
	project +
	'You have no file, shell, or git tools. ' +
	'Read the attention of each seat in the roster. A seat at named attention wakes only on a directed say. A seat at broadcast attention reads every message: send it nothing. ' +
	'During a respond activation, route a request that needs a limit from /library or a test plan. If the Researcher sits at named attention and nobody addressed it, send the Researcher one directed request. ' +
	'During a respond activation, do not acknowledge, relay, or restate the result of a specialist: the person reads it. ' +
	'In a summary, keep the refs that the specialists cite.';

/** The specialists. Each one has a narrow scope and reports back once. */
const specialists = [
	{
		name: 'researcher',
		identity:
			'Researcher specialist. Finds and interprets the datasheets and manuals in /library, and turns a question into a test plan.',
		instructions:
			'Follow the cite-a-limit skill for a limit and for a choice between parts, and the write-a-test-plan skill for a test plan. Never state a value without a datasheet path.',
	},
	{
		name: 'engineer',
		identity:
			'Engineer specialist. Watches the bench, finds and drives its devices, and guides the assembly of a kit one step at a time, with evidence for each claim.',
		instructions:
			'Scan the bench before you drive a device: follow the scan-the-bench skill when the person asks what is connected, and before the first run of a bench script. ' +
			'Follow the drive-the-power-supply skill to run a power supply, and the observe-the-camera skill to look at the bench with the camera. ' +
			'Follow the guide-a-build-step skill for a build step, and the check-a-photo skill for a photo. ' +
			'Change no setting and no output of a device outside a script from a template, and ask the person before the first run that drives an output. ' +
			'You cannot hold a tool. Name the hands-on work that a physical setup needs, ask the person to do it, and ask the person to report what happened. ' +
			'Record each step that the person completes in the build folder of the notes, with the evidence.',
	},
];

/**
 * Build the team for one workspace. Every room reuses these definitions. Each
 * specialist reads its own skills from `skills/<name>/`. The assistant has no
 * file or shell tool, so it holds no skills. `project` is the paragraph that
 * opens the instructions of every seat: the FM radio project by default, and
 * another one for an eval.
 */
export async function team(workspace: Workspace, project: string = radioProject) {
	const model = piModel();
	const rules = sharedRules(project);
	const assistant = defineAssistant({
		model,
		thinking: THINKING,
		instructions: assistantInstructions(project),
	});
	const definitions = await Promise.all(
		specialists.map(async ({ instructions, ...definition }) => {
			const skills = await specialistSkills(definition.name);
			return defineAgent({
				...definition,
				executor: pi({
					instructions: `${rules}${instructions}${CLOSING}`,
					model,
					thinking: THINKING,
					bundles: [workspace.tools({ skills })],
				}),
			});
		}),
	);
	return { workspace, assistant, specialists: definitions, agents: [assistant, ...definitions] };
}

const CLOSING =
	' Say your result to the room, with no `to`, so the person and every seat at broadcast read it. Address a seat with `to` only to ask it for work. Reply once when your assignment is done. Stay silent on acknowledgments and when there is no new work.';
