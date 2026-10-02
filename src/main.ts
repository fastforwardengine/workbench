#!/usr/bin/env -S node --experimental-ffi
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { fileCredentials, loginPi } from '@ambionframework/pi';
import { describeUnavailable, piCredentialsPath } from './domain/families.ts';
import { runEngine } from './terminal/app/tui.ts';

const USAGE = 'Usage: workbench [directory]\n       workbench login';

/**
 * Say which seats cannot run without a login. Workbench still
 * starts and runs the other seats. The terminal shows the same fact beside
 * each seat name.
 */
function reportMissingKeys(): void {
	for (const line of describeUnavailable()) {
		console.error(`${line}`);
	}
}

/**
 * Read `.env` in the working directory, when it exists. A variable that the
 * environment already sets keeps its value.
 */
function loadEnvironment(): void {
	if (existsSync('.env')) process.loadEnvFile('.env');
}

/**
 * Sign in to Pi with ChatGPT and store the credential. The assistant uses it.
 * The specialists use `codex login`.
 */
async function login(): Promise<void> {
	const path = piCredentialsPath();
	await loginPi('openai', fileCredentials(path));
	console.log(`Signed in. The credential is in ${path}.`);
}

try {
	loadEnvironment();
	const { positionals } = parseArgs({ allowPositionals: true });
	if (positionals.length > 1) throw new Error(USAGE);
	if (positionals[0] === 'login') {
		await login();
		process.exit(0);
	}
	reportMissingKeys();
	await runEngine({
		directory: positionals[0] ?? '.data',
		// The one person of Workbench has the name of this account
		// (src/domain/definitions.ts), so the terminal opens as that person.
		person: userInfo().username,
		// The bash and git backends run on the workstation that this file names.
		workstation: process.env.WORKBENCH_WORKSTATION || undefined,
	});
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
