import { userInfo } from 'node:os';
import { defineAgent, defineHuman, type ToolBundle } from '@ambionframework/ambion';
import { defineAssistant } from '@ambionframework/assistant';
import { pi } from '@ambionframework/pi';
import type { Workspace } from '@ambionframework/workspace';
import type { SqlResource } from '@ambionframework/workspace/sql';
import { piModel } from './families.ts';
import type { Instrument } from './instrument.ts';

/** The name of the account running this process. The one automatic person below uses it. */
const owner = userInfo().username;

/** The people who use Workbench. Each one reads a result a different way. */
export const people = [
	{
		name: 'priya',
		role: 'Hardware lead',
		preferences: 'Lead with the part choice, the current and voltage margins, and the decision.',
	},
	{
		name: 'noor',
		role: 'Electrochemistry lead',
		preferences: 'Lead with the cell chemistry, the safety limits, and the measured capacity.',
	},
	{
		name: 'jae',
		role: 'Lab technician',
		preferences: 'Lead with the procedure steps in order, and one thing to check at each step.',
	},
	{
		name: owner,
		role: 'Project lead',
		preferences: 'Lead with the decision and the evidence. Skip the walkthrough unless asked.',
	},
].map(({ name, role, preferences }) => ({
	...defineHuman({
		name,
		identity: `${name}, ${role.toLowerCase()} on the Workbench lab team.`,
		preferences,
	}),
	role,
}));

/** A person who can use Workbench. */
export type Person = (typeof people)[number];

/** The shared rules every agent follows. The kernel adds the collaboration rules. */
export const shared =
	'This is an agentic lab workspace for electrical engineering, hardware, and electrochemistry. ' +
	'Read /library for the datasheets and /shared/kit.md for the project and the house rules before you act. ' +
	'Cite the exact datasheet path when you state a specification, for example /library/cell-18650.md. ' +
	'Do not invent a value that a datasheet does not give. If a datasheet does not cover a case, say so. ' +
	'This project connects no real hardware yet, so treat every measurement as a planned value, not a reading. ' +
	'Respect explicit human constraints; they override role defaults and survive every specialist handoff. When the person says not to edit files, do not call write or shell tools that change files; give the answer in your reply. ' +
	'The lab database holds the projects, test_plans, runs, results, and operations tables. Read it with `query` and append with `record`. `query` cannot change data. ' +
	'Cite what you rely on in `refs`, one URI each. A workspace file is file:///<path>, for example file:///library/cell-18650.md. A lab table is lab:///<table>, for example lab:///runs. The terminal opens a ref that names an existing file or table, and marks any other ref. ' +
	'Report only actions your tool results support. You have local file and shell tools, and no web, email, or hardware tools. ';

/**
 * The specialists with a working resource today. Each one has a narrow scope
 * and reports back once.
 */
const specialists = [
	{
		name: 'datasheets',
		identity:
			'Datasheets specialist. Finds and interprets datasheets, manuals, application notes, and chemical safety data sheets in /library.',
		instructions:
			'Compare specifications, identify operating limits, and cite the exact source and revision. Never state a value without a datasheet path. Say so when a datasheet does not cover a case, instead of guessing.',
	},
	{
		name: 'design',
		identity:
			'Design specialist. Develops and troubleshoots circuits, assemblies, materials, and formulations.',
		instructions:
			'Use the datasheet limits to choose parts and values. Show the calculation, and keep every value within the part and board limits, with the margin stated. Propose changes and explain tradeoffs and failure hypotheses. Record a decision in /shared when the person permits file edits. Record each run you plan with `record` in the runs table, and read earlier runs and results with `query`. Drive the simulated bench instruments with `operate`. An operation above a limit does not run. Ask the owner of the exchange, wait for the answer, then call `approve_operation`.',
	},
	{
		name: 'experiments',
		identity: 'Experiments specialist. Turns a question into a test plan.',
		instructions:
			'Define the procedure, the variables, the controls, the measurement requirements, and the acceptance criteria. Keep the plan short and repeatable, and recommend a follow-up test when one result raises a new question. Save a plan under /shared when the person permits file edits. Record the plan with `record` in the test_plans table, and read earlier runs and results with `query`.',
	},
];

/**
 * The specialists that wait on an application resource this release does not
 * schedule: a live equipment connection for Instruments, and analysis
 * tooling for Data Analysis. Each holds only the workspace tools, not the lab
 * or the instrument bundle, so it cannot claim a run or a reading it has no
 * resource to back. Its instructions say so plainly, so a person reads a
 * stated limit instead of a silent gap.
 */
const stubs = [
	{
		name: 'instruments',
		identity:
			'Instruments specialist. Configures and operates connected equipment within approved procedures and limits.',
		instructions:
			'This project connects no real equipment yet. Say so when a question needs a live reading, a run to start, or a physical setup, and name what a person must do by hand instead. Read /shared/kit.md for what the project holds today.',
	},
	{
		name: 'data-analysis',
		identity: 'Data Analysis specialist. Converts measurements into reproducible results.',
		instructions:
			'This project has no analysis tooling yet: no data quality check, no fit, and no plot. Say so when a question needs one, and name the metric a person should read from the lab database by hand with `lab:///results` in the meantime. Read /shared/kit.md for what the project holds today.',
	},
];

/** Build the team for one workspace. Every room reuses these definitions. */
export function team(workspace: Workspace, lab: SqlResource, instrument: Instrument) {
	const model = piModel();
	// One list of bundles serves every full specialist, so every seat holds the
	// same tools over one workspace.
	const bundles: ToolBundle[] = [workspace.tools(), lab.tools(), instrument.tools()];
	// The stub specialists reach the workspace only. Neither has a resource to
	// back a lab record or an instrument reading.
	const stubBundles: ToolBundle[] = [workspace.tools()];
	const assistant = defineAssistant({ model, instructions: shared, bundles });
	const specialistDefinitions = specialists.map(({ instructions, ...definition }) =>
		defineAgent({
			...definition,
			executor: pi({ instructions: `${shared}${instructions}${CLOSING}`, model, bundles }),
		}),
	);
	const stubDefinitions = stubs.map(({ instructions, ...definition }) =>
		defineAgent({
			...definition,
			executor: pi({
				instructions: `${shared}${instructions}${CLOSING}`,
				model,
				bundles: stubBundles,
			}),
		}),
	);
	return {
		workspace,
		lab,
		assistant,
		specialists: [...specialistDefinitions, ...stubDefinitions],
		agents: [assistant, ...specialistDefinitions, ...stubDefinitions],
	};
}

const CLOSING =
	' Report your result to the assistant, or to the specialist who asked you. Reply once when your assignment is done. Stay silent on acknowledgments and when there is no new work.';
