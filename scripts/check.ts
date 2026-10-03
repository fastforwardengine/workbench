/**
 * The project check: format, types, lint, unused code, the scripted tests, and the Python.
 *
 *   node scripts/check.ts      # or `pnpm check`
 *
 * The script starts every stage at once and buffers the output of each one.
 * A run that passes prints one line. A run that fails prints the output of
 * each failed stage under a header, then a summary line, and exits with 1.
 * The first failure does not hide the others.
 *
 * Node 22.18 and newer can run this file. The Node floor check then reports an old Node.
 *
 * The `python` stage needs `ruff` and `python3` on PATH. It reads the Python floor from
 * `target-version` in `pyproject.toml`.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * One command. It runs in `cwd`, a path from the repository root. A binary of `node_modules/.bin`
 * is the default. A step with `onPath` finds its binary on PATH. A step with `timeout` stops
 * after that many milliseconds.
 */
export type Step = {
	bin: string;
	args: string[];
	cwd?: string;
	onPath?: boolean;
	timeout?: number;
	fix?: string;
};

/**
 * One check: its steps run at once. A stage with `before` runs that function first. A string
 * that the function returns fails the stage, and no step runs.
 */
export type Stage = {
	name: string;
	steps: Step[];
	before?: () => Promise<string | undefined>;
};

/** What one stage did. A `code` of undefined means that the process did not exit with a code. */
export type StageResult = {
	stage: Stage;
	ms: number;
	code: number | undefined;
	output: string;
};

/** The longest run of a Python suite. A suite that hangs fails the stage. */
const PYTHON_TIMEOUT_MS = 120_000;

/** A Python suite: `python3 -B -m unittest` in the directory of the suite. */
const suite = (cwd: string): Step => ({
	bin: 'python3',
	args: ['-B', '-m', 'unittest'],
	cwd,
	onPath: true,
	timeout: PYTHON_TIMEOUT_MS,
});

/** The directories of the Python suites. A test in `test/check.test.ts` finds a suite that is not here. */
export const suiteDirectories = ['templates/psu', 'templates/usb-camera'];

export const stages: Stage[] = [
	{
		name: 'format',
		steps: [{ bin: 'prettier', args: ['.', '--cache', '--check'], fix: 'pnpm format' }],
	},
	{ name: 'types', steps: [{ bin: 'tsc', args: ['--noEmit'] }] },
	{
		name: 'lint',
		steps: [{ bin: 'biome', args: ['lint', '.', '--error-on-warnings'], fix: 'pnpm format' }],
	},
	{ name: 'knip', steps: [{ bin: 'knip', args: [] }] },
	{ name: 'test', steps: [{ bin: 'vitest', args: ['run'] }] },
	{
		name: 'python',
		before: pythonProblem,
		steps: [
			{ bin: 'ruff', args: ['check', '.'], onPath: true, fix: 'ruff check --fix .' },
			...suiteDirectories.map(suite),
		],
	},
];

/** The minimum of a range such as `>=26.4.0`. */
export function floorOf(range: string): string {
	const match = /^>=(\d+\.\d+\.\d+)$/.exec(range);
	if (match?.[1] === undefined) throw new Error(`The range ${range} is not of the form >=X.Y.Z.`);
	return match[1];
}

/** True when version `found` is at least version `floor`. Both have the form `X.Y.Z`. */
export function atLeast(found: string, floor: string): boolean {
	const [a, b] = [found, floor].map((version) => version.split('.').map(Number));
	for (let i = 0; i < 3; i++) {
		const [x, y] = [a?.[i] ?? 0, b?.[i] ?? 0];
		if (x !== y) return x > y;
	}
	return true;
}

/** The one-line message for a Node below the floor, or undefined when Node is new enough. */
export function floorMessage(found: string, floor: string): string | undefined {
	return atLeast(found, floor)
		? undefined
		: `check: Node ${floor} or newer is required; found ${found}. Run nvm use.`;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const failed = (result: StageResult): boolean => result.code !== 0;

/** The command that reproduces one step, as a person types it from the repository root. */
export function commandOf({ bin, args, cwd, onPath }: Step): string {
	const command = [onPath ? '' : 'pnpm exec', bin, ...args].filter(Boolean).join(' ');
	return cwd === undefined ? command : `cd ${cwd} && ${command}`;
}

/** The header of a failed stage. A stage of one step names the command and the fix. */
function headerOf({ stage, ms, code }: StageResult): string {
	const how = code === undefined ? 'stopped' : `failed with code ${code}`;
	const [step] = stage.steps;
	if (stage.steps.length !== 1 || step === undefined)
		return `==> ${stage.name} ${how} in ${seconds(ms)}.`;
	const fix = step.fix ? ` Fix: ${step.fix}` : '';
	return `==> ${stage.name} ${how} in ${seconds(ms)}. Run: ${commandOf(step)}.${fix}`;
}

/** The text of a run, and whether the run passed. The output of a passed stage stays out. */
export function report(results: StageResult[], totalMs: number): { text: string; ok: boolean } {
	const bad = results.filter(failed);
	if (bad.length === 0)
		return { text: `check: ${results.length} stages passed in ${seconds(totalMs)}\n`, ok: true };
	const blocks = bad.map((result) => `${headerOf(result)}\n${result.output.trimEnd()}\n`);
	const names = bad.map(({ stage }) => stage.name).join(', ');
	const summary = `check: ${bad.length} of ${results.length} stages failed (${names}) in ${seconds(totalMs)}\n`;
	return { text: `${blocks.join('\n')}\n${summary}`, ok: false };
}

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);

/** What one command did: the exit code, and its stdout and stderr together. */
type StepResult = { code: number | undefined; output: string };

/** Run one command and buffer its output. A spawn error counts as a stopped command. */
function spawnStep({ bin, args, cwd, onPath, timeout }: Step): Promise<StepResult> {
	return new Promise((resolve) => {
		let output = '';
		const file = onPath ? bin : fileURLToPath(new URL(`node_modules/.bin/${bin}`, root));
		const child = spawn(file, args, {
			cwd: cwd === undefined ? rootPath : fileURLToPath(new URL(`${cwd}/`, root)),
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout,
		});
		child.stdout.on('data', (chunk: Buffer) => (output += chunk));
		child.stderr.on('data', (chunk: Buffer) => (output += chunk));
		child.on('error', (error: Error) => {
			const hint = onPath ? `Install ${bin}.` : 'Run pnpm install, then run the check again.';
			resolve({ code: undefined, output: `${output}${error.message}\n${hint}\n` });
		});
		child.on('close', (code) => resolve({ code: code ?? undefined, output }));
	});
}

/** The output of a failed step of a stage with several steps: its command, its fix, and its text. */
function blockOf(step: Step, { output }: StepResult): string {
	const fix = step.fix ? ` Fix: \`${step.fix}\`` : '';
	return `--> Run: \`${commandOf(step)}\`.${fix}\n${output.trimEnd()}\n`;
}

/** The result of a stage. The steps run at once. The output of a stage of several steps names each failed step. */
async function runStage(stage: Stage): Promise<StageResult> {
	const start = Date.now();
	const finish = (code: number | undefined, output: string): StageResult => ({
		stage,
		ms: Date.now() - start,
		code,
		output,
	});
	const problem = await stage.before?.();
	if (problem !== undefined) return finish(1, `${problem}\n`);
	const results = await Promise.all(stage.steps.map(spawnStep));
	if (stage.steps.length === 1) return finish(results[0]?.code, results[0]?.output ?? '');
	const bad = stage.steps.flatMap((step, i) => {
		const result = results[i];
		return result === undefined || result.code === 0 ? [] : [blockOf(step, result)];
	});
	const code = results.every(({ code }) => code === 0) ? 0 : 1;
	return finish(code, bad.join('\n'));
}

/** Run one command and return its output, or undefined when the binary does not start. */
function capture(bin: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		let output = '';
		const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		child.stdout.on('data', (chunk: Buffer) => (output += chunk));
		child.stderr.on('data', (chunk: Buffer) => (output += chunk));
		child.on('error', () => resolve(undefined));
		child.on('close', () => resolve(output));
	});
}

/** The Python floor as `X.Y`: the `target-version` of `pyproject.toml`, such as `py311`. */
export function pythonFloor(pyproject: string): string {
	const match = /^target-version\s*=\s*"py(\d)(\d+)"/m.exec(pyproject);
	if (match?.[1] === undefined || match[2] === undefined)
		throw new Error('pyproject.toml has no target-version of the form "pyXY".');
	return `${match[1]}.${match[2]}`;
}

/** The one-line message for a Python below the floor, or undefined when Python is new enough. */
export function pythonMessage(found: string, floor: string): string | undefined {
	return atLeast(found, floor)
		? undefined
		: `Python ${floor} or newer is required; found ${found}. Run brew install python@${floor} and put it first on PATH.`;
}

/** The problem that stops the python stage before it starts, or undefined when the stage can run. */
async function pythonProblem(): Promise<string | undefined> {
	const floor = pythonFloor(readFileSync(new URL('pyproject.toml', root), 'utf8'));
	const version = await capture('python3', ['--version']);
	if (version === undefined)
		return `python3 is not on PATH. Python ${floor} or newer is required. Run brew install python@${floor}.`;
	const found = /(\d+\.\d+(?:\.\d+)?)/.exec(version)?.[1] ?? version.trim();
	const message = pythonMessage(found, floor);
	if (message !== undefined) return message;
	if ((await capture('ruff', ['--version'])) === undefined)
		return 'ruff is not on PATH. Run pipx install ruff or brew install ruff.';
	return undefined;
}

async function main(): Promise<void> {
	const { engines } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
		engines: { node: string };
	};
	const message = floorMessage(process.versions.node, floorOf(engines.node));
	if (message !== undefined) {
		console.log(message);
		process.exitCode = 1;
		return;
	}
	const start = Date.now();
	const results = await Promise.all(stages.map(runStage));
	const { text, ok } = report(results, Date.now() - start);
	process.stdout.write(text);
	if (!ok) process.exitCode = 1;
}

if (import.meta.main) await main();
