#!/usr/bin/env -S node --experimental-ffi
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { describeUnavailable } from './domain/families.ts';
import { runEngine } from './terminal/tui.ts';

const USAGE = 'Usage: workbench [directory]';

/**
 * Say which seats cannot run for want of a key. Workbench still
 * starts and runs the other seats. The terminal shows the same fact beside
 * each seat name.
 */
function reportMissingKeys(): void {
	for (const line of describeUnavailable()) {
		console.error(`${line} Set it in the environment or in .env.`);
	}
}

/**
 * Read `.env` in the working directory, when it exists. A variable that the
 * environment already sets keeps its value.
 */
function loadEnvironment(): void {
	if (existsSync('.env')) process.loadEnvFile('.env');
}

try {
	loadEnvironment();
	const { positionals } = parseArgs({ allowPositionals: true });
	if (positionals.length > 1) throw new Error(USAGE);
	reportMissingKeys();
	await runEngine({
		directory: positionals[0] ?? '.data',
		// The one person of Workbench has the name of this account
		// (src/domain/definitions.ts), so the terminal opens as that person.
		person: userInfo().username,
	});
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
