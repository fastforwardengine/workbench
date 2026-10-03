#!/usr/bin/env -S node --experimental-ffi --disable-warning=ExperimentalWarning
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { fileCredentials, loginPi } from '@ambionframework/pi';
import { CHATGPT_PROVIDER, missingLogin, piCredentialsPath } from './domain/model.ts';
import { runEngine } from './terminal/app/tui.ts';

const USAGE = 'Usage: workbench [directory]\n       workbench login';

/**
 * Say that the seats cannot run for want of a login. Workbench still
 * starts. The terminal shows the same fact beside each seat name.
 */
function reportMissingLogin(): void {
	const reason = missingLogin();
	if (reason) console.error(`No seat can run: ${reason}`);
}

/**
 * Sign in with a ChatGPT Plus or Pro subscription. Pi offers a browser login
 * or a device-code login for a host with no browser. The credential goes to
 * the file that `piCredentialsPath` names, and the seats then default to the
 * ChatGPT model.
 */
async function login(): Promise<void> {
	const path = piCredentialsPath();
	await loginPi(CHATGPT_PROVIDER, fileCredentials(path));
	console.log(`Signed in. The credential is in ${path}.`);
	console.log('The seats now run on the ChatGPT model, unless WORKBENCH_MODEL names another.');
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
	if (positionals[0] === 'login' && positionals.length === 1) {
		await login();
		process.exit(0);
	}
	if (positionals.length > 1) throw new Error(USAGE);
	reportMissingLogin();
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
