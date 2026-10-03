/**
 * The project check: format, types, lint, unused code, and the scripted tests.
 *
 *   node scripts/check.ts      # or `pnpm check`
 *
 * The script starts every stage at once and buffers the output of each one.
 * A run that passes prints one line. A run that fails prints the output of
 * each failed stage under a header, then a summary line, and exits with 1.
 * The first failure does not hide the others.
 *
 * Node 22.18 and newer can run this file. The Node floor check then reports an old Node.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** One check: a binary of `node_modules/.bin`, its arguments, and the command that fixes it. */
export type Stage = {
	name: string;
	bin: string;
	args: string[];
	fix?: string;
};

/** What one stage did. A `code` of undefined means that the process did not exit with a code. */
export type StageResult = {
	stage: Stage;
	ms: number;
	code: number | undefined;
	output: string;
};

export const stages: Stage[] = [
	{ name: 'format', bin: 'prettier', args: ['.', '--cache', '--check'], fix: 'pnpm format' },
	{ name: 'types', bin: 'tsc', args: ['--noEmit'] },
	{ name: 'lint', bin: 'biome', args: ['lint', '.', '--error-on-warnings'], fix: 'pnpm format' },
	{ name: 'knip', bin: 'knip', args: [] },
	{ name: 'test', bin: 'vitest', args: ['run'] },
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
const commandOf = ({ bin, args }: Stage): string => ['pnpm exec', bin, ...args].join(' ');
const failed = (result: StageResult): boolean => result.code !== 0;

/** The text of a run, and whether the run passed. The output of a passed stage stays out. */
export function report(results: StageResult[], totalMs: number): { text: string; ok: boolean } {
	const bad = results.filter(failed);
	if (bad.length === 0)
		return { text: `check: ${results.length} stages passed in ${seconds(totalMs)}\n`, ok: true };
	const blocks = bad.map(({ stage, ms, code, output }) => {
		const how = code === undefined ? 'stopped' : `failed with code ${code}`;
		const fix = stage.fix ? ` Fix: ${stage.fix}` : '';
		const head = `==> ${stage.name} ${how} in ${seconds(ms)}. Run: ${commandOf(stage)}.${fix}`;
		return `${head}\n${output.trimEnd()}\n`;
	});
	const names = bad.map(({ stage }) => stage.name).join(', ');
	const summary = `check: ${bad.length} of ${results.length} stages failed (${names}) in ${seconds(totalMs)}\n`;
	return { text: `${blocks.join('\n')}\n${summary}`, ok: false };
}

const root = new URL('../', import.meta.url);

/** Run one stage and buffer its stdout and stderr together. A spawn error counts as a failed stage. */
function run(stage: Stage): Promise<StageResult> {
	const start = Date.now();
	return new Promise((resolve) => {
		let output = '';
		const finish = (code: number | undefined): void =>
			resolve({ stage, ms: Date.now() - start, code, output });
		const bin = fileURLToPath(new URL(`node_modules/.bin/${stage.bin}`, root));
		const child = spawn(bin, stage.args, {
			cwd: fileURLToPath(root),
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout.on('data', (chunk: Buffer) => (output += chunk));
		child.stderr.on('data', (chunk: Buffer) => (output += chunk));
		child.on('error', (error: Error) => {
			output += `${error.message}\nRun pnpm install, then run the check again.\n`;
			finish(undefined);
		});
		child.on('close', (code) => finish(code ?? undefined));
	});
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
	const results = await Promise.all(stages.map(run));
	const { text, ok } = report(results, Date.now() - start);
	process.stdout.write(text);
	if (!ok) process.exitCode = 1;
}

if (import.meta.main) await main();
