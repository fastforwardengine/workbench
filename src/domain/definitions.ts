import { userInfo } from 'node:os';
import { defineAgent, definePerson, type ToolBundle } from '@ambionframework/ambion';
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

/** The skills of research. The Researcher follows them. */
const RESEARCH_SKILLS =
	'Follow the cite-a-limit skill for a limit and for a choice between parts, and the write-a-test-plan skill for a test plan.';

/** The groups of rules in the prompt of a seat, in order. */
const GROUPS = ['Project', 'Evidence', 'Constraints', 'Background', 'Speaking'] as const;

/** A group of rules. */
type Group = (typeof GROUPS)[number];

/** The rules of a seat for each group. Each rule is one line of the prompt. */
type Rules = Partial<Record<Group, string[]>>;

/** The rules every seat follows. The kernel adds the collaboration rules. */
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
		'In a breakout room, no person is present and no device is yours to drive. A skill that drives a device runs there only on its simulator, when it has one. A run on a simulator needs no approval. Report a step that needs a device or the person to the opener.',
	],
};

/** The rules of every specialist. `self` is the name of the specialist. */
const specialistRules = (self: string): Rules => ({
	Background: [
		`A breakout room runs one task in the background while this room continues. Seat yourself in it: the \`agents\` of \`breakout\` names ${self}.`,
		'Open a breakout room for a self-contained task of many steps whose result this room does not need for its next step.',
		'Open one breakout room for each independent task, so that the tasks run in parallel.',
		'Keep in this room a task that drives a device of the bench, or that needs the person for an approval, hands-on work, or a photo.',
		'Keep in this room a task that you can finish in this activation.',
		'The seat of the breakout room sees only your `goal` and `message`, and it shares your home. In the `message`, give the task, its inputs, each constraint of the person, and the form of the result. In the `goal`, state the result in one sentence.',
		'After you open a breakout room, say in one line what runs in the background, and continue the work of this room.',
		'A report is a claim. Read its `refs` before you say its result.',
	],
	Speaking: [
		'In a root room, say a result with no `to`.',
		'Use `to` to ask a colleague for work.',
		'Post one message for each result.',
		'In a breakout room, send the result with `report`, once, at the end of the task. Cite in `refs` what the result relies on.',
		'In a breakout room, when the brief lacks an input that the task needs, report what is missing as the result.',
		PREFERENCE,
	],
});

/** Write the groups of rules as sections. A section is a header, then one line for each rule. */
function render(project: string, groups: Rules): string {
	const sections = GROUPS.flatMap((group) => {
		const rules = groups[group] ?? [];
		return rules.length > 0 ? [`## ${group}\n${rules.map((rule) => `- ${rule}`).join('\n')}`] : [];
	});
	return [project.trim(), ...sections].join('\n\n');
}

/** Join layers of rules, group by group. A layer that comes later adds its rules after the earlier ones. */
function merge(...layers: Rules[]): Rules {
	return Object.fromEntries(
		GROUPS.map((group) => [group, layers.flatMap((layer) => layer[group] ?? [])]),
	);
}

/** The shared rules every seat follows, for a project. The kernel adds the collaboration rules. */
export function sharedRules(project: string): string {
	return render(project, SHARED_RULES);
}

/** The shared rules for the FM radio project. */
export const shared = sharedRules(radioProject);

/** The specialists. Each one has a narrow scope and reports back once. */
const specialists: {
	name: string;
	identity: string;
	rules: Rules;
	shows?: boolean;
}[] = [
	{
		name: 'researcher',
		identity:
			'Researcher specialist. Finds and interprets the datasheets and manuals in /library, and turns a question into a test plan.',
		rules: {
			Project: [RESEARCH_SKILLS],
			Evidence: ['Never state a value without a datasheet path.'],
			Background: [
				'Examples of a breakout task: compare the datasheets of several parts, or draft a test plan.',
			],
		},
	},
	{
		name: 'engineer',
		identity:
			'Engineer specialist. Watches the bench, finds and drives its devices, and guides the assembly of a kit one step at a time, with evidence for each claim.',
		// The Engineer runs the camera, so it shows the viewfinder widget.
		shows: true,
		rules: {
			Project: [
				'Follow the scan-the-bench skill to find the devices of the bench, before you drive a device.',
				'Follow the drive-the-power-supply skill to run a power supply, and the observe-the-camera skill to look at the bench with the cameras.',
				'Follow the guide-a-build-step skill for a build step, and the check-a-photo skill for a photo.',
			],
			Background: [
				'Examples of a breakout task: write and test a script, or read the data files of a capture.',
			],
			Constraints: [
				'Change no setting and no output of a device outside a script from a template.',
				'In a root room, ask the person before the first run that turns on an output of a device.',
				'In a root room, you cannot hold a tool. Name the hands-on work that a physical setup needs, ask the person to do it, and ask the person to report what happened.',
				'In a breakout room, do not call `show`. The viewfinder needs the camera of the bench.',
			],
			Speaking: [
				'The Researcher hears only a directed say. Hand it a result that it needs with `to`.',
				'When the person did not address the Researcher and a message needs a limit from /library, a choice between parts, or a test plan, ask the Researcher with `to`.',
			],
		},
	},
];

/** The tool bundles that the canvas gives to the seats. A seat receives only the bundles that suit its job. */
export interface CanvasBundles {
	/** `show` and `hide`. The Engineer holds them. */
	widgets?: ToolBundle;
	/** `breakout`, `tell`, `archive`, and `report`. Each specialist holds them. */
	canvas?: ToolBundle;
}

/**
 * Build the team for one workspace. Every room reuses these definitions: a
 * specialist works in a root room and in a breakout room. Each specialist
 * reads its own skills from `skills/<name>/`. `project` is the paragraph that
 * opens the instructions of every seat: the FM radio project by default, and
 * another one for an eval. `bundles` holds the tool bundles of the canvas. A
 * bundle that is absent adds no tool: a team without `widgets` shows no
 * widget, and a team without `canvas` opens no breakout room.
 */
export async function team(
	workspace: Workspace,
	project: string = radioProject,
	bundles: CanvasBundles = {},
) {
	const model = piModel();
	const defined = await Promise.all(
		specialists.map(async ({ rules, shows, ...definition }) =>
			defineAgent({
				...definition,
				executor: pi({
					instructions: render(
						project,
						merge(SHARED_RULES, specialistRules(definition.name), rules),
					),
					model,
					thinking: THINKING,
					bundles: [
						workspace.tools({ skills: await specialistSkills(definition.name) }),
						...[shows ? bundles.widgets : undefined, bundles.canvas].filter(
							(bundle) => bundle !== undefined,
						),
					],
				}),
			}),
		),
	);
	return { workspace, specialists: defined };
}
