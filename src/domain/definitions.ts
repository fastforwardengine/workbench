import { userInfo } from 'node:os';
import { defineAgent, defineHuman } from '@ambionframework/ambion';
import { defineAssistant } from '@ambionframework/assistant';
import { pi } from '@ambionframework/pi';
import type { Workspace } from '@ambionframework/workspace';
import { piModel, THINKING } from './families.ts';
import { templateInstructions } from './templates.ts';

/** The name of the account running this process. The one person of Workbench uses it. */
const owner = userInfo().username;

/** The people who use Workbench: the owner of the account, who runs the bench. */
export const people = [
	{
		...defineHuman({
			name: owner,
			identity: `${owner}, project lead on the Workbench lab bench.`,
			preferences: 'Lead with the decision and the evidence. Skip the walkthrough unless asked.',
		}),
		role: 'Project lead',
	},
];

/** A person who can use Workbench. */
export type Person = (typeof people)[number];

/** The project that every seat works on. */
const project =
	'Workbench is a lab workspace for one bench project: an LED parameter sweep. ' +
	'A power supply drives an LED through a range of currents, and a camera measures the light at each step. ';

/** The shared rules every specialist follows. The kernel adds the collaboration rules. */
export const shared =
	project +
	'Read /shared/kit.md for the parts and the house rules, and /library for the datasheets, before you act. ' +
	'Cite the exact datasheet path when you state a specification. ' +
	'Do not invent a value that a datasheet does not give. If /library does not cover a case, say so. ' +
	'A value is a reading only when a script read it from a device and wrote it to a file that you cite. Treat every other value as a planned value. ' +
	'Respect explicit human constraints; they override role defaults and survive every specialist handoff. When the person says not to edit files, do not call write or shell tools that change files; give the answer in your reply. ' +
	'Cite what you rely on in `refs`, one URI each. A workspace file is file:///<path>, for example file:///shared/kit.md. The terminal opens a ref that names an existing file, and marks any other ref. ' +
	'Report only actions your tool results support. You have file, shell, and git tools, and no web or email tools. Instruments reaches the devices of the bench through the shell. ' +
	'The shell has sqlite3. Make a database in your home or in /shared only when a result needs one. ';

/** The rules of the assistant. It has no workspace, so the specialists hold the files. */
const assistantInstructions =
	project +
	'You have no file, shell, or git tools. The specialists read the files and run the scripts. ' +
	'Datasheets states the limits from /library, Experiments writes the test plan, and Instruments finds the devices of the bench, and prepares and runs the sweep. ' +
	'In a summary, keep the refs that the specialists cite.';

/** The specialists. Each one has a narrow scope and reports back once. */
const specialists = [
	{
		name: 'datasheets',
		identity: 'Datasheets specialist. Finds and interprets the datasheets and manuals in /library.',
		instructions:
			'Compare specifications, identify operating limits, and cite the exact source and revision. Never state a value without a datasheet path. Say so when a datasheet does not cover a case, instead of guessing.',
	},
	{
		name: 'experiments',
		identity: 'Experiments specialist. Turns a question into a test plan.',
		instructions:
			'Define the procedure, the variables, the controls, the measurement requirements, and the acceptance criteria. Keep the plan short and repeatable, and recommend a follow-up test when one result raises a new question. ' +
			'When the person asks for a plan, reply with the plan, also when another specialist already answered part of the question. ' +
			'When a part or a limit is not known yet, still write the outline of the plan. Mark each missing value TBD, and name the limit and the datasheet that must supply it, for example the maximum forward current from the LED datasheet.',
	},
	{
		name: 'instruments',
		identity:
			'Instruments specialist. Finds the devices of the bench, and prepares and runs the bench scripts within the approved plan and limits.',
		instructions:
			'Find the devices before you drive one. When the person asks what is connected, and before the first run of a bench script, scan with the device-scan template. ' +
			'Report each device: its name, its USB ID, its kind, and whether its device file reaches the workstation. ' +
			'When the scan does not find a device, say which step a person takes: attach it to the workstation, such as `orb usb attach <id>` on a Mac. The workstation makes the device file of a camera, a serial port, or a USBTMC instrument within 5 seconds, so scan again once before you report a missing file. ' +
			'Send an instrument only queries that read, such as `*IDN?`. Change no setting and no output of a device outside a script from a template, and ask the owner of the exchange before the first run that drives an output. ' +
			'Scan a network with `--subnet` only when the person names the subnet. ' +
			'Run a bench script from a fork of its template, and report what the script wrote. Start a long script with a `name`, and read its end with `wait` or `status`. ' +
			'When a question needs a physical setup, name what a person must do by hand.',
	},
];

/** Build the team for one workspace. Every room reuses these definitions. */
export function team(workspace: Workspace) {
	const model = piModel();
	const assistant = defineAssistant({
		model,
		thinking: THINKING,
		instructions: assistantInstructions,
	});
	const definitions = specialists.map(({ instructions, ...definition }) =>
		defineAgent({
			...definition,
			executor: pi({
				instructions: `${shared}${instructions}${templateInstructions(definition.name)}${CLOSING}`,
				model,
				thinking: THINKING,
				bundles: [workspace.tools()],
			}),
		}),
	);
	return { workspace, assistant, specialists: definitions, agents: [assistant, ...definitions] };
}

const CLOSING =
	' Report your result to the assistant, or to the specialist who asked you. Reply once when your assignment is done. Stay silent on acknowledgments and when there is no new work.';
