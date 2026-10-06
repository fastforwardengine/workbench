import { createRuntime, startRoom } from '@ambionframework/ambion';
import { byAgent, callTool, quiet, say, scripted, settled } from '@ambionframework/ambion/testing';
import { memoryJournals } from '@ambionframework/journal';
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { people, team } from '../src/domain/definitions.ts';
import { labRepositories } from '../src/host/repositories.ts';

/** The fields that the three macros return. Each macro returns some of them. */
type Json = {
	head: string;
	log: { commit: string; subject: string; files: string[] }[];
	disputes: string[];
	commit: string;
	repository: string;
	committed: boolean;
	note: string;
	state: string;
	exitCode: number | null;
	safe: boolean;
	finally: string;
	finallyExitCode: number | null;
};
type Call = { tool: string; input: Record<string, unknown> };
type Step = { results: readonly { text?: string }[] };

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

/**
 * Run the calls of one seat in order. Each entry is a call, or a function of the texts that the
 * earlier calls returned. The result is the text of every call.
 */
async function runCalls(
	seat: 'researcher' | 'engineer',
	calls: (Call | ((texts: string[]) => Call))[],
): Promise<string[]> {
	const workspace = openWorkspace({
		name: 'workbench',
		backend: { bash: memoryBackend({ git: labRepositories(':memory:') }) },
	});
	cleanups.push(() => workspace.dispose());
	const built = await team(workspace);
	const person = people[0];
	if (!person) throw new Error('No person.');
	const texts: string[] = [];
	const next = (step: Step, call: number) => {
		if (call > 1) texts.push(step.results.at(-1)?.text ?? '');
		const entry = calls[call - 1];
		if (!entry) return quiet();
		const { tool, input } = typeof entry === 'function' ? entry(texts) : entry;
		return callTool(tool, input);
	};
	const room = await startRoom({
		name: 'macros',
		goal: 'Run macros.',
		agents: built.specialists,
		runtime: createRuntime({ storage: memoryJournals() }),
		execution: scripted(
			byAgent({
				[seat]: (step, _seat, call) => {
					if (call === calls.length + 1) {
						texts.push(step.results.at(-1)?.text ?? '');
						return say('Done.');
					}
					return next(step, call);
				},
			}),
		),
		seats: { [seat]: 'named' },
		seating: false,
	});
	cleanups.push(() => room.stop());
	await (await room.visit(person)).send({ text: 'Run.', to: seat });
	await settled(room);
	return texts;
}

const macro = (name: string, args: Record<string, unknown> = {}): Call => ({
	tool: 'compose',
	input: { macro: name, args },
});
const bash = (command: string, wait = 30): Call => ({ tool: 'bash', input: { command, wait } });

/** Commands that clone the notes to ~/other, write a file there, and push it to origin main. */
const OTHER_PUSH = (file: string, text: string, redirect = '>') =>
	`cd ~ && git clone "$(cd notes && git config remote.origin.url)" other && cd other && git config user.name other && git config user.email other@ambion.invalid && echo ${text} ${redirect} ${file} && git add -A && git commit -m 'notes: ${text}' && git push origin main`;

/** The JSON value that a macro returned. */
const returned = (text: string): Json => {
	const start = text.indexOf('{');
	return JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
};

describe('the macro keep-notes/pull', () => {
	it('clones the notes, sets the identity, and returns the head, the log, and the disputes', async () => {
		const [first, second, identity] = await runCalls('researcher', [
			macro('keep-notes/pull'),
			macro('keep-notes/pull'),
			bash('cd ~/notes && git config user.name && git config user.email'),
		]);
		const pulled = returned(first ?? '');
		expect(pulled.head).toMatch(/^[0-9a-f]{40}$/);
		expect(pulled.log.length).toBeGreaterThan(0);
		expect(pulled.log.length).toBeLessThanOrEqual(5);
		expect(pulled.log[0]?.commit).toBe(pulled.head);
		expect(pulled.log[0]?.files.length).toBeGreaterThan(0);
		expect(pulled.disputes).toEqual([]);
		expect(returned(second ?? '').head).toBe(pulled.head);
		expect(identity).toContain('researcher');
		expect(identity).toContain('researcher@ambion.invalid');
	}, 20_000);

	it('lists a dispute branch that holds commits that main lacks', async () => {
		const [, listed] = await runCalls('researcher', [
			macro('keep-notes/pull'),
			bash(
				"cd ~/notes && git switch -c dispute/ohm && echo claim > claim.md && git add -A && git commit -m 'Dispute a claim' && git push origin dispute/ohm && git switch main",
			),
			macro('keep-notes/pull'),
		]).then((texts) => [texts[0], texts[2]]);
		expect(returned(listed ?? '').disputes).toEqual(['origin/dispute/ohm']);
	}, 20_000);
});

describe('the macro keep-notes/push', () => {
	it('commits a change, and returns the hash that heads origin main', async () => {
		const texts = await runCalls('researcher', [
			macro('keep-notes/pull'),
			bash("cd ~/notes && echo 'It is 5 V' >> README.md"),
			macro('keep-notes/push', { message: "notes: add Tom's value" }),
			bash('cd ~/notes && git fetch && git rev-parse origin/main && git log -n 1 --oneline'),
		]);
		const pushed = returned(texts[2] ?? '');
		expect(pushed.repository).toBe('shared/notes');
		expect(pushed.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(texts[3]).toContain(pushed.commit);
		expect(texts[3]).toContain("notes: add Tom's value");
	}, 20_000);

	it('returns the head when nothing changed', async () => {
		const texts = await runCalls('researcher', [
			macro('keep-notes/pull'),
			macro('keep-notes/push', { message: 'notes: nothing' }),
		]);
		const pulled = returned(texts[0] ?? '');
		const pushed = returned(texts[1] ?? '');
		expect(pushed).toMatchObject({ commit: pulled.head, committed: false });
		expect(pushed.note).toMatch(/Nothing new to commit/);
	}, 20_000);

	it('pulls once and pushes again when another seat pushed first', async () => {
		const texts = await runCalls('researcher', [
			macro('keep-notes/pull'),
			bash(OTHER_PUSH('other.md', 'first')),
			bash('cd ~/notes && echo mine > mine.md'),
			macro('keep-notes/push', { message: 'notes: mine' }),
			bash('cd ~/notes && git fetch && git rev-parse origin/main && git log --name-only -n 2'),
		]);
		const pushed = returned(texts[3] ?? '');
		expect(texts[4]).toContain(pushed.commit);
		expect(texts[4]).toContain('mine.md');
		expect(texts[4]).toContain('other.md');
	}, 20_000);

	it('pushes the resolution that the seat made by hand, and returns the head of origin main', async () => {
		const texts = await runCalls('researcher', [
			macro('keep-notes/pull'),
			bash(OTHER_PUSH('README.md', 'theirs')),
			bash('cd ~/notes && echo mine > README.md'),
			macro('keep-notes/push', { message: 'notes: mine' }),
			bash(
				'cd ~/notes && git pull --rebase; echo resolved > README.md && git add README.md && git rebase --continue',
			),
			macro('keep-notes/push', { message: 'notes: unused' }),
			bash('cd ~/notes && git fetch && git rev-parse origin/main'),
		]);
		const pushed = returned(texts[5] ?? '');
		expect(pushed.committed).toBe(false);
		expect(texts[6]).toContain(pushed.commit);
	}, 20_000);

	it('refuses to run while a rebase is in progress, and keeps the work', async () => {
		const texts = await runCalls('researcher', [
			macro('keep-notes/pull'),
			bash(OTHER_PUSH('README.md', 'theirs')),
			bash('cd ~/notes && echo mine > README.md'),
			macro('keep-notes/push', { message: 'notes: mine' }),
			bash('cd ~/notes && git pull --rebase >/dev/null 2>&1; git status'),
			macro('keep-notes/push', { message: 'notes: again' }),
			bash('cd ~/notes && git status'),
		]);
		expect(texts[4]).toMatch(/rebase in progress|Unmerged|conflict/i);
		expect(texts[5]).toMatch(/git rebase --continue/);
		expect(texts[6]?.split('\n\n[Process')[0]).toBe(texts[4]?.split('\n\n[Process')[0]);
	}, 20_000);

	it('aborts the rebase and tells the seat to resolve a conflict by hand', async () => {
		const texts = await runCalls('researcher', [
			macro('keep-notes/pull'),
			bash(`${OTHER_PUSH('README.md', 'theirs', '>')}`),
			bash('cd ~/notes && echo mine > README.md'),
			macro('keep-notes/push', { message: 'notes: mine' }),
			bash('cd ~/notes && git status && cat README.md'),
		]);
		expect(texts[3]).toMatch(/Resolve it by hand, as step 5 of the skill says/);
		expect(texts[4]).not.toMatch(/rebase in progress/);
		expect(texts[4]).toContain('mine');
	}, 20_000);
});

/** Fork the psu template, start a process with `command`, and run the stop macro on it. */
async function stopped(command: string, wait: number): Promise<Json> {
	const texts = await runCalls('engineer', [
		{ tool: 'fork', input: { source: 'templates/psu', name: 'bench-psu', clone: '~/bench-psu' } },
		{ tool: 'bash', input: { command, name: 'actuator', wait, grace: 1 } },
		(seen) => {
			const handle = /bash-[0-9a-f]+/.exec(seen[1] ?? '')?.[0] ?? '';
			return macro('drive-the-power-supply/stop', { handle, clone: '~/bench-psu' });
		},
	]);
	return returned(texts[2] ?? '');
}

/*
 * The just-bash python3 runs a script from a temporary path, so finally.py cannot import the
 * modules of the clone. These tests check the decision and the call of finally.py. The
 * hardware run of finally.py has its own suite in templates/psu/tests.
 */
describe('the macro drive-the-power-supply/stop', () => {
	it('cancels a running process, and runs finally.py because the state is not exited', async () => {
		const result = await stopped('sleep 300', 0);
		expect(result).toMatchObject({ state: 'cancelled', exitCode: null, safe: false });
		expect(result.finally).toContain('ModuleNotFoundError');
		expect(result.finallyExitCode).toBe(1);
	}, 30_000);

	it('runs finally.py after an exit code other than 0', async () => {
		const result = await stopped('exit 3', 5);
		expect(result).toMatchObject({ state: 'exited', exitCode: 3, safe: false });
		expect(result.finally).toContain('ModuleNotFoundError');
	}, 30_000);

	it('runs finally.py when the handle is unknown', async () => {
		const texts = await runCalls('engineer', [
			{ tool: 'fork', input: { source: 'templates/psu', name: 'bench-psu', clone: '~/bench-psu' } },
			macro('drive-the-power-supply/stop', { handle: 'bash-000000000000', clone: '~/bench-psu' }),
		]);
		const result = returned(texts[1] ?? '');
		expect(result).toMatchObject({ state: 'unknown', exitCode: null, safe: false });
		expect(result.finallyExitCode).toBe(1);
	}, 30_000);

	it('reports safe and skips finally.py after an exit 0', async () => {
		const result = await stopped('true', 5);
		expect(result).toEqual({ state: 'exited', exitCode: 0, safe: true });
	}, 30_000);
});

describe('the guidance of a seat', () => {
	it.each([
		['researcher', ['keep-notes/pull', 'keep-notes/push']],
		['engineer', ['keep-notes/pull', 'keep-notes/push', 'drive-the-power-supply/stop']],
	])('lists the macros of %s', async (name, macros) => {
		const workspace = openWorkspace({
			name: 'workbench',
			backend: { bash: memoryBackend({ git: labRepositories(':memory:') }) },
		});
		cleanups.push(() => workspace.dispose());
		const seat = (await team(workspace)).specialists.find((candidate) => candidate.name === name);
		const guidance = seat?.executor.guidance ?? '';
		for (const macro of macros) expect(guidance, macro).toContain(macro);
		if (name === 'researcher') expect(guidance).not.toContain('drive-the-power-supply/stop');
	});
});
