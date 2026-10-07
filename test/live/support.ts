/**
 * What the evals of Workbench share: the model, a room on the team of the
 * lab, the reads of a run, the evidence a failed case keeps, and the cost
 * line. The evals run on `@ambionframework/simulator`: a scripted person
 * asks, and checks in code decide the facts.
 *
 * The evals default to the `luna` preset. `WORKBENCH_MODEL` names another
 * model of every seat, as `pnpm start` reads it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, isSaid, type Room, type SaidMessage } from '@ambionframework/ambion';
import type { Execution } from '@ambionframework/ambion/hosting';
import { memoryCanvas, openCanvas } from '@ambionframework/canvas';
import { memoryJournals } from '@ambionframework/journal';
import { directoryBackend } from '@ambionframework/just-bash';
import { fileCredentials, piExecution } from '@ambionframework/pi';
import type { Simulation, SimulationExchange } from '@ambionframework/simulator';
import { openWorkspace, type Workspace } from '@ambionframework/workspace';
import { describe, expect, onTestFailed, onTestFinished } from 'vitest';
import { people, team } from '../../src/domain/definitions.ts';
import { modelHasLogin, piCredentialsPath, piModel } from '../../src/domain/model.ts';
import { buildRoom, seats } from '../../src/domain/room.ts';
import { labRepositories } from '../../src/host/repositories.ts';
import { seedWorkspace } from '../../src/host/seed.ts';
import { FRAME_KIND } from '../../src/host/viewfinder.ts';

const MODEL = piModel();

/** The sign-ins of `workbench login`, which the seats use before a key variable. */
const credentials = fileCredentials(piCredentialsPath());

/** `describe` when the model has a login; a skipped block when it has none. */
export const live: ReturnType<typeof describe.skipIf> = describe.skipIf(!modelHasLogin(MODEL));

/** Real milliseconds for one exchange. */
export const EXCHANGE_MS = 150_000;

/** The one person of Workbench. */
export const person = (() => {
	const [first] = people;
	if (!first) throw new Error('Workbench has no person.');
	return first;
})();

/**
 * A room with the team of Workbench over a seeded workspace, as the host
 * opens the build room: the library and `/shared` on disk, and the templates
 * and the notes on the git server. It stops, and its files go,
 * when the test ends. The seats run on the live model, or on `execution` for
 * a test of this support.
 */
export async function openRoom(
	execution: Execution = piExecution({ credentials }),
): Promise<{ room: Room; workspace: Workspace }> {
	const directory = await mkdtemp(join(tmpdir(), 'workbench-eval-'));
	const workspace = openWorkspace({
		name: 'workbench',
		backend: {
			bash: directoryBackend(directory, {
				git: labRepositories(':memory:'),
			}),
		},
	});
	await seedWorkspace(workspace);
	const runtime = createRuntime({ execution, storage: memoryJournals() });
	// The canvas exists first, so the seats hold its bundles, as in the host.
	const canvas = openCanvas({
		name: 'workbench-eval',
		runtime,
		store: memoryCanvas(),
		workspace,
		widgets: { kinds: [FRAME_KIND] },
	});
	const built = await team(workspace, undefined, {
		widgets: canvas.widgetTools(),
		canvas: canvas.tools(),
	});
	await canvas.resume({ agents: built.specialists });
	const room = await canvas.open({
		name: `eval-${crypto.randomUUID().slice(0, 8)}`,
		goal: buildRoom.goal,
		agents: built.specialists.map((agent) => agent.name),
		seats,
		seating: false,
	});
	onTestFinished(async () => {
		await canvas.close().catch(() => undefined);
		await workspace.dispose().catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	});
	return { room, workspace };
}

/** A run that the checks can read: it ended cleanly, and a seat spoke in each exchange. */
export function expectGradable(
	run: Simulation,
	ended: readonly Simulation['ended'][] = ['limit'],
): void {
	expect(ended, run.error).toContain(run.ended);
	for (const exchange of run.exchanges)
		expect(
			exchange.discussion.some((message) => isSaid(message) && message.from !== run.person.name),
			JSON.stringify(exchange.discussion),
		).toBe(true);
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
}

/**
 * The evidence of the running case. When the case ends, one line on stdout
 * gives what the room spent. It goes to stdout directly:
 * vitest keeps what a passing test logs through `console`.
 *
 * When the case fails, the evidence goes to `test/live/runs/<model>/<name>.json`,
 * which git ignores, and the path goes to stdout. Read the file before a
 * check changes. Do not run the case again to chase a flake.
 */
export function track(name: string): Evidence {
	const evidence: Evidence = {};
	onTestFinished(() => {
		const cost = (usage: { cost?: number } | undefined) => (usage?.cost ?? 0).toFixed(4);
		process.stdout.write(
			`workbench eval · ${MODEL} · ${name}: room $${cost(evidence.run?.usage.room)}\n`,
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
