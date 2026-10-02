/**
 * What the evals of Workbench share: the models, a room on the team of the
 * lab, the reads of a run, the evidence a failed case keeps, and the cost
 * line. The evals run on `@ambionframework/simulator`: a scripted person
 * asks, checks in code decide the facts, and a judge grades the meaning.
 *
 * `WORKBENCH_MODEL` names the model of every seat, as `pnpm start` reads it.
 * `JUDGE_MODEL` names the separate Pi judge, `openai/gpt-6-luna` by default.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createRuntime,
	isSaid,
	type Room,
	type SaidMessage,
	startRoom,
} from '@ambionframework/ambion';
import type { Execution } from '@ambionframework/ambion/hosting';
import { codexExecution } from '@ambionframework/codex';
import { directoryBackend } from '@ambionframework/just-bash';
import type { Simulation, SimulationExchange, Verdict } from '@ambionframework/simulator';
import { openWorkspace, type Workspace } from '@ambionframework/workspace';
import { describe, expect, onTestFailed, onTestFinished } from 'vitest';
import { people, team } from '../../src/domain/definitions.ts';
import { codexModel, hasLogin, REASONING_EFFORT } from '../../src/domain/families.ts';
import { sharedRegistrations } from '../../src/domain/notes.ts';
import { labRepositories } from '../../src/host/repositories.ts';
import { seedWorkspace } from '../../src/host/seed.ts';
import { ledFiles, ledNotes, ledProject, ledSweepRoom } from './led-sweep.ts';

export const JUDGE_MODEL = process.env.JUDGE_MODEL || 'openai/gpt-6-luna';
/** The judge thinks at the level of the seats. */
export const JUDGE_THINKING = REASONING_EFFORT;

const keyOf = (model: string) =>
	`${(model.split('/')[0] ?? '').toUpperCase().replace(/-/g, '_')}_API_KEY`;

/** `describe` when Codex has a login and the judge has a key; otherwise skip. */
export const live: ReturnType<typeof describe.skipIf> = describe.skipIf(
	!hasLogin() || !process.env[keyOf(JUDGE_MODEL)],
);

/** Real milliseconds for one exchange and its summary. Three specialists hear every message. */
export const EXCHANGE_MS = 150_000;

/** The one person of Workbench. */
export const person = (() => {
	const [first] = people;
	if (!first) throw new Error('Workbench has no person.');
	return first;
})();

/** The room of the evals: the LED sweep, which the evals keep as their project. */
export const sweep = ledSweepRoom;

/** The tools of the workspace: files, processes, snapshots, and the git server. */
export const WORKSPACE_TOOLS = [
	'read',
	'write',
	'edit',
	'bash',
	'ps',
	'status',
	'wait',
	'cancel',
	'snapshot',
	'restore',
	'repos',
	'clone',
	'fork',
] as const;

/**
 * A room with the team of Workbench over a seeded workspace, as the host
 * opens it but with the LED sweep as its project: the library and `/shared`
 * on disk, and the templates on the git server. It stops, and its files go,
 * when the test ends. The seats run on the live model, or on `execution` for
 * a test of this support.
 */
export async function openRoom(
	execution: Execution = codexExecution(),
): Promise<{ room: Room; workspace: Workspace }> {
	const directory = await mkdtemp(join(tmpdir(), 'workbench-eval-'));
	const workspace = openWorkspace({
		name: 'workbench',
		backend: {
			bash: directoryBackend(directory, {
				git: labRepositories(':memory:', sharedRegistrations(ledNotes)),
			}),
		},
	});
	await seedWorkspace(workspace, ledFiles);
	const built = await team(workspace, ledProject);
	const room = await startRoom({
		name: `workbench-eval-${crypto.randomUUID()}`,
		goal: sweep.goal,
		assistant: built.assistant,
		agents: built.specialists,
		seats: sweep.seats,
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
export function expectGradable(
	run: Simulation,
	ended: readonly Simulation['ended'][] = ['limit'],
): void {
	expect(ended, run.error).toContain(run.ended);
	for (const exchange of run.exchanges)
		expect(exchange.summary, JSON.stringify(exchange.discussion)).toBeDefined();
}

/** What one participant said in one exchange, in record order. */
export const saidBy = (exchange: SimulationExchange | undefined, name: string): SaidMessage[] =>
	(exchange?.discussion ?? []).filter(
		(message): message is SaidMessage => isSaid(message) && message.from === name,
	);

/** The names of the tools that one seat started in the run, in order. */
export const toolsOf = (run: Simulation, agent: string): string[] =>
	run.events.flatMap((event) =>
		event.type === 'tool_call' && event.seat === agent ? [event.name] : [],
	);

/** What a case keeps for a person to read when it fails. */
export interface Evidence {
	run?: Simulation;
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
			`workbench eval · ${codexModel()} · ${name}: room $${cost(run?.usage.room)}, judge $${cost(verdict?.usage)}\n`,
		);
	});
	onTestFailed(() => {
		const dir = new URL(`./runs/${codexModel().replace(/[^a-z0-9.-]+/gi, '-')}/`, import.meta.url);
		mkdirSync(dir, { recursive: true });
		const path = new URL(`${name.replace(/[^a-z0-9-]+/gi, '-')}.json`, dir);
		const replacer = (_key: string, value: unknown) =>
			value instanceof Error ? value.message : value;
		writeFileSync(path, JSON.stringify(evidence, replacer, 2));
		process.stdout.write(`workbench eval · ${name}: evidence in ${path.pathname}\n`);
	});
	return evidence;
}
