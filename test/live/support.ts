/**
 * What the evals of Workbench share: the models, a room on the team of the
 * lab, the reads of a run, the evidence a failed case keeps, and the cost
 * line. The evals run on `@ambionframework/simulator`: a scripted person
 * asks, checks in code decide the facts, and a judge grades the meaning.
 *
 * `WORKBENCH_MODEL` names the model of every seat, as `pnpm start` reads it.
 * `JUDGE_MODEL` names the judge's model, the same model by default. A suite
 * that grades one model family names another family for the judge.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createRuntime,
	isSpoken,
	type Room,
	type SpokenMessage,
	startRoom,
} from '@ambionframework/ambion';
import type { Execution } from '@ambionframework/ambion/hosting';
import { directoryBackend } from '@ambionframework/just-bash';
import { piExecution } from '@ambionframework/pi';
import type { Run, RunExchange, Verdict } from '@ambionframework/simulator';
import { openWorkspace, type Workspace } from '@ambionframework/workspace';
import { describe, expect, onTestFailed, onTestFinished } from 'vitest';
import { people, team } from '../../src/domain/definitions.ts';
import { piModel, THINKING } from '../../src/domain/families.ts';
import { scenarios, seats, seedWorkspace } from '../../src/domain/scenarios.ts';
import { labRepositories } from '../../src/host/repositories.ts';

const MODEL = piModel();
export const JUDGE_MODEL = process.env.JUDGE_MODEL || MODEL;
/** The judge thinks at the level of the seats. */
export const JUDGE_THINKING = THINKING;

const keyOf = (model: string) =>
	`${(model.split('/')[0] ?? '').toUpperCase().replace(/-/g, '_')}_API_KEY`;

/** `describe` when the keys of the model and the judge are set; a skipped block when either is not. */
export const live: ReturnType<typeof describe.skipIf> = describe.skipIf(
	!process.env[keyOf(MODEL)] || !process.env[keyOf(JUDGE_MODEL)],
);

/** Real milliseconds for one exchange and its summary. Three specialists hear every message. */
export const EXCHANGE_MS = 150_000;

/** The one person of Workbench. */
export const person = (() => {
	const [first] = people;
	if (!first) throw new Error('Workbench has no person.');
	return first;
})();

/** The room of the project, as the host seeds it. */
export const sweep = (() => {
	const [first] = scenarios;
	if (!first) throw new Error('Workbench has no room.');
	return first;
})();

/** The tools of the workspace: files, processes, and the git server. */
export const WORKSPACE_TOOLS = [
	'read',
	'write',
	'edit',
	'bash',
	'ps',
	'status',
	'wait',
	'cancel',
	'repos',
	'fork',
] as const;

/**
 * A room with the team of Workbench over a seeded workspace, as the host
 * opens it: the library and `/shared` on disk, and the templates on the git
 * server. It stops, and its files go, when the test ends. The seats run on
 * the live model, or on `execution` for a test of this support.
 */
export async function openRoom(
	execution: Execution = piExecution(),
): Promise<{ room: Room; workspace: Workspace }> {
	const directory = await mkdtemp(join(tmpdir(), 'workbench-eval-'));
	await seedWorkspace(directory);
	const workspace = openWorkspace({
		name: 'workbench',
		backend: { bash: directoryBackend(directory), git: labRepositories(':memory:') },
	});
	const built = team(workspace);
	const room = await startRoom({
		name: `workbench-eval-${crypto.randomUUID()}`,
		goal: sweep.goal,
		assistant: built.assistant,
		agents: built.specialists,
		seats,
		runtime: createRuntime({ execution }),
	});
	onTestFinished(async () => {
		await room.stop().catch(() => undefined);
		await workspace.dispose().catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	});
	return { room, workspace };
}

/** A run that the checks and the judge can read: it ended cleanly, and each exchange has its summary. */
export function expectGradable(run: Run, ended: readonly Run['ended'][] = ['limit']): void {
	expect(ended, run.error).toContain(run.ended);
	for (const exchange of run.exchanges)
		expect(exchange.summary, JSON.stringify(exchange.discussion)).toBeDefined();
}

/** What one participant said in one exchange, in record order. */
export const saidBy = (exchange: RunExchange | undefined, name: string): SpokenMessage[] =>
	(exchange?.discussion ?? []).filter(
		(message): message is SpokenMessage => isSpoken(message) && message.from === name,
	);

/** The names of the tools that one seat started in the run, in order. */
export const toolsOf = (run: Run, agent: string): string[] =>
	run.events.flatMap((event) =>
		event.type === 'tool_execution_start' && event.agent === agent ? [event.toolName] : [],
	);

/** What a case keeps for a person to read when it fails. */
export interface Evidence {
	run?: Run;
	verdict?: Verdict;
}

/**
 * The evidence of the running case. When the case ends, one line on stdout
 * gives what the room and the judge spent. It goes to stdout directly:
 * vitest keeps what a passing test logs through `console`.
 *
 * When the case fails, the evidence goes to `test/live/runs/<model>/<name>.json`,
 * which git ignores, and the path goes to stdout. Read the file before a
 * check or a criterion changes. Do not run the case again to chase a flake.
 */
export function track(name: string): Evidence {
	const evidence: Evidence = {};
	onTestFinished(() => {
		const cost = (usage: { cost?: number } | undefined) => (usage?.cost ?? 0).toFixed(4);
		const { run, verdict } = evidence;
		process.stdout.write(
			`workbench eval · ${MODEL} · ${name}: room $${cost(run?.usage.room)}, judge $${cost(verdict?.usage)}\n`,
		);
	});
	onTestFailed(() => {
		const dir = new URL(`./runs/${MODEL.replace(/[^a-z0-9.-]+/gi, '-')}/`, import.meta.url);
		mkdirSync(dir, { recursive: true });
		const path = new URL(`${name.replace(/[^a-z0-9-]+/gi, '-')}.json`, dir);
		const replacer = (_key: string, value: unknown) =>
			value instanceof Error ? value.message : value;
		writeFileSync(path, JSON.stringify(evidence, replacer, 2));
		process.stdout.write(`workbench eval · ${name}: evidence in ${path.pathname}\n`);
	});
	return evidence;
}
